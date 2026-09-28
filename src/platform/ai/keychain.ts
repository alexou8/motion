import { z } from 'zod';
import { keychainBackendSchema, keychainStatusResultSchema, type KeychainStatusResult } from '@/core/messaging/sessionContracts';

export const KEYCHAIN_NATIVE_HOST = 'com.motion.keychain';
export const KEYCHAIN_TIMEOUT_MS = 15_000;

const providerIdSchema = z.enum(['openai', 'anthropic']);
const nativeRequestSchema = z.discriminatedUnion('operation', [
  z.object({ version: z.literal(1), operation: z.literal('status'), providerId: providerIdSchema }).strict(),
  z.object({ version: z.literal(1), operation: z.literal('get'), providerId: providerIdSchema }).strict(),
  z.object({ version: z.literal(1), operation: z.literal('set'), providerId: providerIdSchema, key: z.string().min(1).max(4_000) }).strict(),
  z.object({ version: z.literal(1), operation: z.literal('delete'), providerId: providerIdSchema }).strict(),
]);

const nativeResponseSchema = z.discriminatedUnion('ok', [
  z.object({
    version: z.literal(1), ok: z.literal(true), backend: keychainBackendSchema,
    key: z.string().min(1).max(4_096).nullable().optional(), present: z.boolean().optional(),
  }).strict(),
  z.object({ version: z.literal(1), ok: z.literal(false), code: z.enum(['vault-unavailable', 'vault-locked', 'invalid-request']) }).strict(),
]);

export type KeychainBackend = z.infer<typeof keychainBackendSchema>;
export type KeychainFailureCode = 'vault-unavailable' | 'vault-locked' | 'invalid-request';

export class KeychainFailure extends Error {
  constructor(readonly code: KeychainFailureCode) {
    super(code === 'vault-locked' ? 'The operating system keychain is locked.' : 'The operating system keychain is unavailable.');
    this.name = 'KeychainFailure';
  }
}

export interface KeychainVault {
  status(providerId: 'openai' | 'anthropic'): Promise<KeychainStatusResult>;
  get(providerId: 'openai' | 'anthropic'): Promise<string | null>;
  set(providerId: 'openai' | 'anthropic', key: string): Promise<void>;
  delete(providerId: 'openai' | 'anthropic'): Promise<void>;
}

type PortEvent<T> = { addListener(listener: (value: T) => void): void; removeListener?(listener: (value: T) => void): void };
export interface NativePort {
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: PortEvent<unknown>;
  onDisconnect: PortEvent<NativePort>;
}

export interface NativeKeychainOptions {
  hasPermission?: () => Promise<boolean>;
  connect?: (host: string) => NativePort;
  timeoutMs?: number;
}

/** Strict one-request/one-response native messaging client. It never logs host errors or keys. */
export class NativeKeychainAdapter implements KeychainVault {
  private readonly hasPermission: () => Promise<boolean>;
  private readonly connect: (host: string) => NativePort;
  private readonly timeoutMs: number;

  constructor(options: NativeKeychainOptions = {}) {
    this.hasPermission = options.hasPermission ?? (async () => {
      try { return await chrome.permissions.contains({ permissions: ['nativeMessaging'] }); } catch { return false; }
    });
    this.connect = options.connect ?? ((host) => chrome.runtime.connectNative(host));
    this.timeoutMs = options.timeoutMs ?? KEYCHAIN_TIMEOUT_MS;
  }

