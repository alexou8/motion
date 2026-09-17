/**
 * Anthropic adapter (ARCH D4 / VISION §12, §15, §17).
 */

import { redactSecrets } from '@/core/ai/redact';
import { explainProviderError } from '@/core/ai/explain';
import { ProviderError, type AIProvider, type GenerateRequest, type ProviderAvailability, type ProviderCapabilities } from '@/core/ai/types';
import { ANTHROPIC_RECOMMENDED } from '@/core/ai/models';
import type { SecretStore } from './secrets';
import {
  classifyHttpError,
  DEFAULT_GENERATE_TIMEOUT_MS,
  DEFAULT_HEALTH_TIMEOUT_MS,
  HttpProviderError,
  isOutcomeUnknownStatus,
  parseSSEStream,
  requestWithRetry,
  type FetchLike,
} from './http';

const MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const MODELS_URL = 'https://api.anthropic.com/v1/models';
const ANTHROPIC_VERSION = '2023-06-01';

export interface AnthropicProviderDeps {
  secrets: SecretStore;
  fetchImpl?: FetchLike;
}

function headers(key: string): Record<string, string> {
  return {
    'x-api-key': key,
    'anthropic-version': ANTHROPIC_VERSION,
    'anthropic-dangerous-direct-browser-access': 'true',
    'content-type': 'application/json',
  };
}

function buildBody(req: GenerateRequest, model: string, stream: boolean) {
  return {
    model,
    system: req.system,
    messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
    max_tokens: req.maxOutputTokens ?? 4096,
    stream,
  };
}

async function readErrorBody(response: Response): Promise<unknown> {
  try {
    return await response.clone().json();
  } catch {
    return undefined;
  }
}

export class AnthropicProvider implements AIProvider {
  readonly id = 'anthropic' as const;
  readonly displayName = 'Anthropic';
  private readonly secrets: SecretStore;
  private readonly fetchImpl: FetchLike;

  constructor(deps: AnthropicProviderDeps) {
    this.secrets = deps.secrets;
    // See the identical fix + comment in openai.ts: an unbound `fetch`
    // invoked as `options.fetchImpl(...)` throws "Illegal invocation" in a
    // real MV3 service worker.
    this.fetchImpl = deps.fetchImpl ?? fetch.bind(globalThis);
  }

  async capabilities(): Promise<ProviderCapabilities> {
    return {
      streaming: true,
      cancellation: true,
      backgroundExecution: true,
      cloud: true,
      requiresKey: true,
      structuredOutput: false,
    };
  }

  private async key(): Promise<string | null> {
    return this.secrets.get('anthropic');
  }

  async availability(): Promise<ProviderAvailability> {
    const key = await this.key();
    if (!key) return { status: 'not-configured', message: 'Anthropic isn’t set up yet. Add an API key in Motion’s settings to use it.' };
    return { status: 'available', message: 'Anthropic is ready.' };
  }

  async listModels(): Promise<string[]> {
    const key = await this.key();
    if (!key) throw new ProviderError('not-configured', 'Anthropic is not configured.');
    const response = await requestWithRetry({
      url: MODELS_URL,
      init: { method: 'GET', headers: headers(key) },
      fetchImpl: this.fetchImpl,
      timeoutMs: DEFAULT_HEALTH_TIMEOUT_MS,
      knownSecrets: [key],
    });
    if (!response.ok) throw await this.toProviderError(response, key, 'GET');
    const body = (await response.json()) as { data?: { id: string }[] };
    return (body.data ?? []).map((m) => m.id);
  }

  async healthCheck(): Promise<ProviderAvailability> {
    try {
      await this.listModels();
      return { status: 'available', message: 'Anthropic is ready.' };
    } catch (err) {
      return this.availabilityFromError(err);
    }
  }

  private availabilityFromError(err: unknown): ProviderAvailability {
    if (err instanceof ProviderError) {
      return { status: err.kind === 'cancelled' || err.kind === 'bad-response' || err.kind === 'outcome-unknown' ? 'network-error' : err.kind, message: err.message, retryAfterMs: err.retryAfterMs };
    }
    return { status: 'network-error', message: 'Motion couldn’t reach Anthropic. Check your connection and try again.' };
  }

