import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { warn } from './log';

const CANARY = 'sk-test-CANARY1234567890';
let session: Record<string, unknown>;

beforeEach(() => {
  session = { 'motion.secret.openai': CANARY };
  vi.stubGlobal('chrome', {
    storage: {
      session: {
        get: vi.fn(async (key: string) => ({ [key]: session[key] })),
        set: vi.fn(async (values: Record<string, unknown>) => Object.assign(session, values)),
        remove: vi.fn(async (key: string) => { delete session[key]; }),
        setAccessLevel: vi.fn(async () => undefined),
      },
    },
  });
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('redacted worker logging', () => {
  it('does not emit a known secret', async () => {
    await warn('provider request failed', new Error(`provider echoed ${CANARY}`));
    const output = vi.mocked(console.warn).mock.calls.flat().join(' ');
    expect(output).not.toContain(CANARY);
    expect(output).toContain('[redacted]');
  });

  it('redacts provider-shaped keys even when session storage is empty', async () => {
    session = {};
    await warn('provider request failed', new Error('Bearer sk-test-OTHER1234567890'));
    const output = vi.mocked(console.warn).mock.calls.flat().join(' ');
    expect(output).not.toContain('sk-test-OTHER1234567890');
    expect(output).toContain('[redacted]');
  });
});
