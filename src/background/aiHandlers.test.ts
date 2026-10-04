import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_AI_PREFERENCES } from '@/core/ai/preferences';
import { ChromePreferencesStore } from '@/platform/ai/preferencesStore';
import { SessionSecretStore, type StorageArea } from '@/platform/ai/secrets';
import { aiStatusResultSchema } from '@/core/messaging/sessionContracts';
import { handleAiMessage } from './aiHandlers';
import { DOCUMENT_LIFECYCLE_KEY } from './documents';

const CANARY = 'sk-test-CANARY1234567890';

function area(withClear = false): StorageArea & { values: Record<string, unknown>; clear?: () => Promise<void> } {
  const values: Record<string, unknown> = {};
  return {
    values,
    async get(keys) {
      if (keys === null) return { ...values };
      const requested = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(requested.filter((key) => key in values).map((key) => [key, values[key]]));
    },
    async set(items) { Object.assign(values, items); },
    async remove(keys) {
      for (const key of (Array.isArray(keys) ? keys : [keys])) delete values[key];
    },
    ...(withClear ? { clear: async () => { for (const key of Object.keys(values)) delete values[key]; } } : {}),
  };
}

let local: ReturnType<typeof area>;
let session: ReturnType<typeof area>;
let preferences: ChromePreferencesStore;
let secrets: SessionSecretStore;

