/**
 * Fixed-endpoint HTTP helper for cloud providers (ARCH D4 / VISION §17).
 *
 * Every request goes through `assertAllowlisted` first — no provider adapter
 * ever accepts a model- or page-supplied base URL. Handles timeouts, abort
 * composition, bounded retry-with-retry-after, SSE line parsing (including
 * chunks split mid-line), and redaction of anything a provider echoes back.
 */

import { redactSecrets } from '@/core/ai/redact';
import type { ProviderStatus } from '@/core/ai/types';

/** The only hosts Motion will ever send a cloud-provider request to. */
export const ALLOWED_ENDPOINTS = [
  'https://api.openai.com/v1/responses',
  'https://api.openai.com/v1/models',
  'https://api.anthropic.com/v1/messages',
  'https://api.anthropic.com/v1/models',
] as const;

export class EndpointNotAllowedError extends Error {
  constructor(url: string) {
    super(`Endpoint not allowlisted: ${url}`);
    this.name = 'EndpointNotAllowedError';
  }
}

export function assertAllowlisted(url: string): void {
  if (!ALLOWED_ENDPOINTS.includes(url as (typeof ALLOWED_ENDPOINTS)[number])) {
    throw new EndpointNotAllowedError(url);
  }
  if (!url.startsWith('https://')) {
    throw new EndpointNotAllowedError(url);
  }
}

const DEFAULT_GENERATE_TIMEOUT_MS = 60_000;
const DEFAULT_HEALTH_TIMEOUT_MS = 15_000;
const MAX_RETRY_AFTER_MS = 60_000;
const MAX_RETRIES = 2;

export { DEFAULT_GENERATE_TIMEOUT_MS, DEFAULT_HEALTH_TIMEOUT_MS, MAX_RETRY_AFTER_MS, MAX_RETRIES };

/** A `fetch`-shaped function, injected so adapters and tests don't touch the global. */
export type FetchLike = typeof fetch;

export interface RequestOptions {
  url: string;
  init: RequestInit;
  fetchImpl: FetchLike;
  timeoutMs?: number;
  signal?: AbortSignal | undefined;
  /** Known secrets to strip from any error text this call produces. */
  knownSecrets?: readonly string[];
  /** Retries only apply before any response bytes are read (never mid-stream). */
  maxRetries?: number;
}

function isRetryStatus(status: number, method: string, response: Response): boolean {
  if (method !== 'POST') return status === 429 || status >= 500;
  if (status === 429) return true;
  // These overload responses are explicitly non-processing only when the
  // provider supplies retry guidance. Other POST 5xx responses are
  // outcome-unknown because the provider may have accepted the request.
  return (status === 503 || status === 529) && parseRetryAfterMs(response) !== undefined;
}

function composeAbort(timeoutMs: number, external?: AbortSignal): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), timeoutMs);
  const onExternalAbort = () => controller.abort(external?.reason);
  if (external) {
    if (external.aborted) controller.abort(external.reason);
    else external.addEventListener('abort', onExternalAbort, { once: true });
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      external?.removeEventListener('abort', onExternalAbort);
    },
  };
}

function parseRetryAfterMs(response: Response): number | undefined {
  const header = response.headers.get('retry-after');
  if (!header) return undefined;
  const asSeconds = Number(header);
  if (Number.isFinite(asSeconds)) return asSeconds * 1000;
  const asDate = Date.parse(header);
  if (!Number.isNaN(asDate)) return Math.max(0, asDate - Date.now());
  return undefined;
}

export class HttpProviderError extends Error {
  readonly status: number | undefined;
  readonly retryAfterMs: number | undefined;
  readonly cancelled: boolean;
  readonly networkError: boolean;
  readonly outcomeUnknown: boolean;

  constructor(
    message: string,
    opts: { status?: number; retryAfterMs?: number; cancelled?: boolean; networkError?: boolean; outcomeUnknown?: boolean } = {},
  ) {
    super(message);
    this.name = 'HttpProviderError';
    this.status = opts.status;
    this.retryAfterMs = opts.retryAfterMs;
    this.cancelled = opts.cancelled ?? false;
    this.networkError = opts.networkError ?? false;
    this.outcomeUnknown = opts.outcomeUnknown ?? false;
  }
}

export function isOutcomeUnknownStatus(status: number): boolean {
  return status === 500 || status === 502 || status === 504;
}

