/**
 * Anthropic adapter (ARCH D4 / VISION §12, §15, §17).
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
import { ANTHROPIC_RECOMMENDED } from '@/core/ai/models';
import { z } from 'zod';
import type { SecretStore } from './secrets';
import {
  classifyHttpError,
  DEFAULT_GENERATE_TIMEOUT_MS,
  DEFAULT_HEALTH_TIMEOUT_MS,
  HttpProviderError,
  parseSSEStream,
  providerErrorForKind,
  providerErrorFromResponse,
  requestWithRetry,
  type FetchLike,
} from './http';

const MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const MODELS_URL = 'https://api.anthropic.com/v1/models';
const ANTHROPIC_VERSION = '2023-06-01';
const MODEL_PAGE_SIZE = 20;
const MAX_MODELS = 100;
const MAX_MODEL_PAGES = MAX_MODELS / MODEL_PAGE_SIZE;

export interface AnthropicProviderDeps {
  secrets: SecretStore;
  fetchImpl?: FetchLike;
}

const anthropicModelsSchema = z.object({
  data: z.array(z.object({ id: z.string() })).max(MODEL_PAGE_SIZE),
  has_more: z.boolean(),
  last_id: z.string().nullable(),
});

// `stop_reason` is deliberately a plain string: a stop reason this adapter
// does not know about must not discard text the model already produced.
const anthropicMessageSchema = z.object({
  type: z.literal('message'),
  content: z.array(z.object({
    type: z.string(),
    text: z.string().optional(),
  })),
  stop_reason: z.string(),
});

// Delta types other than `text_delta` (thinking, signature, input_json and any
// future type) are ignored rather than failing the stream.
const anthropicContentDeltaSchema = z.object({
  type: z.literal('content_block_delta'),
  delta: z.object({ type: z.string(), text: z.string().optional() }),
});

const anthropicMessageDeltaSchema = z.object({
  type: z.literal('message_delta'),
  delta: z.object({ stop_reason: z.string() }),
});

const anthropicMessageStopSchema = z.object({
  type: z.literal('message_stop'),
});

const anthropicErrorSchema = z.object({
  type: z.literal('error'),
  error: z.object({ type: z.string(), message: z.string().optional() }),
});

function headers(key: string): Record<string, string> {
  return {
    'x-api-key': key,
    'anthropic-version': ANTHROPIC_VERSION,
    'anthropic-dangerous-direct-browser-access': 'true',
    'content-type': 'application/json',
  };
}

/**
 * Claude 4.6+ models reason before answering by default, and those reasoning
 * tokens count against `max_tokens`. Motion's requests are short and bounded,
 * so ask for the lowest effort there; older models (Haiku 4.5 and earlier)
 * reject `output_config.effort` outright.
 */
export function supportsEffort(model: string): boolean {
  return /^claude-(fable|mythos)-|^claude-(opus|sonnet|haiku)-(5|4-[6-9])(-|$)/.test(model);
}

function buildBody(req: GenerateRequest, model: string, stream: boolean) {
  return {
    model,
    system: req.system,
    messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
    max_tokens: req.maxOutputTokens ?? 4096,
    stream,
    ...(supportsEffort(model) ? { output_config: { effort: 'low' } } : {}),
  };
}

