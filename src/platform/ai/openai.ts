/**
 * OpenAI adapter (ARCH D4 / VISION §12, §15, §17).
 *
 * Responses API only, fixed endpoints, key read fresh from the injected
 * `SecretStore` on every call (never cached in module state where it could
 * outlive a `forget()`).
 */

import { redactSecrets } from '@/core/ai/redact';
import { explainProviderError, timeoutMessage } from '@/core/ai/explain';
import {
  ProviderError,
  providerStatusForErrorKind,
  type AIProvider,
  type GenerateRequest,
  type ProviderAvailability,
  type ProviderCapabilities,
  type TruncationReason,
} from '@/core/ai/types';
import { resolveOpenAIRecommended } from '@/core/ai/models';
import { z } from 'zod';
import type { SecretStore } from './secrets';
import {
  DEFAULT_GENERATE_TIMEOUT_MS,
  DEFAULT_HEALTH_TIMEOUT_MS,
  E2E_PROVIDER_BASE_URL,
  HttpProviderError,
  parseSSEStream,
  providerErrorFromResponse,
  requestWithRetry,
  type FetchLike,
} from './http';

// See `E2E_PROVIDER_BASE_URL` in ./http for what this is and why it is always
// `''` (falling through to the real endpoints) outside the
// `MOTION_E2E_PROVIDER_HOSTS=1` test build.
const OPENAI_BASE_URL = E2E_PROVIDER_BASE_URL || 'https://api.openai.com';
const RESPONSES_URL = `${OPENAI_BASE_URL}/v1/responses`;
const MODELS_URL = `${OPENAI_BASE_URL}/v1/models`;

export interface OpenAIProviderDeps {
  secrets: SecretStore;
  fetchImpl?: FetchLike;
}

interface OpenAIInputMessage {
  role: 'user' | 'assistant' | 'developer';
  content: string;
}

const openAIModelsSchema = z.object({
  data: z.array(z.object({ id: z.string() })),
});

const incompleteDetailsSchema = z.object({ reason: z.string().optional() }).nullable().optional();

const openAIResponseSchema = z.object({
  status: z.enum(['completed', 'incomplete']),
  incomplete_details: incompleteDetailsSchema,
  output_text: z.string().optional(),
  output: z.array(z.object({
    content: z.array(z.object({
      type: z.string(),
      text: z.string().optional(),
    })).optional(),
  })).optional(),
});

const openAITextDeltaSchema = z.object({
  type: z.literal('response.output_text.delta'),
  delta: z.string(),
});

const openAICompletedSchema = z.object({
  type: z.literal('response.completed'),
  response: z.object({ status: z.literal('completed') }),
});

const openAIFailedSchema = z.object({
  type: z.literal('response.failed'),
  response: z.object({ status: z.literal('failed') }),
});
const openAIIncompleteSchema = z.object({
  type: z.literal('response.incomplete'),
  response: z.object({ status: z.literal('incomplete'), incomplete_details: incompleteDetailsSchema }),
});
const openAIErrorSchema = z.object({ type: z.literal('error') });

