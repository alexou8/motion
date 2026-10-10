/**
 * Fixed-endpoint HTTP helper for cloud providers (ARCH D4 / VISION §17).
 *
 * Every request goes through `assertAllowlisted` first — no provider adapter
 * ever accepts a model- or page-supplied base URL. Handles timeouts (a connect
 * timeout until response headers, then an idle timeout reset by every body
 * chunk, so a long stream is never capped as a whole), abort composition,
 * bounded retry-with-retry-after, SSE line parsing (including chunks split
 * mid-line and CRLF framing), and redaction of anything a provider echoes back.
 */

import { explainProviderError } from '@/core/ai/explain';
import { redactSecrets } from '@/core/ai/redact';
import { ProviderError, type ProviderErrorKind, type ProviderStatus } from '@/core/ai/types';

/**
 * Build-time-only override of the OpenAI base URL, used exclusively by the
 * `MOTION_E2E_PROVIDER_HOSTS=1` test build (`npm run build:e2e-provider-hosts`)
 * so `test/e2e/provider-stream.mjs` can point at a local Node SSE server
 * bound to 127.0.0.1 instead of the real OpenAI API — Playwright's
 * `context.route` cannot intercept fetches made by the MV3 service worker,
 * so a real local server is used instead of interception.
 *
 * `__MOTION_PROVIDER_BASE_URL__` is a global injected by `define` in
 * vite.config.ts (and pinned to `''` in vitest.config.ts). It is always the
 * empty string in the production build (`npm run build`), which keeps
 * `ALLOWED_ENDPOINTS` byte-identical to the fixed `api.openai.com` /
 * `api.anthropic.com` endpoints — see `http.test.ts`
 * "production keeps the fixed OpenAI endpoints".
 */
declare const __MOTION_PROVIDER_BASE_URL__: string | undefined;
export const E2E_PROVIDER_BASE_URL: string =
  typeof __MOTION_PROVIDER_BASE_URL__ === 'string' ? __MOTION_PROVIDER_BASE_URL__ : '';

/** The only hosts Motion will ever send a cloud-provider request to. */
export const ALLOWED_ENDPOINTS: readonly string[] = E2E_PROVIDER_BASE_URL
  ? [
      `${E2E_PROVIDER_BASE_URL}/v1/responses`,
      `${E2E_PROVIDER_BASE_URL}/v1/models`,
      'https://api.anthropic.com/v1/messages',
      'https://api.anthropic.com/v1/models',
    ]
  : [
      'https://api.openai.com/v1/responses',
      'https://api.openai.com/v1/models',
      'https://api.anthropic.com/v1/messages',
      'https://api.anthropic.com/v1/models',
    ];

export class EndpointNotAllowedError extends Error {
  constructor(url: string) {
    super(`Endpoint not allowlisted: ${url}`);
    this.name = 'EndpointNotAllowedError';
  }
}

export function assertAllowlisted(url: string): void {
  if (!ALLOWED_ENDPOINTS.includes(url) && !isAllowedAnthropicModelsPage(url)) {
    throw new EndpointNotAllowedError(url);
  }
  // The E2E provider-hosts build points OpenAI at a local, build-time-fixed
  // http://127.0.0.1 URL (never attacker- or runtime-controllable — it comes
  // only from `__MOTION_PROVIDER_BASE_URL__`, baked in at build time). Every
  // other endpoint, in every other build, must still be https.
  const isPinnedE2EOverride = Boolean(E2E_PROVIDER_BASE_URL) && url.startsWith(E2E_PROVIDER_BASE_URL);
  if (!isPinnedE2EOverride && !url.startsWith('https://')) {
    throw new EndpointNotAllowedError(url);
  }
}

/**
 * Anthropic's documented Models endpoint is cursor-paginated. The cursor is
 * opaque, but it cannot select another endpoint: only one bounded `limit`
 * and one non-empty `after_id` are accepted on the fixed endpoint.
 */
function isAllowedAnthropicModelsPage(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.origin !== 'https://api.anthropic.com' || parsed.pathname !== '/v1/models' || parsed.hash) return false;
  const keys = [...parsed.searchParams.keys()];
  if (!keys.includes('limit') || keys.some((key) => key !== 'limit' && key !== 'after_id')) return false;
  if (parsed.searchParams.getAll('limit').length !== 1 || parsed.searchParams.getAll('after_id').length > 1) return false;
  const limit = parsed.searchParams.get('limit');
  if (!limit || !/^(?:[1-9]\d{0,2}|1000)$/.test(limit)) return false;
  const afterId = parsed.searchParams.get('after_id');
  return afterId === null || afterId.length > 0;
}

/** Connect timeout: how long to wait for response headers. */
const DEFAULT_GENERATE_TIMEOUT_MS = 60_000;
const DEFAULT_HEALTH_TIMEOUT_MS = 15_000;
/** Idle timeout: the longest silence tolerated between body chunks. */
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;
const MAX_RETRY_AFTER_MS = 60_000;
/** Suggested wait when a provider reports overload without a retry-after. */
const DEFAULT_OVERLOAD_RETRY_MS = 30_000;
const MAX_RETRIES = 2;

