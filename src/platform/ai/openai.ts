/**
 * OpenAI adapter (ARCH D4 / VISION §12, §15, §17).
 *
 * Responses API only, fixed endpoints, key read fresh from the injected
 * `SecretStore` on every call (never cached in module state where it could
 * outlive a `forget()`).
 */

import { redactSecrets } from '@/core/ai/redact';
import { ProviderError, type AIProvider, type GenerateRequest, type ProviderAvailability, type ProviderCapabilities } from '@/core/ai/types';
import { resolveOpenAIRecommended } from '@/core/ai/models';
import type { SecretStore } from './secrets';
import {
  classifyHttpError,
  DEFAULT_GENERATE_TIMEOUT_MS,
  DEFAULT_HEALTH_TIMEOUT_MS,
  HttpProviderError,
  parseSSEStream,
  requestWithRetry,
  type FetchLike,
} from './http';

const RESPONSES_URL = 'https://api.openai.com/v1/responses';
const MODELS_URL = 'https://api.openai.com/v1/models';

export interface OpenAIProviderDeps {
  secrets: SecretStore;
  fetchImpl?: FetchLike;
}

interface OpenAIInputMessage {
  role: 'user' | 'assistant';
  content: string;
}

function buildBody(req: GenerateRequest, model: string, stream: boolean) {
  const input: OpenAIInputMessage[] = req.messages.map((m) => ({ role: m.role, content: m.content }));
  return {
    model,
    instructions: req.system,
    input,
    ...(req.maxOutputTokens ? { max_output_tokens: req.maxOutputTokens } : {}),
    stream,
    ...(req.json ? { text: { format: { type: 'json_object' } } } : {}),
  };
}

async function readErrorBody(response: Response): Promise<unknown> {
  try {
    return await response.clone().json();
  } catch {
    return undefined;
  }
}

export class OpenAIProvider implements AIProvider {
  readonly id = 'openai' as const;
  readonly displayName = 'OpenAI';
  private readonly secrets: SecretStore;
  private readonly fetchImpl: FetchLike;

