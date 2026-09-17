/**
 * BYOK secret storage (ARCH D3 / VISION §16).
 *
 * Raw provider API keys live only in `chrome.storage.session`, restricted to
 * trusted extension contexts via `setAccessLevel`. They never reach
 * `chrome.storage.local`/`sync`, IndexedDB, content scripts, logs, thrown
 * errors, or UI messages. The storage area is injectable so tests run
 * against a fake without touching real `chrome.storage`.
 */

export interface SecretStore {
  get(id: string): Promise<string | null>;
  set(id: string, value: string): Promise<void>;
  forget(id: string): Promise<void>;
  has(id: string): Promise<boolean>;
  persistence: 'session';
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

  constructor(area: StorageArea = chrome.storage.session as unknown as StorageArea) {
    this.area = area;
  }

  private async ensureAccessLevel(): Promise<void> {
    if (this.accessLevelSet) return;
    this.accessLevelSet = true;
    await this.area.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' });
  }

  async get(id: string): Promise<string | null> {
    await this.ensureAccessLevel();
    const result = await this.area.get(keyFor(id));
    const value = result[keyFor(id)];
    return typeof value === 'string' ? value : null;
  }

  async set(id: string, value: string): Promise<void> {
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
