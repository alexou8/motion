/**
 * BYOK secret storage (ARCH D3 / VISION §16).
 *
 * Raw provider API keys default to trusted `chrome.storage.session`; explicit
 * opt-in uses the OS credential vault through the native companion. They never reach
 * `chrome.storage.local`/`sync`, IndexedDB, content scripts, logs, thrown
 * errors, or UI messages. The storage area is injectable so tests run
 * against a fake without touching real `chrome.storage`.
 */

import { z } from 'zod';
import { withLock } from '@/platform/locks';
import { NativeKeychainAdapter, type KeychainVault } from './keychain';

export type SecretStorageMode = 'session' | 'keychain';

export interface SecretStore {
  get(id: string): Promise<string | null>;
  set(id: string, value: string, storage?: SecretStorageMode): Promise<void>;
  forget(id: string): Promise<void>;
  has(id: string): Promise<boolean>;
  storageFor?(id: string): Promise<SecretStorageMode>;
  persistence: 'session' | 'hybrid';
}

/** The slice of `chrome.storage.StorageArea` this module needs, for faking in tests. */
export interface StorageArea {
  get(keys: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
  setAccessLevel?(options: { accessLevel: 'TRUSTED_CONTEXTS' | 'TRUSTED_AND_UNTRUSTED_CONTEXTS' }): Promise<void>;
}

const KEY_PREFIX = 'motion.secret.';

function keyFor(id: string): string {
  return `${KEY_PREFIX}${id}`;
}

/**
 * Backed by `chrome.storage.session` by default. Access is restricted to
 * trusted extension contexts (background, side panel, options) so a content
 * script can never read it, and the access level is set once per instance
 * rather than assumed.
 */
export class SessionSecretStore implements SecretStore {
  readonly persistence = 'session' as const;
  private readonly area: StorageArea;
  private accessLevelSet = false;
  private accessLevelPromise: Promise<void> | undefined;

  constructor(area: StorageArea = chrome.storage.session as unknown as StorageArea) {
    this.area = area;
  }

  private async ensureAccessLevel(): Promise<void> {
    if (this.accessLevelSet) return;
    if (!this.accessLevelPromise) {
      this.accessLevelPromise = (async () => {
        await this.area.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' });
        this.accessLevelSet = true;
      })();
    }
    try { await this.accessLevelPromise; }
    catch (error) { this.accessLevelPromise = undefined; throw error; }
  }

  async get(id: string): Promise<string | null> {
    await this.ensureAccessLevel();
    const result = await this.area.get(keyFor(id));
    const value = result[keyFor(id)];
    return typeof value === 'string' ? value : null;
  }

  async set(id: string, value: string, storage: SecretStorageMode = 'session'): Promise<void> {
    if (storage !== 'session') throw new Error('This credential store supports session storage only.');
    await this.ensureAccessLevel();
    await this.area.set({ [keyFor(id)]: value });
  }

  async forget(id: string): Promise<void> {
    await this.ensureAccessLevel();
    await this.area.remove(keyFor(id));
  }

  async has(id: string): Promise<boolean> {
    return (await this.get(id)) !== null;
  }
}

const CLOUD_PROVIDER_IDS = ['openai', 'anthropic'] as const;
const persistedStorageModeSchema = z.enum(['session', 'keychain', 'keychain-save-pending', 'keychain-forget-pending']);
const keyStorageModesSchema = z.record(z.enum(CLOUD_PROVIDER_IDS), persistedStorageModeSchema);
const KEYCHAIN_PROVIDERS_KEY = 'motion.keychain.providers';

type PersistedStorageMode = z.infer<typeof persistedStorageModeSchema>;
type KeyStorageModes = z.infer<typeof keyStorageModesSchema>;
type LockRunner = <T>(name: string, run: () => Promise<T>) => Promise<T>;

export interface HybridSecretStoreOptions {
  session?: SecretStore;
  localStorage?: StorageArea;
  vault?: KeychainVault;
  canUseKeychain?: () => Promise<boolean>;
  lock?: LockRunner;
}

/**
 * Uses session storage by default and opts into the native OS vault per cloud
 * provider. The OS key never enters local storage; a session copy is only a
 * trusted-context cache for the current browser session.
 */
export class HybridSecretStore implements SecretStore {
  readonly persistence = 'hybrid' as const;
  private readonly session: SecretStore;
  private readonly local: StorageArea;
  private readonly vault: KeychainVault;
  private readonly canUseKeychain: () => Promise<boolean>;
  private readonly lock: LockRunner;