  constructor(deps: OpenAIProviderDeps) {
    this.secrets = deps.secrets;
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  async capabilities(): Promise<ProviderCapabilities> {
    return {
      streaming: true,
      cancellation: true,
      backgroundExecution: true,
      cloud: true,
      requiresKey: true,
      structuredOutput: true,
    };
  }

  private async key(): Promise<string | null> {
    return this.secrets.get('openai');
  }

  async availability(): Promise<ProviderAvailability> {
    const key = await this.key();
    if (!key) return { status: 'not-configured', message: 'OpenAI isn’t set up yet. Add an API key in Motion’s settings to use it.' };
    return { status: 'available', message: 'OpenAI is ready.' };
  }

  async listModels(): Promise<string[]> {
    const key = await this.key();
    if (!key) throw new ProviderError('not-configured', 'OpenAI is not configured.');
    const response = await requestWithRetry({
      url: MODELS_URL,
      init: { method: 'GET', headers: { Authorization: `Bearer ${key}` } },
      fetchImpl: this.fetchImpl,
      timeoutMs: DEFAULT_HEALTH_TIMEOUT_MS,
      knownSecrets: [key],
    });
    if (!response.ok) throw await this.toProviderError(response, key);
    const body = (await response.json()) as { data?: { id: string }[] };
    return (body.data ?? []).map((m) => m.id);
  }

  async healthCheck(): Promise<ProviderAvailability> {
    try {
      await this.listModels();
      return { status: 'available', message: 'OpenAI is ready.' };
    } catch (err) {
      return this.availabilityFromError(err);
    }
  }

  private availabilityFromError(err: unknown): ProviderAvailability {
    if (err instanceof ProviderError) {
      return { status: err.kind === 'cancelled' || err.kind === 'bad-response' ? 'network-error' : err.kind, message: err.message, retryAfterMs: err.retryAfterMs };
    }
    return { status: 'network-error', message: 'Motion couldn’t reach OpenAI. Check your connection and try again.' };
  }

  private async toProviderError(response: Response, key: string): Promise<ProviderError> {
    const body = await readErrorBody(response);
    const kind = classifyHttpError('openai', response.status, body);
    const message = redactSecrets(
      kind === 'invalid-key'
        ? 'Your OpenAI API key is no longer valid. Reconnect.'
        : kind === 'insufficient-quota'
          ? 'Your OpenAI account is out of quota. Check your billing with OpenAI.'
          : kind === 'rate-limited'
            ? 'OpenAI is rate limited.'
            : kind === 'model-unavailable'
              ? 'The selected OpenAI model is no longer available.'
              : 'Motion couldn’t reach OpenAI. Check your connection and try again.',
      [key],
    );
    const retryAfterMs = kind === 'rate-limited' ? parseRetryAfterHeader(response) : undefined;
    return new ProviderError(kind, message, retryAfterMs);
  }

  private async resolvedModel(req: GenerateRequest): Promise<string> {
    if (req.model) return req.model;
    let listed: string[] | undefined;
    try {
      listed = await this.listModels();
    } catch {
      listed = undefined;
    }
    return resolveOpenAIRecommended(listed);
  }

  async generate(req: GenerateRequest): Promise<string> {
    const key = await this.key();
    if (!key) throw new ProviderError('not-configured', 'OpenAI is not configured.');
    const model = await this.resolvedModel(req);
    const response = await requestWithRetry({
      url: RESPONSES_URL,
      init: {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify(buildBody(req, model, false)),
      },
      fetchImpl: this.fetchImpl,
      timeoutMs: DEFAULT_GENERATE_TIMEOUT_MS,
      signal: req.signal,
      knownSecrets: [key],
    }).catch((err) => {
      throw toRequestError(err, key);
    });
    if (!response.ok) throw await this.toProviderError(response, key);
    const body = (await response.json()) as {
      output_text?: string;
      output?: { content?: { text?: string }[] }[];
    };
    if (typeof body.output_text === 'string') return body.output_text;
    return (body.output ?? []).flatMap((o) => o.content ?? []).map((c) => c.text ?? '').join('');
  }

  async *stream(req: GenerateRequest): AsyncIterable<string> {
    const key = await this.key();
    if (!key) throw new ProviderError('not-configured', 'OpenAI is not configured.');
    const model = await this.resolvedModel(req);
    const response = await requestWithRetry({
      url: RESPONSES_URL,
      init: {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify(buildBody(req, model, true)),
      },
      fetchImpl: this.fetchImpl,
      timeoutMs: DEFAULT_GENERATE_TIMEOUT_MS,
      signal: req.signal,
      knownSecrets: [key],
    }).catch((err) => {
      throw toRequestError(err, key);
    });
    if (!response.ok || !response.body) throw await this.toProviderError(response, key);

    try {
      for await (const event of parseSSEStream(response.body, req.signal)) {
        if (event.event !== 'response.output_text.delta') continue;
        try {
          const parsed = JSON.parse(event.data) as { delta?: string };
          if (parsed.delta) yield parsed.delta;
        } catch {
          // Malformed frame — skip rather than corrupt output.
        }
      }
    } catch (error) {
      if (req.signal?.aborted) throw new ProviderError('cancelled', 'Request cancelled.');
      throw error;
    }
  }
}

function parseRetryAfterHeader(response: Response): number | undefined {
  const header = response.headers.get('retry-after');
  if (!header) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) ? seconds * 1000 : undefined;
}

function toRequestError(err: unknown, key: string): ProviderError {
  if (err instanceof HttpProviderError) {
    if (err.cancelled) return new ProviderError('cancelled', 'Request cancelled.');
    return new ProviderError('network-error', redactSecrets('Motion couldn’t reach OpenAI. Check your connection and try again.', [key]));
  }
  return new ProviderError('network-error', redactSecrets(String(err), [key]));
}