export {
  DEFAULT_GENERATE_TIMEOUT_MS,
  DEFAULT_HEALTH_TIMEOUT_MS,
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_OVERLOAD_RETRY_MS,
  MAX_RETRY_AFTER_MS,
  MAX_RETRIES,
};

/** A `fetch`-shaped function, injected so adapters and tests don't touch the global. */
export type FetchLike = typeof fetch;

export interface RequestOptions {
  url: string;
  init: RequestInit;
  fetchImpl: FetchLike;
  /** Connect timeout (until response headers arrive). */
  timeoutMs?: number;
  /** Idle timeout between body chunks once the response has started. */
  idleTimeoutMs?: number;
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

function composeAbort(
  timeoutMs: number,
  external?: AbortSignal,
): { signal: AbortSignal; arm: (ms: number) => void; cleanup: () => void } {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let finished = false;
  // (Re)starts the single timeout: first as the connect timeout, then as the
  // idle timeout that every received chunk pushes back.
  const arm = (ms: number) => {
    if (finished) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), ms);
  };
  arm(timeoutMs);
  const onExternalAbort = () => controller.abort(external?.reason);
  if (external) {
    if (external.aborted) controller.abort(external.reason);
    else external.addEventListener('abort', onExternalAbort, { once: true });
  }
  return {
    signal: controller.signal,
    arm,
    cleanup: () => {
      finished = true;
      if (timer !== undefined) clearTimeout(timer);
      external?.removeEventListener('abort', onExternalAbort);
    },
  };
}

/** Parses `retry-after` in either delta-seconds or HTTP-date form. */
export function parseRetryAfterMs(response: Response): number | undefined {
  const header = response.headers.get('retry-after');
  if (!header) return undefined;
  const asSeconds = Number(header);
  if (Number.isFinite(asSeconds)) return Math.max(0, Math.round(asSeconds * 1000));
  const asDate = Date.parse(header);
  if (!Number.isNaN(asDate)) return Math.max(0, Math.round(asDate - Date.now()));
  return undefined;
}

export class HttpProviderError extends Error {
  readonly status: number | undefined;
  readonly retryAfterMs: number | undefined;
  readonly cancelled: boolean;
  /** The connect or idle timeout elapsed; distinct from a caller cancellation. */
  readonly timedOut: boolean;
  readonly networkError: boolean;
  readonly outcomeUnknown: boolean;

  constructor(
    message: string,
    opts: {
      status?: number;
      retryAfterMs?: number;
      cancelled?: boolean;
      timedOut?: boolean;
      networkError?: boolean;
      outcomeUnknown?: boolean;
    } = {},
  ) {
    super(message);
    this.name = 'HttpProviderError';
    this.status = opts.status;
    this.retryAfterMs = opts.retryAfterMs;
    this.cancelled = opts.cancelled ?? false;
    this.timedOut = opts.timedOut ?? false;
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
  arm: (ms: number) => void,
  idleTimeoutMs: number,
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
          : new HttpProviderError('Request timed out.', { timedOut: true, outcomeUnknown });
        // Do not use the provider-facing error as the source stream's cancel
        // reason: a few browser stream implementations surface that reason as
        // an unhandled rejection while the wrapped response is already
        // reporting it through controller.error().
        void reader.cancel().catch(() => undefined);
        finish();
        controller.error(error);
      };