  constructor(options: HybridSecretStoreOptions = {}) {
    this.session = options.session ?? new SessionSecretStore();
    this.local = options.localStorage ?? (chrome.storage.local as unknown as StorageArea);
    this.vault = options.vault ?? new NativeKeychainAdapter();
    this.canUseKeychain = options.canUseKeychain ?? (async () => {
      try { return await chrome.permissions.contains({ permissions: ['nativeMessaging'] }); } catch { return false; }
    });
    this.lock = options.lock ?? withLock;
  }

  private async readModes(): Promise<KeyStorageModes> {
    const raw = (await this.local.get(KEYCHAIN_PROVIDERS_KEY))[KEYCHAIN_PROVIDERS_KEY];
    const parsed = keyStorageModesSchema.safeParse(raw);
    return parsed.success ? parsed.data : {};
  }

  private async writeMode(providerId: string, storage: PersistedStorageMode): Promise<void> {
    await this.lock('motion:keychain:metadata', async () => {
      const modes = await this.readModes();
      await this.local.set({ [KEYCHAIN_PROVIDERS_KEY]: { ...modes, [providerId]: storage } });
    });
  }

  private async mode(providerId: string): Promise<PersistedStorageMode> {
    if (!CLOUD_PROVIDER_IDS.includes(providerId as (typeof CLOUD_PROVIDER_IDS)[number])) return 'session';
    return (await this.readModes())[providerId as (typeof CLOUD_PROVIDER_IDS)[number]] ?? 'session';
  }

  async storageFor(id: string): Promise<SecretStorageMode> {
    return this.lock(`motion:keychain:provider:${id}`, async () => {
      const mode = await this.mode(id);
      return mode === 'session' ? 'session' : 'keychain';
    });
  }

  async get(id: string): Promise<string | null> {
    return this.lock(`motion:keychain:provider:${id}`, async () => {
      const storage = await this.mode(id);
      if (storage === 'session' || !CLOUD_PROVIDER_IDS.includes(id as (typeof CLOUD_PROVIDER_IDS)[number]))
        return this.session.get(id);
      if (storage !== 'keychain') return null;
      const cached = await this.session.get(id);
      if (cached !== null) return cached;
      const key = await this.vault.get(id as (typeof CLOUD_PROVIDER_IDS)[number]);
      if (key !== null) await this.session.set(id, key);
      return key;
    });
  }

  async set(id: string, value: string, storage: SecretStorageMode = 'session'): Promise<void> {
    if (storage === 'keychain' && !CLOUD_PROVIDER_IDS.includes(id as (typeof CLOUD_PROVIDER_IDS)[number]))
      throw new Error('This provider cannot use operating system keychain storage.');
    await this.lock(`motion:keychain:provider:${id}`, async () => {
      const current = await this.mode(id);
      if (storage === 'keychain') {
        const providerId = id as (typeof CLOUD_PROVIDER_IDS)[number];
        await this.writeMode(id, 'keychain-save-pending');
        await this.vault.set(providerId, value);
        await this.session.set(id, value);
        await this.writeMode(id, 'keychain');
        return;
      }
      if (current !== 'session') await this.vault.delete(id as (typeof CLOUD_PROVIDER_IDS)[number]);
      await this.session.set(id, value);
      await this.writeMode(id, 'session');
    });
  }

  async forget(id: string): Promise<void> {
    await this.lock(`motion:keychain:provider:${id}`, async () => {
      const current = await this.mode(id);
      if (current !== 'session') {
        // Persist the revocation first. If native deletion fails, no later read
        // may restore the credential; a subsequent Forget can retry the delete.
        await this.writeMode(id, 'keychain-forget-pending');
        await this.session.forget(id);
        if (CLOUD_PROVIDER_IDS.includes(id as (typeof CLOUD_PROVIDER_IDS)[number]))
          await this.vault.delete(id as (typeof CLOUD_PROVIDER_IDS)[number]);
      } else {
        await this.session.forget(id);
      }
      await this.writeMode(id, 'session');
    });
  }

  async has(id: string): Promise<boolean> {
    return this.lock(`motion:keychain:provider:${id}`, async () => {
      const mode = await this.mode(id);
      if (mode !== 'session' && mode !== 'keychain') return false;
      if (mode === 'session') return this.session.has(id);
      if (await this.session.has(id)) return true;
      // Metadata is written only after a successful vault save. Avoid starting
      // the native host for routine diagnostics; the actual provider request
      // retrieves the key and reports a locked/unavailable vault honestly.
      return this.canUseKeychain().catch(() => false);
    });
  }
}
