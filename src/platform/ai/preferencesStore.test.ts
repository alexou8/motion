import { describe, expect, it } from 'vitest';
import { ChromePreferencesStore } from './preferencesStore';
import { DEFAULT_AI_PREFERENCES } from '@/core/ai/preferences';
import type { StorageArea } from './secrets';

function fakeArea(): StorageArea {
  const backing = new Map<string, unknown>();
  return {
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
  };
}

describe('ChromePreferencesStore', () => {
  it('returns defaults when nothing is stored', async () => {
    const store = new ChromePreferencesStore(fakeArea());
    expect(await store.get()).toEqual(DEFAULT_AI_PREFERENCES);
  });

  it('round-trips a validated write', async () => {
    const store = new ChromePreferencesStore(fakeArea());
    await store.set({ ...DEFAULT_AI_PREFERENCES, providerId: 'anthropic', model: 'claude-opus-5' });
    const result = await store.get();
    expect(result.providerId).toBe('anthropic');
    expect(result.model).toBe('claude-opus-5');
  });

  it('falls back to defaults for corrupted stored data rather than throwing', async () => {
    const area = fakeArea();
    await area.set({ 'motion.preferences': { providerId: 'not-a-real-provider' } });
    const store = new ChromePreferencesStore(area);
    expect(await store.get()).toEqual(DEFAULT_AI_PREFERENCES);
  });

  it('update() merges a partial patch over the current value', async () => {
    const store = new ChromePreferencesStore(fakeArea());
    await store.update({ autoOpenRelatedTabs: true });
    const next = await store.update({ providerId: 'openai' });
    expect(next.autoOpenRelatedTabs).toBe(true);
    expect(next.providerId).toBe('openai');
  });
});
