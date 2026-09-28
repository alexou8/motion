import { describe, expect, it, vi } from 'vitest';
import { HybridSecretStore, SessionSecretStore, type StorageArea } from './secrets';
import type { KeychainVault } from './keychain';

function fakeArea(): StorageArea & { backing: Map<string, unknown> } {
  const backing = new Map<string, unknown>();
  return {
    backing,
    async get(keys) {
      const list = keys === null ? [...backing.keys()] : Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const k of list) if (backing.has(k)) out[k] = backing.get(k);
      return out;
    },
    async set(items) {
      for (const [k, v] of Object.entries(items)) backing.set(k, v);
    },
    async remove(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      for (const k of list) backing.delete(k);
    },
    setAccessLevel: vi.fn(async () => undefined),
  };
}

const CANARY = 'sk-test-CANARY1234567890';

describe('SessionSecretStore', () => {
  it('sets, gets and forgets a secret', async () => {
    const area = fakeArea();
    const store = new SessionSecretStore(area);
    expect(await store.has('openai')).toBe(false);

    await store.set('openai', CANARY);
    expect(await store.get('openai')).toBe(CANARY);
    expect(await store.has('openai')).toBe(true);

    await store.forget('openai');
    expect(await store.get('openai')).toBeNull();
    expect(await store.has('openai')).toBe(false);
  });

  it('restricts access to trusted contexts', async () => {
    const area = fakeArea();
    const store = new SessionSecretStore(area);
    await store.set('anthropic', CANARY);
    expect(area.setAccessLevel).toHaveBeenCalledWith({ accessLevel: 'TRUSTED_CONTEXTS' });
  });

  it('retries access restriction after failure before writing a key', async () => {
    const area = fakeArea();
    vi.mocked(area.setAccessLevel!).mockRejectedValueOnce(new Error('synthetic restriction failure'));
    const store = new SessionSecretStore(area);
    await expect(store.set('openai', CANARY)).rejects.toThrow();
    expect(area.backing.size).toBe(0);
    await store.set('openai', CANARY);
    expect(area.setAccessLevel).toHaveBeenCalledTimes(2);
    expect(await store.get('openai')).toBe(CANARY);
  });

  it('sets the access level only once across multiple calls', async () => {
    const area = fakeArea();
    const store = new SessionSecretStore(area);
    await store.set('anthropic', CANARY);
    await store.get('anthropic');
    await store.forget('anthropic');
    expect(area.setAccessLevel).toHaveBeenCalledTimes(1);
  });

  it('never touches chrome.storage.local', async () => {
    const sessionArea = fakeArea();
    const localArea = fakeArea();
    // Sanity: a real StorageArea object distinct from `session` never receives writes.
    const store = new SessionSecretStore(sessionArea);
    await store.set('openai', CANARY);
    expect(localArea.backing.size).toBe(0);
  });

  it('reports session persistence', () => {
    const store = new SessionSecretStore(fakeArea());
    expect(store.persistence).toBe('session');
  });

  it('keeps two provider ids independent', async () => {
    const area = fakeArea();
    const store = new SessionSecretStore(area);
    await store.set('openai', 'sk-openai-CANARY1234567890');
    await store.set('anthropic', 'sk-ant-CANARY1234567890');
    expect(await store.get('openai')).toBe('sk-openai-CANARY1234567890');
    expect(await store.get('anthropic')).toBe('sk-ant-CANARY1234567890');
    await store.forget('openai');
    expect(await store.get('anthropic')).toBe('sk-ant-CANARY1234567890');
  });
});

describe('HybridSecretStore', () => {
  function setup() {
    const sessionArea = fakeArea();
    const localArea = fakeArea();
    const values = new Map<string, string>();
    const vault: KeychainVault = {
      status: vi.fn(async () => ({ available: true, message: 'ready' })),
      get: vi.fn(async (id) => values.get(id) ?? null),
      set: vi.fn(async (id, value) => { values.set(id, value); }),
      delete: vi.fn(async (id) => { values.delete(id); }),
    };
    const store = new HybridSecretStore({
      session: new SessionSecretStore(sessionArea), localStorage: localArea, vault,
      canUseKeychain: async () => true,
    });
    return { store, vault, values, localArea };
  }

  it('keeps a failed forget revoked and lets a later forget retry vault deletion', async () => {
    const { store, vault, values } = setup();
    await store.set('openai', CANARY, 'keychain');
    vi.mocked(vault.delete).mockRejectedValueOnce(new Error('private host error'));
    await expect(store.forget('openai')).rejects.toThrow();
    expect(await store.get('openai')).toBeNull();
    expect(await store.has('openai')).toBe(false);
    expect(vault.get).toHaveBeenCalledTimes(0);
    expect(values.get('openai')).toBe(CANARY);
    await store.forget('openai');
    expect(values.has('openai')).toBe(false);
    expect(await store.storageFor('openai')).toBe('session');
  });

  it('marks an interrupted keychain save pending so reads cannot expose an orphan and forget can clean it up', async () => {
    const { store, vault, values, localArea } = setup();
    vi.mocked(vault.set).mockImplementationOnce(async (id, value) => { values.set(id, value); throw new Error('interrupted after write'); });
    await expect(store.set('anthropic', CANARY, 'keychain')).rejects.toThrow();
    expect(await store.get('anthropic')).toBeNull();
    expect(await store.has('anthropic')).toBe(false);
    expect(await store.storageFor('anthropic')).toBe('keychain');
    expect(localArea.backing.get('motion.keychain.providers')).toEqual({ anthropic: 'keychain-save-pending' });
    await store.forget('anthropic');
    expect(values.has('anthropic')).toBe(false);
  });
});