function responseWithBodyCleanup(
  response: Response,
  signal: AbortSignal,
  externalSignal: AbortSignal | undefined,
  cleanup: () => void,
  outcomeUnknown: boolean,
): Response {
  if (!response.body) {
    cleanup();
    return response;
  }

  const source = response.body;
  let sourceReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const reader = source.getReader();
      sourceReader = reader;
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        cleanup();
        signal.removeEventListener('abort', onAbort);
      };
      const onAbort = () => {
        if (settled) return;
        const error = externalSignal?.aborted
          ? new DOMException('Request cancelled.', 'AbortError')
          : new HttpProviderError('Request timed out.', { outcomeUnknown });
        // Do not use the provider-facing error as the source stream's cancel
        // reason: a few browser stream implementations surface that reason as
        // an unhandled rejection while the wrapped response is already
        // reporting it through controller.error().
        void reader.cancel().catch(() => undefined);
        finish();
        controller.error(error);
      };

      signal.addEventListener('abort', onAbort, { once: true });
      void (async () => {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) {
              finish();
              controller.close();
              return;
            }
            controller.enqueue(value);
          }
        } catch (error) {
          finish();
          controller.error(error);
        }
      })();
    },
    cancel(reason) {
      cleanup();
      return sourceReader?.cancel(reason).catch(() => undefined) ?? Promise.resolve();
    },
  });

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/**
 * Performs the request with timeout, abort composition, and bounded retry.
 * Retries only fire when nothing has been read from the response body yet —
 * once a caller starts reading a stream, failures propagate as-is rather
 * than silently re-sending a possibly-chargeable request.
 */
export async function requestWithRetry(options: RequestOptions): Promise<Response> {
  assertAllowlisted(options.url);
  const timeoutMs = options.timeoutMs ?? DEFAULT_GENERATE_TIMEOUT_MS;
  const maxRetries = options.maxRetries ?? MAX_RETRIES;
  const knownSecrets = options.knownSecrets ?? [];
  const method = (options.init.method ?? 'GET').toString().toUpperCase();
  const chargeablePost = method === 'POST';

  let attempt = 0;
  for (;;) {
    const { signal, cleanup } = composeAbort(timeoutMs, options.signal);
    try {
      const response = await options.fetchImpl(options.url, { ...options.init, signal });

      if (!response.ok && isRetryStatus(response.status, method, response) && attempt < maxRetries) {
        const retryAfterMs = parseRetryAfterMs(response);
        if (retryAfterMs !== undefined && retryAfterMs > MAX_RETRY_AFTER_MS) {
          // Too long to wait inline — surface as rate-limited instead of sleeping.
          cleanup();
          return response;
        }
        cleanup();
        attempt += 1;
        await new Promise((resolve) => setTimeout(resolve, retryAfterMs ?? 500 * attempt));
        continue;
      }
      return responseWithBodyCleanup(response, signal, options.signal, cleanup, chargeablePost);
    } catch (err) {
      cleanup();
      if (options.signal?.aborted) {
        throw new HttpProviderError(redactSecrets(String(err), knownSecrets), { cancelled: true });
      }
      const isTimeout = err instanceof DOMException && err.name === 'TimeoutError';
      if (!chargeablePost && !isTimeout && attempt < maxRetries) {
        attempt += 1;
        await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
        continue;
      }
      throw new HttpProviderError(redactSecrets(String(err), knownSecrets), {
        networkError: !isTimeout,
        cancelled: isTimeout,
        outcomeUnknown: chargeablePost,
      });
    }
  }
}

/** One parsed Server-Sent Event. */
export interface SSEEvent {
  event?: string;
  data: string;
}

/**
 * Parses an SSE byte stream into events, correctly handling chunks that
 * split mid-line or mid-event (providers do not align frames to chunk
 * boundaries, and a naive per-chunk split would corrupt or drop data).
 */
export async function* parseSSEStream(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SSEEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const onAbort = () => {
    void reader.cancel(signal?.reason).catch(() => undefined);
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (signal?.aborted) throw new DOMException('Request cancelled.', 'AbortError');
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let boundary: number;
      // Events are separated by a blank line.
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const rawEvent = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = parseEventBlock(rawEvent);
        if (event) yield event;
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      const event = parseEventBlock(buffer);
      if (event) yield event;
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}

function parseEventBlock(block: string): SSEEvent | null {
  let eventName: string | undefined;
  const dataLines: string[] = [];
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) eventName = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0) return null;
  return { event: eventName, data: dataLines.join('\n') };
}

/** Maps an HTTP status + parsed error body to a `ProviderStatus`. */
export function classifyHttpError(
  provider: 'openai' | 'anthropic',
  status: number,
  body: unknown,
): ProviderStatus {
  if (status === 401 || status === 403) return 'invalid-key';
  if (status === 404) return 'model-unavailable';

  if (provider === 'openai') {
    const code = (body as { error?: { code?: string } } | undefined)?.error?.code;
    if (status === 429 && code === 'insufficient_quota') return 'insufficient-quota';
    if (status === 429) return 'rate-limited';
  }

  if (provider === 'anthropic') {
    const type = (body as { error?: { type?: string } } | undefined)?.error?.type;
    if (type === 'rate_limit_error' || status === 429) return 'rate-limited';
    if (status === 400 && /credit balance/i.test(JSON.stringify(body ?? ''))) return 'insufficient-quota';
    if (status === 529 || type === 'overloaded_error') return 'rate-limited';
    if (type === 'not_found_error') return 'model-unavailable';
  }

  if (status >= 500) return 'network-error';
  return 'network-error';
}