function modelsUrl(afterId?: string): string {
  const params = new URLSearchParams({ limit: String(MODEL_PAGE_SIZE) });
  if (afterId) params.set('after_id', afterId);
  return `${MODELS_URL}?${params.toString()}`;
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
    const configured = await this.secrets.has('anthropic');
    if (!configured) return { status: 'not-configured', message: 'Anthropic isn’t set up yet. Add an API key in Motion’s settings to use it.' };
    return { status: 'available', message: 'Anthropic is ready.' };
  }

  async listModels(options: Pick<GenerateRequest, 'signal'> = {}): Promise<string[]> {
    const key = await this.key();
    if (!key) throw new ProviderError('not-configured', 'Anthropic is not configured.');
    const ids: string[] = [];
    const seenIds = new Set<string>();
    const seenCursors = new Set<string>();
    let afterId: string | undefined;

    for (let page = 0; page < MAX_MODEL_PAGES; page += 1) {
      const response = await requestWithRetry({
        url: modelsUrl(afterId),
        init: { method: 'GET', headers: headers(key) },
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
      const body = anthropicModelsSchema.safeParse(rawBody);
      if (!body.success) throw badResponseError('Anthropic');
      for (const model of body.data.data) {
        if (!seenIds.has(model.id)) {
          seenIds.add(model.id);
          ids.push(model.id);
        }
      }
      if (!body.data.has_more) return ids;
      if (ids.length >= MAX_MODELS || !body.data.last_id || seenCursors.has(body.data.last_id)) {
        throw badResponseError('Anthropic');
      }
      seenCursors.add(body.data.last_id);
      afterId = body.data.last_id;
    }
    throw badResponseError('Anthropic');
  }

  async healthCheck(options: Pick<GenerateRequest, 'signal'> = {}): Promise<ProviderAvailability> {
    try {
      await this.listModels(options);
      return { status: 'available', message: 'Anthropic is ready.' };
    } catch (err) {
      return this.availabilityFromError(err);
    }
  }

  private availabilityFromError(err: unknown): ProviderAvailability {
    if (err instanceof ProviderError) {
      return { status: providerStatusForErrorKind(err.kind), message: err.message, retryAfterMs: err.retryAfterMs };
    }
    return { status: 'network-error', message: 'Motion couldn’t reach Anthropic. Check your connection and try again.' };
  }

  private async toProviderError(response: Response, key: string, method: 'GET' | 'POST'): Promise<ProviderError> {
    return providerErrorFromResponse('anthropic', response, await readErrorBody(response), key, method);
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
    let rawBody: unknown;
    try {
      rawBody = await response.json();
    } catch (error) {
      throw toRequestError(error, key);
    }
    const body = anthropicMessageSchema.safeParse(rawBody);
    if (!body.success) throw badResponseError('Anthropic');
    const text = body.data.content.filter((content) => content.type === 'text').map((content) => content.text ?? '').join('');
    if (!text) throw emptyResponseError(body.data.stop_reason);
    const truncation = truncationFor(body.data.stop_reason);
    if (truncation) req.onTruncated?.(truncation);
    return text;
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
      let completed = false;
      let stopReason: string | undefined;
      let emitted = false;
      for await (const event of parseSSEStream(response.body, req.signal)) {
        if (event.event === 'content_block_delta') {
          const parsed = parseStreamEvent(event.data, anthropicContentDeltaSchema, 'Anthropic');
          if (parsed.delta.type === 'text_delta' && parsed.delta.text) {
            emitted = true;
            yield parsed.delta.text;
          }
        } else if (event.event === 'message_delta') {
          stopReason = parseStreamEvent(event.data, anthropicMessageDeltaSchema, 'Anthropic').delta.stop_reason;
        } else if (event.event === 'message_stop') {
          parseStreamEvent(event.data, anthropicMessageStopSchema, 'Anthropic');
          if (stopReason === undefined) throw badResponseError('Anthropic');
          completed = true;
        } else if (event.event === 'error') {
          throw streamErrorFor(parseStreamEvent(event.data, anthropicErrorSchema, 'Anthropic'), key);
        }
      }
      if (!completed || stopReason === undefined) throw badResponseError('Anthropic');
      if (!emitted && !isCompleteStopReason(stopReason)) throw emptyResponseError(stopReason);
      const truncation = truncationFor(stopReason);
      if (truncation) req.onTruncated?.(truncation);
    } catch (error) {
      if (req.signal?.aborted) throw new ProviderError('cancelled', 'Request cancelled.');
      if (error instanceof ProviderError) throw error;
      throw toRequestError(error, key);
    }
  }
}

/** Maps a mid-stream `error` event to the same typed errors the HTTP path produces. */
function streamErrorFor(event: z.infer<typeof anthropicErrorSchema>, key: string): ProviderError {
  const type = event.error.type;
  // An internal failure after the request was accepted may still have been billed.
  const kind = type === 'api_error' ? 'outcome-unknown' as const : classifyHttpError('anthropic', 0, event);
  if (kind === 'network-error') return badResponseError('Anthropic');
  return providerErrorForKind('anthropic', kind, { key, body: event, overloaded: type === 'overloaded_error' });
}

function toRequestError(err: unknown, key: string): ProviderError {
  if (err instanceof HttpProviderError) {
    // A timed-out chargeable POST may already have been billed: keep the
    // timeout kind, but say so.
    if (err.timedOut) return new ProviderError('timeout', timeoutMessage('anthropic', err.outcomeUnknown));
    if (err.cancelled) return new ProviderError('cancelled', 'Request cancelled.');
    if (err.outcomeUnknown) return new ProviderError('outcome-unknown', explainProviderError('anthropic', 'outcome-unknown'));
    return new ProviderError('network-error', redactSecrets('Motion couldn’t reach Anthropic. Check your connection and try again.', [key]));
  }
  return new ProviderError('network-error', redactSecrets(String(err), [key]));
}

function parseStreamEvent<T>(data: string, schema: z.ZodType<T>, provider: 'Anthropic'): T {
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

function badResponseError(provider: 'Anthropic'): ProviderError {
  return new ProviderError('bad-response', `${provider} did not return a complete response. Try again.`);
}

function isCompleteStopReason(stopReason: string): boolean {
  return stopReason === 'end_turn' || stopReason === 'stop_sequence';
}

/** Why the model stopped early, or `undefined` when it finished on its own. */
function truncationFor(stopReason: string): TruncationReason | undefined {
  if (isCompleteStopReason(stopReason)) return undefined;
  if (stopReason === 'max_tokens' || stopReason === 'model_context_window_exceeded') return 'max-tokens';
  if (stopReason === 'refusal') return 'refusal';
  return 'incomplete';
}

function emptyResponseError(stopReason: string): ProviderError {
  if (stopReason === 'refusal') return new ProviderError('bad-response', 'Anthropic declined to respond to this request.');
  return badResponseError('Anthropic');
}
