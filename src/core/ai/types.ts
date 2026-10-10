/**
 * Provider-agnostic AI abstraction (ARCH D1 / VISION §12).
 *
 * Nothing outside `src/core/ai` and `src/platform/ai` should know whether
 * inference comes from Chrome's on-device model, OpenAI, or Anthropic. Every
 * adapter implements `AIProvider`; callers depend only on this file.
 */

export type ProviderId = 'chrome-local' | 'openai' | 'anthropic';

export interface ProviderCapabilities {
  streaming: boolean;
  cancellation: boolean;
  backgroundExecution: boolean;
  cloud: boolean;
  requiresKey: boolean;
  structuredOutput: boolean;
}

export type ProviderStatus =
  | 'available'
  | 'downloadable'
  | 'downloading'
  | 'unavailable'
  | 'not-configured'
  | 'needs-document-context'
  | 'needs-permission'
  | 'invalid-key'
  | 'rate-limited'
  | 'insufficient-quota'
  | 'network-error'
  | 'model-unavailable';

/**
 * Error-only kinds never appear as a persisted/transported availability
 * status: `providerStatusForErrorKind` collapses them to `network-error` (with
 * their specific message) wherever a `ProviderStatus` is required.
 */
export type ProviderErrorKind =
  | ProviderStatus
  | 'cancelled'
  | 'bad-response'
  | 'outcome-unknown'
  /** No response bytes arrived within the connect or idle window. */
  | 'timeout'
  /** The provider rejected the request itself (HTTP 400/413/422). */
  | 'bad-request'
  /** The key is valid but not permitted to use the model (HTTP 403). */
  | 'forbidden'
  /** The provider failed on its side (HTTP 5xx other than overload). */
  | 'server-error';

export function providerStatusForErrorKind(kind: ProviderErrorKind): ProviderStatus {
  switch (kind) {
    case 'cancelled':
    case 'bad-response':
    case 'outcome-unknown':
    case 'timeout':
    case 'bad-request':
    case 'forbidden':
    case 'server-error':
      return 'network-error';
    default:
      return kind;
  }
}

/** Why a response ended before the model finished on its own. */
export type TruncationReason = 'max-tokens' | 'refusal' | 'incomplete';

export interface ProviderAvailability {
  status: ProviderStatus;
  /** Human-readable, never contains a secret. */
  message: string;
  retryAfterMs?: number;
}

export interface GenerateRequest {
  system: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  maxOutputTokens?: number;
  signal?: AbortSignal;
  /** Resolved model id — callers must run this through `resolveModel` first. */
  model?: string;
  json?: boolean;
  /**
   * Called when the provider returned usable text but stopped early (token
   * limit, refusal, incomplete response). The text is still returned; callers
   * that care can show a short note.
   */
  onTruncated?: (reason: TruncationReason) => void;
}

export interface AIProvider {
  id: ProviderId;
  displayName: string;
  /**
   * Async because at least one capability — `chrome-local`'s
   * `backgroundExecution` — can only be known by probing the current
   * context at runtime (a service worker sometimes has a working Prompt
   * API and sometimes doesn't; see `src/platform/ai/chromeLocalWorker.ts`).
   */
  capabilities(): Promise<ProviderCapabilities>;
  availability(): Promise<ProviderAvailability>;
  /** Account-visible model IDs, fetched only after the settings gates pass. */
  listModels?(options?: Pick<GenerateRequest, 'signal'>): Promise<string[]>;
  generate(req: GenerateRequest): Promise<string>;
  stream(req: GenerateRequest): AsyncIterable<string>;
  healthCheck?(options?: Pick<GenerateRequest, 'signal'>): Promise<ProviderAvailability>;
}

/**
 * Thrown by provider adapters. `message` is always redacted before this is
 * constructed — see `redactSecrets` in `./redact.ts`.
 */
export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly retryAfterMs: number | undefined;

  constructor(kind: ProviderErrorKind, message: string, retryAfterMs?: number) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind;
    this.retryAfterMs = retryAfterMs;
  }
}