  private async toProviderError(response: Response, key: string, method: 'GET' | 'POST'): Promise<ProviderError> {
    const body = await readErrorBody(response);
    const kind = classifyHttpError('anthropic', response.status, body);
    const errorKind = method === 'POST' && isOutcomeUnknownStatus(response.status) ? 'outcome-unknown' as const : kind;
    const message = redactSecrets(
      errorKind === 'outcome-unknown'
        ? explainProviderError('anthropic', errorKind)
        : errorKind === 'invalid-key'
        ? 'Your Anthropic API key is no longer valid. Reconnect.'
        : errorKind === 'insufficient-quota'
          ? 'Your Anthropic account is out of quota. Check your billing with Anthropic.'
          : errorKind === 'rate-limited'
            ? 'Anthropic is rate limited.'
            : errorKind === 'model-unavailable'
              ? 'The selected Anthropic model is no longer available.'
              : 'Motion couldn’t reach Anthropic. Check your connection and try again.',
      [key],
    );
    const retryAfterMs = errorKind === 'rate-limited' ? parseRetryAfterHeader(response) : undefined;
    return new ProviderError(errorKind, message, retryAfterMs);
  }

  async generate(req: GenerateRequest): Promise<string> {
    const key = await this.key();
    if (!key) throw new ProviderError('not-configured', 'Anthropic is not configured.');
    const model = req.model ?? ANTHROPIC_RECOMMENDED;
    const response = await requestWithRetry({
      url: MESSAGES_URL,
      init: { method: 'POST', headers: headers(key), body: JSON.stringify(buildBody(req, model, false)) },
      fetchImpl: this.fetchImpl,
      timeoutMs: DEFAULT_GENERATE_TIMEOUT_MS,
      signal: req.signal,
      knownSecrets: [key],
    }).catch((err) => {
      throw toRequestError(err, key);
    });
    if (!response.ok) throw await this.toProviderError(response, key, 'POST');
    let body: { content?: { type: string; text?: string }[] };
    try {
      body = (await response.json()) as { content?: { type: string; text?: string }[] };
    } catch (error) {
      throw toRequestError(error, key);
    }
    return (body.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
  }

  async *stream(req: GenerateRequest): AsyncIterable<string> {
    const key = await this.key();
    if (!key) throw new ProviderError('not-configured', 'Anthropic is not configured.');
    const model = req.model ?? ANTHROPIC_RECOMMENDED;
    const response = await requestWithRetry({
      url: MESSAGES_URL,
      init: { method: 'POST', headers: headers(key), body: JSON.stringify(buildBody(req, model, true)) },
      fetchImpl: this.fetchImpl,
      timeoutMs: DEFAULT_GENERATE_TIMEOUT_MS,
      signal: req.signal,
      knownSecrets: [key],
    }).catch((err) => {
      throw toRequestError(err, key);
    });
    if (!response.ok || !response.body) throw await this.toProviderError(response, key, 'POST');

    try {
      for await (const event of parseSSEStream(response.body, req.signal)) {
        if (event.event !== 'content_block_delta') continue;
        try {
          const parsed = JSON.parse(event.data) as { delta?: { type?: string; text?: string } };
          if (parsed.delta?.type === 'text_delta' && parsed.delta.text) yield parsed.delta.text;
        } catch {
          // Malformed frame — skip rather than corrupt output.
        }
      }
    } catch (error) {
      if (req.signal?.aborted) throw new ProviderError('cancelled', 'Request cancelled.');
      throw toRequestError(error, key);
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
    if (err.outcomeUnknown) return new ProviderError('outcome-unknown', explainProviderError('anthropic', 'outcome-unknown'));
    return new ProviderError('network-error', redactSecrets('Motion couldn’t reach Anthropic. Check your connection and try again.', [key]));
  }
  return new ProviderError('network-error', redactSecrets(String(err), [key]));
}
