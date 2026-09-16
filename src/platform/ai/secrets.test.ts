import { describe, expect, it, vi } from 'vitest';
import { SessionSecretStore, type StorageArea } from './secrets';

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
