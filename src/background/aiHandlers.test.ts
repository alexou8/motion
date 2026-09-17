import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_AI_PREFERENCES } from '@/core/ai/preferences';
import { ChromePreferencesStore } from '@/platform/ai/preferencesStore';
import { SessionSecretStore, type StorageArea } from '@/platform/ai/secrets';
import { aiStatusResultSchema } from '@/core/messaging/sessionContracts';
import { handleAiMessage } from './aiHandlers';

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

afterEach(() => vi.unstubAllGlobals());

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

  it('deletes the database, motion local keys, and all session keys while keeping unrelated local data', async () => {
    local.values['motion.preferences'] = DEFAULT_AI_PREFERENCES;
    local.values['motion.other'] = 'synthetic';
    local.values['unrelated'] = 'keep';
    session.values['motion.secret.openai'] = CANARY;
    session.values['other-session'] = 'remove';
    const deleteDb = vi.fn(async () => undefined);

    const result = await handleAiMessage(
      { type: 'delete-local-data', confirm: 'DELETE' },
      { preferencesStore: preferences, secrets, localStorage: local, sessionStorage: session, deleteDatabase: deleteDb },
    );

    expect(result).toEqual({ deleted: true });
    expect(deleteDb).toHaveBeenCalledOnce();
    expect(local.values).toEqual({ unrelated: 'keep' });
    expect(session.values).toEqual({});
  });

  it('runs provider health checks and returns an honest result without echoing the key', async () => {
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
});