  private async request(raw: unknown): Promise<z.infer<typeof nativeResponseSchema>> {
    const request = nativeRequestSchema.safeParse(raw);
    if (!request.success) throw new KeychainFailure('invalid-request');
    try {
      if (!await this.hasPermission()) throw new KeychainFailure('vault-unavailable');
    } catch {
      throw new KeychainFailure('vault-unavailable');
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let port: NativePort | null = null;
      const cleanup = () => {
        if (timer !== undefined) clearTimeout(timer);
        try { port?.onMessage.removeListener?.(onMessage); } catch { /* Port may already be disconnected. */ }
        try { port?.onDisconnect.removeListener?.(onDisconnect); } catch { /* Port may already be disconnected. */ }
        try { port?.disconnect(); } catch { /* Disconnect is best-effort cleanup. */ }
      };
      const finish = (response?: z.infer<typeof nativeResponseSchema>, failure?: KeychainFailure) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (failure) reject(failure);
        else if (response) resolve(response);
        else reject(new KeychainFailure('vault-unavailable'));
      };
      const onMessage = (message: unknown) => {
        const parsed = nativeResponseSchema.safeParse(message);
        if (!parsed.success) return finish(undefined, new KeychainFailure('vault-unavailable'));
        finish(parsed.data);
      };
      const onDisconnect = () => {
        // Reading lastError consumes Chrome's unchecked-error diagnostic but
        // never forwards the native host's details to logs or callers.
        void chrome.runtime.lastError;
        finish(undefined, new KeychainFailure('vault-unavailable'));
      };

      try {
        port = this.connect(KEYCHAIN_NATIVE_HOST);
        port.onMessage.addListener(onMessage);
        port.onDisconnect.addListener(onDisconnect);
        timer = setTimeout(() => finish(undefined, new KeychainFailure('vault-unavailable')), this.timeoutMs);
        port.postMessage(request.data);
      } catch {
        finish(undefined, new KeychainFailure('vault-unavailable'));
      }
    });
  }

  async status(providerId: 'openai' | 'anthropic'): Promise<KeychainStatusResult> {
    if (!await this.hasPermission().catch(() => false)) {
      return keychainStatusResultSchema.parse({ available: false, message: 'Allow Native Messaging in Motion to check secure storage.' });
    }
    try {
      const response = await this.request({ version: 1, operation: 'status', providerId });
      if (!response.ok) return keychainStatusResultSchema.parse({ available: false, message: this.messageFor(response.code) });
      if (typeof response.present !== 'boolean') throw new KeychainFailure('vault-unavailable');
      return keychainStatusResultSchema.parse({ available: true, backend: response.backend, message: response.present ? 'The secure storage companion and saved key are available.' : 'The secure storage companion is available; no key is saved for this provider.' });
    } catch (error) {
      return keychainStatusResultSchema.parse({ available: false, message: this.messageFor(error instanceof KeychainFailure ? error.code : 'vault-unavailable') });
    }
  }

  async get(providerId: 'openai' | 'anthropic'): Promise<string | null> {
    const response = await this.request({ version: 1, operation: 'get', providerId });
    if (!response.ok) throw new KeychainFailure(response.code);
    if (typeof response.present !== 'boolean' || !Object.hasOwn(response, 'key')
      || (response.present !== (response.key !== null))) throw new KeychainFailure('vault-unavailable');
    return response.key ?? null;
  }

  async set(providerId: 'openai' | 'anthropic', key: string): Promise<void> {
    if (new TextEncoder().encode(key).byteLength > 4_000) throw new KeychainFailure('invalid-request');
    const response = await this.request({ version: 1, operation: 'set', providerId, key });
    if (!response.ok) throw new KeychainFailure(response.code);
    if (response.present !== true) throw new KeychainFailure('vault-unavailable');
  }

  async delete(providerId: 'openai' | 'anthropic'): Promise<void> {
    const response = await this.request({ version: 1, operation: 'delete', providerId });
    if (!response.ok) throw new KeychainFailure(response.code);
    if (response.present !== false) throw new KeychainFailure('vault-unavailable');
  }

  private messageFor(code: KeychainFailureCode): string {
    if (code === 'vault-locked') return 'Unlock your operating system keychain, then try again.';
    if (code === 'invalid-request') return 'The secure storage companion rejected the request.';
    return 'The secure storage companion is unavailable.';
  }
}