beforeEach(() => {
  local = area();
  session = area(true);
  preferences = new ChromePreferencesStore(local);
  secrets = new SessionSecretStore(session);
  vi.stubGlobal('chrome', {
    permissions: { contains: vi.fn(async () => false) },
    runtime: { id: 'test-extension-id' },
  });
});

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('AI/settings handlers', () => {
  it('stores a key only in session secrets and never returns or logs the canary', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const result = await handleAiMessage(
      { type: 'set-provider-key', providerId: 'openai', key: CANARY },
      { preferencesStore: preferences, secrets, localStorage: local, sessionStorage: session },
    );

    expect(result).toMatchObject({ configured: true, availability: { status: 'available' } });
    expect(JSON.stringify(result)).not.toContain(CANARY);
    expect(JSON.stringify(local.values)).not.toContain(CANARY);
    expect(JSON.stringify(session.values)).toContain(CANARY);
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining(CANARY));
    expect(error).not.toHaveBeenCalledWith(expect.stringContaining(CANARY));
    warn.mockRestore();
    error.mockRestore();
  });

  it('forgets a provider key immediately', async () => {
    await secrets.set('anthropic', CANARY);
    await handleAiMessage(
      { type: 'forget-provider-key', providerId: 'anthropic' },
      { preferencesStore: preferences, secrets, localStorage: local, sessionStorage: session },
    );
    expect(await secrets.get('anthropic')).toBeNull();
    expect(session.values['motion.secret.anthropic']).toBeUndefined();
  });

  it('updates preferences and disclosure without putting a key in local storage', async () => {
    await handleAiMessage(
      { type: 'set-ai-preferences', providerId: 'anthropic', model: 'claude-opus-5' },
      { preferencesStore: preferences, secrets, localStorage: local, sessionStorage: session },
    );
    await handleAiMessage(
      { type: 'accept-cloud-disclosure', providerId: 'anthropic', accepted: true },
      { preferencesStore: preferences, secrets, localStorage: local, sessionStorage: session },
    );
    expect(await preferences.get()).toMatchObject({ providerId: 'anthropic', model: 'claude-opus-5', cloudDisclosureAccepted: ['anthropic'] });
    expect(JSON.stringify(local.values)).not.toContain('secret');
  });

  it('reports provider diagnostics, including local timeout/unavailability and LMS permissions', async () => {
    const result = await handleAiMessage(
      { type: 'ai-status' },
      { preferencesStore: preferences, secrets, localStorage: local, sessionStorage: session, permissions: { contains: vi.fn(async () => false) } },
    );
    expect(aiStatusResultSchema.parse(result)).toBeTruthy();
    expect(result).toMatchObject({ selected: 'chrome-local', model: 'recommended' });
    expect((result as { providers: { providerId: string; status: string; backgroundExecution: boolean }[] }).providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ providerId: 'chrome-local', status: 'needs-document-context', backgroundExecution: false }),
        expect.objectContaining({ providerId: 'openai', status: 'not-configured', backgroundExecution: true }),
      ]),
    );
  });

  it('reports a hanging Chrome local probe as unavailable rather than hanging diagnostics', async () => {
    vi.useFakeTimers();
    (globalThis as { LanguageModel?: unknown }).LanguageModel = {
      availability: () => new Promise(() => undefined),
    };
    const pending = handleAiMessage(
      { type: 'ai-status' },
      { preferencesStore: preferences, secrets, localStorage: local, sessionStorage: session, permissions: { contains: vi.fn(async () => false) } },
    );
    await vi.advanceTimersByTimeAsync(5_100);
    const result = await pending as { providers: { providerId: string; status: string; message: string }[] };
    expect(result.providers.find((provider) => provider.providerId === 'chrome-local')).toMatchObject({
      status: 'unavailable',
      message: 'Chrome’s on-device AI did not respond in this browser.',
    });
  });

  it('deletes all local coursework and session data, retaining only a content-free revocation marker', async () => {
    local.values['motion.preferences'] = DEFAULT_AI_PREFERENCES;
    local.values['motion.other'] = 'synthetic';
    local.values['unrelated'] = 'keep';
    session.values['motion.secret.openai'] = CANARY;
    session.values['other-session'] = 'remove';
    session.values['motion.documentLocal:synthetic'] = { title: 'Synthetic document receipt' };
    const deleteDb = vi.fn(async () => undefined);

    const result = await handleAiMessage(
      { type: 'delete-local-data', confirm: 'DELETE' },
      { preferencesStore: preferences, secrets, localStorage: local, sessionStorage: session, deleteDatabase: deleteDb },
    );

    expect(result).toEqual({ deleted: true });
    expect(deleteDb).toHaveBeenCalledOnce();
    expect(local.values).toEqual({ unrelated: 'keep' });
    expect(session.values).toEqual({ [DOCUMENT_LIFECYCLE_KEY]: { epoch: expect.any(String), deleting: false } });
    expect(JSON.stringify(session.values)).not.toContain(CANARY);
  });

  it('preserves storage and the database when an opted-in vault credential cannot be deleted', async () => {
    local.values['motion.keychain.providers'] = { openai: 'keychain' };
    local.values['motion.preferences'] = DEFAULT_AI_PREFERENCES;
    session.values['motion.secret.openai'] = CANARY;
    vi.spyOn(secrets, 'forget').mockRejectedValue(new Error('safe generic vault failure'));
    const deleteDb = vi.fn(async () => undefined);
    await expect(handleAiMessage(
      { type: 'delete-local-data', confirm: 'DELETE' },
      { preferencesStore: preferences, secrets, localStorage: local, sessionStorage: session, deleteDatabase: deleteDb },
    )).rejects.toThrow('safe generic vault failure');
    expect(deleteDb).not.toHaveBeenCalled();
    expect(local.values['motion.keychain.providers']).toEqual({ openai: 'keychain' });
    expect(session.values['motion.secret.openai']).toBe(CANARY);
  });

  it('runs provider health checks and returns an honest result without echoing the key', async () => {
    await preferences.update({ cloudDisclosureAccepted: ['openai'] });
    await secrets.set('openai', CANARY);
    const result = await handleAiMessage(
      { type: 'test-provider', providerId: 'openai' },
      {
        preferencesStore: preferences,
        secrets,
        localStorage: local,
        sessionStorage: session,
        permissions: { contains: vi.fn(async () => true) },
        fetchImpl: vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })),
      },
    );
    expect(JSON.stringify(result)).not.toContain(CANARY);
    expect(result).toEqual({ availability: { status: 'available', message: 'OpenAI is ready.' } });
  });

  it.each(['openai', 'anthropic'] as const)('never sends a %s health request after disclosure or host access is revoked', async (providerId) => {
    await secrets.set(providerId, CANARY);
    const fetchImpl = vi.fn();
    const deps = { preferencesStore: preferences, secrets, localStorage: local, sessionStorage: session, fetchImpl,
      permissions: { contains: vi.fn(async () => true) } };
    await expect(handleAiMessage({ type: 'test-provider', providerId }, deps)).rejects.toThrow(/disclosure/i);
    await preferences.update({ cloudDisclosureAccepted: [providerId] });
    deps.permissions.contains.mockResolvedValue(false);
    await expect(handleAiMessage({ type: 'test-provider', providerId }, deps)).rejects.toThrow(/permission/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not send a health request if disclosure is revoked while the credential is being retrieved', async () => {
    await preferences.update({ cloudDisclosureAccepted: ['openai'] });
    await secrets.set('openai', CANARY);
    vi.spyOn(secrets, 'get').mockImplementation(async () => {
      await preferences.update({ cloudDisclosureAccepted: [] });
      return CANARY;
    });
    const fetchImpl = vi.fn();
    const result = await handleAiMessage({ type: 'test-provider', providerId: 'openai' }, {
      preferencesStore: preferences, secrets, localStorage: local, sessionStorage: session, fetchImpl,
      permissions: { contains: async () => true },
    });
    expect(result).toMatchObject({ availability: { status: 'network-error' } });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(['test-provider', 'list-provider-models'] as const)('stops %s when Forget wins during a delayed credential read', async (type) => {
    await preferences.update({ cloudDisclosureAccepted: ['openai'] });
    await secrets.set('openai', CANARY);
    let entered!: () => void;
    let release!: (key: string) => void;
    const reading = new Promise<void>((resolve) => { entered = resolve; });
    const credential = new Promise<string>((resolve) => { release = resolve; });
    vi.spyOn(secrets, 'has').mockResolvedValue(true);
    vi.spyOn(secrets, 'get').mockImplementation(async () => { entered(); return credential; });
    const fetchImpl = vi.fn();
    const deps = { preferencesStore: preferences, secrets, localStorage: local, sessionStorage: session, fetchImpl,
      permissions: { contains: async () => true } };
    const pending = handleAiMessage({ type, providerId: 'openai' }, deps);
    await reading;
    await handleAiMessage({ type: 'forget-provider-key', providerId: 'openai' }, deps);
    release(CANARY);
    await pending;
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('aborts a health check waiting for its model-list response body when the key is forgotten', async () => {
    await preferences.update({ cloudDisclosureAccepted: ['openai'] });
    await secrets.set('openai', CANARY);
    let entered!: () => void;
    const reading = new Promise<void>((resolve) => { entered = resolve; });
    let cancelled = false;
    const fetchImpl = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      pull() { entered(); }, cancel() { cancelled = true; },
    }), { status: 200 }));
    const deps = { preferencesStore: preferences, secrets, localStorage: local, sessionStorage: session, fetchImpl,
      permissions: { contains: async () => true } };
    const pending = handleAiMessage({ type: 'test-provider', providerId: 'openai' }, deps);
    await reading;
    await handleAiMessage({ type: 'forget-provider-key', providerId: 'openai' }, deps);
    await pending;
    expect(cancelled).toBe(true);
  });

  it('lists only bounded text-capable account models after every cloud gate passes', async () => {
    await preferences.update({ providerId: 'openai', cloudDisclosureAccepted: ['openai'] });
    await secrets.set('openai', CANARY);
    const data = [
      { id: 'gpt-6-luna' },
      { id: 'gpt-6-sol' },
      { id: 'gpt-4o-audio-preview' },
      { id: 'text-embedding-3-small' },
      ...Array.from({ length: 98 }, (_, index) => ({ id: `gpt-6-${index}` })),
    ];
    const result = await handleAiMessage(
      { type: 'list-provider-models', providerId: 'openai' },
      {
        preferencesStore: preferences,
        secrets,
        localStorage: local,
        sessionStorage: session,
        permissions: { contains: vi.fn(async () => true) },
        fetchImpl: vi.fn(async () => new Response(JSON.stringify({ data }), { status: 200 })),
      },
    );
    expect(result).toMatchObject({ providerId: 'openai', source: 'account' });
    const models = (result as { models: string[] }).models;
    expect(models).toHaveLength(100);
    expect(models).toContain('gpt-6-luna');
    expect(models).not.toContain('gpt-4o-audio-preview');
    expect(models).not.toContain('text-embedding-3-small');
  });

  it('does not query account models before disclosure, host permission, and session-key gates pass', async () => {
    const fetchImpl = vi.fn();
    await expect(handleAiMessage(
      { type: 'list-provider-models', providerId: 'openai' },
      { preferencesStore: preferences, secrets, localStorage: local, sessionStorage: session, fetchImpl },
    )).rejects.toThrow(/disclosure/i);

    await preferences.update({ cloudDisclosureAccepted: ['openai'] });
    await expect(handleAiMessage(
      { type: 'list-provider-models', providerId: 'openai' },
      { preferencesStore: preferences, secrets, localStorage: local, sessionStorage: session, fetchImpl, permissions: { contains: vi.fn(async () => false) } },
    )).rejects.toThrow(/permission/i);

    await expect(handleAiMessage(
      { type: 'list-provider-models', providerId: 'openai' },
      { preferencesStore: preferences, secrets, localStorage: local, sessionStorage: session, fetchImpl, permissions: { contains: vi.fn(async () => true) } },
    )).rejects.toThrow(/API key/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns the named curated choices when a provider sends a malformed model list', async () => {
    await preferences.update({ providerId: 'openai', cloudDisclosureAccepted: ['openai'] });
    await secrets.set('openai', CANARY);
    const result = await handleAiMessage(
      { type: 'list-provider-models', providerId: 'openai' },
      {
        preferencesStore: preferences,
        secrets,
        localStorage: local,
        sessionStorage: session,
        permissions: { contains: vi.fn(async () => true) },
        fetchImpl: vi.fn(async () => new Response(JSON.stringify({ data: [{ name: 'not-an-id' }] }), { status: 200 })),
      },
    );
    expect(result).toMatchObject({ providerId: 'openai', source: 'fallback' });
    expect((result as { models: string[] }).models).toContain('gpt-6-luna');
  });

  it('falls back instead of silently truncating more than 100 eligible model IDs', async () => {
    await preferences.update({ providerId: 'openai', cloudDisclosureAccepted: ['openai'] });
    await secrets.set('openai', CANARY);
    const result = await handleAiMessage(
      { type: 'list-provider-models', providerId: 'openai' },
      {
        preferencesStore: preferences,
        secrets,
        localStorage: local,
        sessionStorage: session,
        permissions: { contains: vi.fn(async () => true) },
        fetchImpl: vi.fn(async () => new Response(JSON.stringify({ data: Array.from({ length: 101 }, (_, index) => ({ id: `gpt-6-${index}` })) }), { status: 200 })),
      },
    );
    expect(result).toMatchObject({ providerId: 'openai', source: 'fallback' });
  });
});