      signal.addEventListener('abort', onAbort, { once: true });
      // Revocation can win while fetch resolves its headers, before this
      // stream's listener exists. An already-aborted signal fires no new
      // event, so handle it before beginning any body read.
      if (signal.aborted) {
        onAbort();
        return;
      }
      // Headers are in: the connect timeout becomes an idle timeout that each
      // chunk below pushes back, so a long healthy stream is never cut off.
      arm(idleTimeoutMs);
      void (async () => {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) {
              finish();
              controller.close();
              return;
            }
            if (!settled) arm(idleTimeoutMs);
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
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const maxRetries = options.maxRetries ?? MAX_RETRIES;
  const knownSecrets = options.knownSecrets ?? [];
  const method = (options.init.method ?? 'GET').toString().toUpperCase();
  const chargeablePost = method === 'POST';

  let attempt = 0;
  for (;;) {
    const { signal, arm, cleanup } = composeAbort(timeoutMs, options.signal);
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
      return responseWithBodyCleanup(response, signal, options.signal, cleanup, chargeablePost, arm, idleTimeoutMs);
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
        timedOut: isTimeout,
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
      // Normalize CRLF framing; done on the whole buffer so a CR and LF split
      // across two chunks are still joined.
      buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n');

      let boundary: number;
      // Events are separated by a blank line.
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const rawEvent = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = parseEventBlock(rawEvent);
        if (event) yield event;
      }
    }
    buffer = (buffer + decoder.decode()).replace(/\r\n/g, '\n');
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

/** What an HTTP failure maps to: a status plus the request-level error kinds. */
export type HttpErrorKind = ProviderStatus | 'bad-request' | 'forbidden' | 'server-error';

function anthropicErrorType(body: unknown): string | undefined {
  const type = (body as { error?: { type?: unknown } } | undefined)?.error?.type;
  return typeof type === 'string' ? type : undefined;
}

/** Maps an HTTP status + parsed error body to an error kind. */
export function classifyHttpError(
  provider: 'openai' | 'anthropic',
  status: number,
  body: unknown,
): HttpErrorKind {
  if (status === 401) return 'invalid-key';
  // The key is accepted but not permitted (model access, region, project).
  if (status === 403) return 'forbidden';
  if (status === 404) return 'model-unavailable';

  if (provider === 'openai') {
    const code = (body as { error?: { code?: string } } | undefined)?.error?.code;
    if (status === 429 && code === 'insufficient_quota') return 'insufficient-quota';
    if (status === 429) return 'rate-limited';
  }

  if (provider === 'anthropic') {
    const type = anthropicErrorType(body);
    if (type === 'rate_limit_error' || status === 429) return 'rate-limited';
    if (status === 402 || type === 'billing_error') return 'insufficient-quota';
    if (status === 400 && /credit balance/i.test(JSON.stringify(body ?? ''))) return 'insufficient-quota';
    if (status === 529 || type === 'overloaded_error') return 'rate-limited';
    if (type === 'not_found_error') return 'model-unavailable';
    if (type === 'authentication_error') return 'invalid-key';
    if (type === 'permission_error') return 'forbidden';
    if (type === 'invalid_request_error' || type === 'request_too_large') return 'bad-request';
  }

  if (status === 400 || status === 413 || status === 422) return 'bad-request';
  if (status >= 500) return 'server-error';
  return 'network-error';
}

/** True for a provider overload (HTTP 529 / `overloaded_error`), which is safe to retry later. */
export function isOverloadedResponse(status: number, body: unknown): boolean {
  return status === 529 || anthropicErrorType(body) === 'overloaded_error';
}

const PROVIDER_NAMES = { openai: 'OpenAI', anthropic: 'Anthropic' } as const;
const MAX_DETAIL_CHARS = 300;

/** `type: message` from a provider error body, bounded; callers redact it. */
function errorDetail(body: unknown): string | undefined {
  const error = (body as { error?: unknown } | undefined)?.error;
  if (!error || typeof error !== 'object') return undefined;
  const { type, code, message } = error as { type?: unknown; code?: unknown; message?: unknown };
  const label = typeof type === 'string' ? type : typeof code === 'string' ? code : undefined;
  const text = [label, typeof message === 'string' ? message : undefined].filter(Boolean).join(': ');
  const compact = text.replace(/\s+/g, ' ').trim().slice(0, MAX_DETAIL_CHARS);
  return compact || undefined;
}

/**
 * Builds the typed, redacted error for a failure kind. This is the single
 * place both cloud adapters turn an HTTP status or a mid-stream error event
 * into student-readable text; `body` is only used for a request-rejection
 * detail and never contains a secret after `redactSecrets`.
 */
export function providerErrorForKind(
  providerId: 'openai' | 'anthropic',
  kind: ProviderErrorKind,
  options: { key: string; body?: unknown; retryAfterMs?: number; overloaded?: boolean },
): ProviderError {
  const name = PROVIDER_NAMES[providerId];
  let message: string;
  switch (kind) {
    case 'outcome-unknown':
    case 'timeout':
    case 'forbidden':
    case 'server-error':
      message = explainProviderError(providerId, kind);
      break;
    case 'bad-request': {
      const detail = errorDetail(options.body);
      message = explainProviderError(providerId, kind, detail ? `${name} rejected the request (${detail}).` : '');
      break;
    }
    case 'invalid-key':
      message = `Your ${name} API key is no longer valid. Reconnect.`;
      break;
    case 'insufficient-quota':
      message = `Your ${name} account is out of quota. Check your billing with ${name}.`;
      break;
    case 'rate-limited':
      message = options.overloaded ? `${name} is overloaded right now. Try again shortly.` : `${name} is rate limited.`;
      break;
    case 'model-unavailable':
      message = `The selected ${name} model is no longer available.`;
      break;
    default:
      message = `Motion couldn’t reach ${name}. Check your connection and try again.`;
  }
  const retryAfterMs = kind === 'rate-limited'
    ? options.retryAfterMs ?? (options.overloaded ? DEFAULT_OVERLOAD_RETRY_MS : undefined)
    : undefined;
  return new ProviderError(kind, redactSecrets(message, [options.key]), retryAfterMs);
}

/** Converts a non-OK provider HTTP response (and its parsed body) into a typed error. */
export function providerErrorFromResponse(
  providerId: 'openai' | 'anthropic',
  response: Response,
  body: unknown,
  key: string,
  method: 'GET' | 'POST',
): ProviderError {
  const status = classifyHttpError(providerId, response.status, body);
  const kind = method === 'POST' && isOutcomeUnknownStatus(response.status) ? 'outcome-unknown' as const : status;
  return providerErrorForKind(providerId, kind, {
    key,
    body,
    overloaded: isOverloadedResponse(response.status, body),
    ...(kind === 'rate-limited' ? { retryAfterMs: parseRetryAfterMs(response) } : {}),
  });
}
