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
  generate(req: GenerateRequest): Promise<string>;
  stream(req: GenerateRequest): AsyncIterable<string>;
  healthCheck?(): Promise<ProviderAvailability>;
}

/**
 * Thrown by provider adapters. `message` is always redacted before this is
 * constructed — see `redactSecrets` in `./redact.ts`.
 */
export class ProviderError extends Error {
  readonly kind: ProviderStatus | 'cancelled' | 'bad-response';
  readonly retryAfterMs: number | undefined;

  constructor(kind: ProviderError['kind'], message: string, retryAfterMs?: number) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind;
    this.retryAfterMs = retryAfterMs;
  }
}
