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
  it('never enumerates account models when disclosure is revoked during availability setup', async () => {
    const settings = preferences({ ...DEFAULT_AI_PREFERENCES, providerId: 'openai', cloudDisclosureAccepted: ['openai'] });
    const store = secrets({ openai: 'sk-test-SYNTHETIC1234567890' });
    store.has = async () => { await settings.update({ cloudDisclosureAccepted: [] }); return true; };
    const fetchImpl = vi.fn();
    const result = await resolveSessionProvider({ preferencesStore: settings, secrets: store,
      permissions: { contains: async () => true }, fetchImpl });
    expect(result).toMatchObject({ kind: 'blocked', blocker: { kind: 'permission' } });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('never sends a model-list request after a delayed credential read observes revoked consent', async () => {
    const settings = preferences({ ...DEFAULT_AI_PREFERENCES, providerId: 'openai', cloudDisclosureAccepted: ['openai'] });
    const store = secrets({ openai: 'sk-test-SYNTHETIC1234567890' });
    store.get = async () => { await settings.update({ cloudDisclosureAccepted: [] }); return 'sk-test-SYNTHETIC1234567890'; };
    const fetchImpl = vi.fn();
    await resolveSessionProvider({ preferencesStore: settings, secrets: store,
      permissions: { contains: async () => true }, fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

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

  it('tells the panel to open AI settings for the disclosure and provider-permission blockers', async () => {
    const disclosure = await resolveSessionProvider({
      preferencesStore: preferences({ ...DEFAULT_AI_PREFERENCES, providerId: 'openai' }),
      secrets: secrets({ openai: 'sk-test-CANARY1234567890' }),
      permissions: { contains: vi.fn(async () => true) },
    });
    expect(disclosure).toMatchObject({ kind: 'blocked', blocker: { kind: 'permission', action: 'open-ai-settings' } });

    const hostAccess = await resolveSessionProvider({
      preferencesStore: preferences({ ...DEFAULT_AI_PREFERENCES, providerId: 'anthropic', cloudDisclosureAccepted: ['anthropic'] }),
      secrets: secrets({ anthropic: 'sk-ant-CANARY1234567890' }),
      permissions: { contains: vi.fn(async () => false) },
    });
    expect(hostAccess).toMatchObject({ kind: 'blocked', blocker: { kind: 'permission', action: 'open-ai-settings' } });
  });

  it('blocks with the key-rejected message when the account listing says the key is invalid, rather than using the curated list', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }), { status: 401 }));
    const result = await resolveSessionProvider({
      preferencesStore: preferences({ ...DEFAULT_AI_PREFERENCES, providerId: 'anthropic', cloudDisclosureAccepted: ['anthropic'] }),
      secrets: secrets({ anthropic: 'sk-ant-CANARY1234567890' }),
      permissions: { contains: vi.fn(async () => true) },
      fetchImpl,
    });
    expect(result).toEqual({ kind: 'blocked', blocker: { kind: 'provider', message: 'Your Anthropic API key is no longer valid. Reconnect.' } });
  });

  it('still proceeds with the curated list when the listing fails for a transient reason', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: [{ bad: true }], has_more: false, last_id: null }), { status: 200 }));
    const result = await resolveSessionProvider({
      preferencesStore: preferences({ ...DEFAULT_AI_PREFERENCES, providerId: 'anthropic', cloudDisclosureAccepted: ['anthropic'] }),
      secrets: secrets({ anthropic: 'sk-ant-CANARY1234567890' }),
      permissions: { contains: vi.fn(async () => true) },
      fetchImpl,
    });
    expect(result).toMatchObject({ kind: 'ready', providerId: 'anthropic', model: 'claude-haiku-5-5' });
  });

  it('resolves "recommended" to the preferred model rather than the first (priciest) model the account lists', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: 'claude-fable-5-1' }, { id: 'claude-opus-5-5' }, { id: 'claude-sonnet-5-5' }],
      has_more: false,
      last_id: null,
    }), { status: 200 }));
    const result = await resolveSessionProvider({
      preferencesStore: preferences({ ...DEFAULT_AI_PREFERENCES, providerId: 'anthropic', model: 'recommended', cloudDisclosureAccepted: ['anthropic'] }),
      secrets: secrets({ anthropic: 'sk-ant-CANARY1234567890' }),
      permissions: { contains: vi.fn(async () => true) },
      fetchImpl,
    });
    expect(result).toMatchObject({ kind: 'ready', model: 'claude-sonnet-5-5' });
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
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
    const result = await resolveSessionProvider({
      preferencesStore: preferences({
        ...DEFAULT_AI_PREFERENCES,
        providerId: 'openai',
        cloudDisclosureAccepted: ['openai'],
      }),
      secrets: secrets({ openai: 'sk-test-CANARY1234567890' }),
      permissions: { contains: vi.fn(async () => true) },
      fetchImpl,
    });

    expect(result).toEqual({
      kind: 'blocked',
      blocker: expect.objectContaining({
        kind: 'provider',
        message: expect.stringContaining('No supported OpenAI text model'),
      }),
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('reports a disclosed configured cloud provider without enumerating models for diagnostics', async () => {
    const fetchImpl = vi.fn();
    const result = await resolveSessionProvider({
      preferencesStore: preferences({
        ...DEFAULT_AI_PREFERENCES,
        providerId: 'openai',
        model: 'account-specific-model',
        cloudDisclosureAccepted: ['openai'],
      }),
      secrets: secrets({ openai: 'sk-test-CANARY1234567890' }),
      permissions: { contains: vi.fn(async () => true) },
      fetchImpl,
      resolveModelListing: false,
    });

    expect(result).toEqual(expect.objectContaining({ kind: 'ready', providerId: 'openai', model: 'account-specific-model' }));
    expect(fetchImpl).not.toHaveBeenCalled();
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

  it('marks a needs-permission provider error with the open-settings action', () => {
    const blocker = providerBlockerFromError(new ProviderError('needs-permission', 'x'), 'Anthropic');
    expect(blocker).toMatchObject({ kind: 'permission', action: 'open-ai-settings' });
  });

  it.each([
    ['timeout', 'Anthropic took too long to respond. Try again.'],
    ['forbidden', 'Your Anthropic API key doesn’t have permission to use this model. Check the key’s access or choose another model in Motion’s settings.'],
    ['server-error', 'Anthropic is having trouble right now. Try again shortly.'],
  ] as const)('explains a %s error in its own words', (kind, message) => {
    expect(providerBlockerFromError(new ProviderError(kind, 'raw'), 'Anthropic')).toEqual({ kind: 'provider', message });
  });

  it('keeps the provider detail for a rejected request', () => {
    const blocker = providerBlockerFromError(new ProviderError('bad-request', 'Anthropic rejected the request (invalid_request_error: too long).'), 'Anthropic');
    expect(blocker.message).toContain('too long');
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
