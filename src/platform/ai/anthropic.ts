/**
 * Anthropic adapter (ARCH D4 / VISION §12, §15, §17).
 */

import { redactSecrets } from '@/core/ai/redact';
import { explainProviderError } from '@/core/ai/explain';
import { ProviderError, type AIProvider, type GenerateRequest, type ProviderAvailability, type ProviderCapabilities } from '@/core/ai/types';
import { ANTHROPIC_RECOMMENDED } from '@/core/ai/models';
import { z } from 'zod';
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

const anthropicMessageSchema = z.object({
  type: z.literal('message'),
  content: z.array(z.object({
    type: z.string(),
    text: z.string().optional(),
  })),
  stop_reason: z.enum([
    'end_turn',
    'max_tokens',
    'stop_sequence',
    'tool_use',
    'pause_turn',
    'refusal',
    'model_context_window_exceeded',
  ]),
});

const anthropicContentDeltaSchema = z.object({
  type: z.literal('content_block_delta'),
  delta: z.discriminatedUnion('type', [
    z.object({ type: z.literal('text_delta'), text: z.string() }),
    z.object({ type: z.literal('thinking_delta'), thinking: z.string() }),
    z.object({ type: z.literal('signature_delta'), signature: z.string() }),
    z.object({ type: z.literal('input_json_delta'), partial_json: z.string() }),
  ]),
});

const anthropicMessageDeltaSchema = z.object({
  type: z.literal('message_delta'),
  delta: z.object({
    stop_reason: z.enum([
      'end_turn',
      'max_tokens',
      'stop_sequence',
      'tool_use',
      'pause_turn',
      'refusal',
      'model_context_window_exceeded',
    ]),
  }),
});

const anthropicMessageStopSchema = z.object({
  type: z.literal('message_stop'),
});

const anthropicErrorSchema = z.object({
  type: z.literal('error'),
  error: z.object({ type: z.string() }),
});

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
    let rawBody: unknown;
    try {
      rawBody = await response.json();
    } catch (error) {
      throw toRequestError(error, key);
    }
    const body = anthropicMessageSchema.safeParse(rawBody);
    if (!body.success) throw badResponseError('Anthropic');
    if (!isCompleteStopReason(body.data.stop_reason)) throw badResponseError('Anthropic');
    const text = body.data.content.filter((content) => content.type === 'text').map((content) => content.text ?? '').join('');
    if (!text) throw badResponseError('Anthropic');
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
      let completeStop = false;
      for await (const event of parseSSEStream(response.body, req.signal)) {
        if (event.event === 'content_block_delta') {
          const parsed = parseStreamEvent(event.data, anthropicContentDeltaSchema, 'Anthropic');
          if (parsed.delta.type === 'text_delta' && parsed.delta.text) yield parsed.delta.text;
        } else if (event.event === 'message_delta') {
          const parsed = parseStreamEvent(event.data, anthropicMessageDeltaSchema, 'Anthropic');
          if (!isCompleteStopReason(parsed.delta.stop_reason)) throw badResponseError('Anthropic');
          completeStop = true;
        } else if (event.event === 'message_stop') {
          parseStreamEvent(event.data, anthropicMessageStopSchema, 'Anthropic');
          if (!completeStop) throw badResponseError('Anthropic');
          completed = true;
        } else if (event.event === 'error') {
          parseStreamEvent(event.data, anthropicErrorSchema, 'Anthropic');
          throw badResponseError('Anthropic');
        }
      }
      if (!completed) throw badResponseError('Anthropic');
    } catch (error) {
      if (req.signal?.aborted) throw new ProviderError('cancelled', 'Request cancelled.');
      if (error instanceof ProviderError) throw error;
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
