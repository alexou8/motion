import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_AI_PREFERENCES, type AIPreferences } from '@/core/ai/preferences';
import { ProviderError } from '@/core/ai/types';
import type { PreferencesStore } from '@/platform/ai/preferencesStore';
import type { SecretStore } from '@/platform/ai/secrets';
import { providerBlockerFromError, resolveSessionProvider } from './providers';

function preferences(value: AIPreferences): PreferencesStore {
  return {
    async get() { return value; },
    async set(next) { value = next; },
    async update(patch) { value = { ...value, ...patch }; return value; },
  };
}

function secrets(values: Record<string, string> = {}): SecretStore {
  return {
    persistence: 'session',
    async get(id) { return values[id] ?? null; },
    async set(id, value) { values[id] = value; },
    async forget(id) { delete values[id]; },
    async has(id) { return values[id] !== undefined; },
  };
}

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as { LanguageModel?: unknown }).LanguageModel;
});

describe('resolveSessionProvider', () => {
  it('blocks a selected cloud provider until its disclosure is accepted', async () => {
    const result = await resolveSessionProvider({
      preferencesStore: preferences({ ...DEFAULT_AI_PREFERENCES, providerId: 'openai' }),
      secrets: secrets({ openai: 'sk-test-CANARY1234567890' }),
      permissions: { contains: vi.fn(async () => true) },
    });

    expect(result).toEqual({
      kind: 'blocked',
      blocker: expect.objectContaining({ kind: 'permission', message: expect.stringContaining('cloud service') }),
    });
  });

  it('blocks a disclosed cloud provider without its narrow host permission', async () => {
    const contains = vi.fn(async () => false);
    const result = await resolveSessionProvider({
      preferencesStore: preferences({
        ...DEFAULT_AI_PREFERENCES,
        providerId: 'anthropic',
        cloudDisclosureAccepted: ['anthropic'],
      }),
      secrets: secrets({ anthropic: 'sk-ant-CANARY1234567890' }),
      permissions: { contains },
    });

    expect(result).toEqual({
      kind: 'blocked',
      blocker: expect.objectContaining({ kind: 'permission', message: expect.stringContaining('Anthropic') }),
    });
    expect(contains).toHaveBeenCalledWith({ origins: ['https://api.anthropic.com/*'] });
  });

  it('resolves a configured provider without silently choosing another one', async () => {
    const result = await resolveSessionProvider({
      preferencesStore: preferences({
        ...DEFAULT_AI_PREFERENCES,
        providerId: 'openai',
        cloudDisclosureAccepted: ['openai'],
      }),
      secrets: secrets({ openai: 'sk-test-CANARY1234567890' }),
      permissions: { contains: vi.fn(async () => true) },
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })),
    });

    expect(result.kind).toBe('ready');
    if (result.kind === 'ready') {
      expect(result.providerId).toBe('openai');
      expect(result.cloud).toBe(true);
      expect(result.model).toBe('gpt-5');
    }
  });

  it('fails closed when Chrome local availability does not answer in time', async () => {
    vi.useFakeTimers();
    (globalThis as { LanguageModel?: unknown }).LanguageModel = {
      availability: () => new Promise(() => undefined),
    };
    const pending = resolveSessionProvider({
      preferencesStore: preferences(DEFAULT_AI_PREFERENCES),
      secrets: secrets(),
      getPort: () => null,
    });

    await vi.advanceTimersByTimeAsync(5_100);
    const result = await pending;
    expect(result).toMatchObject({ kind: 'blocked', blocker: { kind: 'provider', message: expect.any(String) } });
  });
});

describe('providerBlockerFromError', () => {
  it('uses the canonical invalid-key wording without exposing the error', () => {
    const blocker = providerBlockerFromError(
      new ProviderError('invalid-key', 'secret sk-test-CANARY1234567890'),
      'Anthropic',
    );
    expect(blocker).toEqual({ kind: 'provider', message: 'Your Anthropic API key is no longer valid. Reconnect.' });
    expect(JSON.stringify(blocker)).not.toContain('CANARY');
  });

  it('turns a retry-after duration into a rate-limit blocker with retryAt', () => {
    vi.setSystemTime(new Date('2026-09-16T12:00:00.000Z'));
    const blocker = providerBlockerFromError(
      new ProviderError('rate-limited', '429', 5_000),
      'OpenAI',
    );
    expect(blocker.kind).toBe('rate-limit');
    expect(blocker.message).toContain('5 seconds');
    expect(blocker.retryAt).toBe(Date.parse('2026-09-16T12:00:05.000Z'));
  });
});