function buildBody(req: GenerateRequest, model: string, stream: boolean) {
  // JSON mode requires an instruction in a system, user, or developer input
  // message. `instructions` is intentionally retained as the full Motion
  // policy, but is not an input item for that API validation.
  const input: OpenAIInputMessage[] = [
    ...(req.json ? [{
      role: 'developer' as const,
      content: 'Return one valid JSON object and no text outside that JSON object.',
    }] : []),
    ...req.messages.map((m) => ({ role: m.role, content: m.content })),
  ];
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
    // `fetch` must be bound before it is stored as `this.fetchImpl` and later
    // invoked as `options.fetchImpl(...)` in requestWithRetry — an unbound
    // reference is called with the wrong receiver there, and a service
    // worker's stricter WorkerGlobalScope binding (unlike Window) throws
    // "Failed to execute 'fetch' on 'WorkerGlobalScope': Illegal invocation"
    // for that receiver mismatch. Confirmed with a real MV3 service worker:
    // this was a real bug, not just a test artifact.
    this.fetchImpl = deps.fetchImpl ?? fetch.bind(globalThis);
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
    const configured = await this.secrets.has('openai');
    if (!configured) return { status: 'not-configured', message: 'OpenAI isn’t set up yet. Add an API key in Motion’s settings to use it.' };
    return { status: 'available', message: 'OpenAI is ready.' };
  }

  async listModels(options: Pick<GenerateRequest, 'signal'> = {}): Promise<string[]> {
    const key = await this.key();
    if (!key) throw new ProviderError('not-configured', 'OpenAI is not configured.');
    const response = await requestWithRetry({
      url: MODELS_URL,
      init: { method: 'GET', headers: { Authorization: `Bearer ${key}` } },
      fetchImpl: this.fetchImpl,
      timeoutMs: DEFAULT_HEALTH_TIMEOUT_MS,
      knownSecrets: [key],
      signal: options.signal,
    });
    if (!response.ok) throw await this.toProviderError(response, key, 'GET');
    let rawBody: unknown;
    try {
      rawBody = await response.json();
    } catch (error) {
      throw toRequestError(error, key);
    }
    const body = openAIModelsSchema.safeParse(rawBody);
    if (!body.success) throw badResponseError('OpenAI');
    return body.data.data.map((model) => model.id);
  }

  async healthCheck(options: Pick<GenerateRequest, 'signal'> = {}): Promise<ProviderAvailability> {
    try {
      await this.listModels(options);
      return { status: 'available', message: 'OpenAI is ready.' };
    } catch (err) {
      return this.availabilityFromError(err);
    }
  }

  private availabilityFromError(err: unknown): ProviderAvailability {
    if (err instanceof ProviderError) {
      return { status: providerStatusForErrorKind(err.kind), message: err.message, retryAfterMs: err.retryAfterMs };
    }
    return { status: 'network-error', message: 'Motion couldn’t reach OpenAI. Check your connection and try again.' };
  }

  private async toProviderError(response: Response, key: string, method: 'GET' | 'POST'): Promise<ProviderError> {
    return providerErrorFromResponse('openai', response, await readErrorBody(response), key, method);
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
    if (!response.ok) throw await this.toProviderError(response, key, 'POST');
    let rawBody: unknown;
    try {
      rawBody = await response.json();
    } catch (error) {
      throw toRequestError(error, key);
    }
    const body = openAIResponseSchema.safeParse(rawBody);
    if (!body.success) throw badResponseError('OpenAI');
    const text = typeof body.data.output_text === 'string'
      ? body.data.output_text
      : (body.data.output ?? []).flatMap((output) => output.content ?? [])
      .filter((content) => content.type === 'output_text')
      .map((content) => content.text ?? '')
      .join('');
    if (!text) throw badResponseError('OpenAI');
    // An `incomplete` response still carries the text produced so far.
    if (body.data.status === 'incomplete') req.onTruncated?.(truncationFor(body.data.incomplete_details?.reason));
    return text;
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
    if (!response.ok || !response.body) throw await this.toProviderError(response, key, 'POST');

    try {
      let completed = false;
      let emitted = false;
      let truncation: TruncationReason | undefined;
      for await (const event of parseSSEStream(response.body, req.signal)) {
        if (event.event === 'response.output_text.delta') {
          const parsed = parseStreamEvent(event.data, openAITextDeltaSchema, 'OpenAI');
          if (parsed.delta) {
            emitted = true;
            yield parsed.delta;
          }
        } else if (event.event === 'response.completed') {
          parseStreamEvent(event.data, openAICompletedSchema, 'OpenAI');
          completed = true;
        } else if (event.event === 'response.failed') {
          parseStreamEvent(event.data, openAIFailedSchema, 'OpenAI');
          throw badResponseError('OpenAI');
        } else if (event.event === 'response.incomplete') {
          // Keep the text already streamed; only the stop reason is reported.
          truncation = truncationFor(parseStreamEvent(event.data, openAIIncompleteSchema, 'OpenAI').response.incomplete_details?.reason);
          completed = true;
        } else if (event.event === 'error') {
          parseStreamEvent(event.data, openAIErrorSchema, 'OpenAI');
          throw badResponseError('OpenAI');
        }
      }
      if (!completed) throw badResponseError('OpenAI');
      if (truncation) {
        if (!emitted) throw badResponseError('OpenAI');
        req.onTruncated?.(truncation);
      }
    } catch (error) {
      if (req.signal?.aborted) throw new ProviderError('cancelled', 'Request cancelled.');
      if (error instanceof ProviderError) throw error;
      throw toRequestError(error, key);
    }
  }
}

function toRequestError(err: unknown, key: string): ProviderError {
  if (err instanceof HttpProviderError) {
    // A timed-out chargeable POST may already have been billed: keep the
    // timeout kind, but say so.
    if (err.timedOut) return new ProviderError('timeout', timeoutMessage('openai', err.outcomeUnknown));
    if (err.cancelled) return new ProviderError('cancelled', 'Request cancelled.');
    if (err.outcomeUnknown) return new ProviderError('outcome-unknown', explainProviderError('openai', 'outcome-unknown'));
    return new ProviderError('network-error', redactSecrets('Motion couldn’t reach OpenAI. Check your connection and try again.', [key]));
  }
  return new ProviderError('network-error', redactSecrets(String(err), [key]));
}

function parseStreamEvent<T>(data: string, schema: z.ZodType<T>, provider: 'OpenAI'): T {
  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch {
    throw badResponseError(provider);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw badResponseError(provider);
  return parsed.data;
}

function badResponseError(provider: 'OpenAI'): ProviderError {
  return new ProviderError('bad-response', `${provider} did not return a complete response. Try again.`);
}

function truncationFor(reason: string | undefined): TruncationReason {
  if (reason === 'max_output_tokens') return 'max-tokens';
  if (reason === 'content_filter') return 'refusal';
  return 'incomplete';
}
