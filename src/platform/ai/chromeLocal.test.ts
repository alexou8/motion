import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChromeLocalProvider } from './chromeLocal';

function setGlobalLanguageModel(value: unknown) {
  (globalThis as unknown as { LanguageModel?: unknown }).LanguageModel = value;
}

afterEach(() => {
  delete (globalThis as unknown as { LanguageModel?: unknown }).LanguageModel;
  vi.restoreAllMocks();
});

describe('ChromeLocalProvider.availability', () => {
  it('maps unavailable when LanguageModel is undefined (e.g. Brave), without throwing', async () => {
    setGlobalLanguageModel(undefined);
    const provider = new ChromeLocalProvider();
    await expect(provider.availability()).resolves.toEqual({
      status: 'unavailable',
      message: 'This browser does not have an on-device model available.',
    });
  });

  it('maps each Chrome availability state honestly', async () => {
    for (const [state, status] of [
      ['available', 'available'],
      ['downloadable', 'downloadable'],
      ['downloading', 'downloading'],
      ['unavailable', 'unavailable'],
    ] as const) {
      setGlobalLanguageModel({ availability: vi.fn().mockResolvedValue(state), create: vi.fn() });
      const provider = new ChromeLocalProvider();
      const result = await provider.availability();
      expect(result.status).toBe(status);
    }
  });

  it('treats a hanging availability() call as unavailable rather than waiting forever', async () => {
    vi.useFakeTimers();
    setGlobalLanguageModel({ availability: () => new Promise(() => {}), create: vi.fn() });
    const provider = new ChromeLocalProvider(50);
    const pending = provider.availability();
    await vi.advanceTimersByTimeAsync(60);
    await expect(pending).resolves.toEqual({
      status: 'unavailable',
      message: 'Chrome’s on-device AI did not respond in this browser.',
    });
    vi.useRealTimers();
  });

  it('never throws when availability() itself rejects', async () => {
    setGlobalLanguageModel({ availability: vi.fn().mockRejectedValue(new Error('boom')), create: vi.fn() });
    const provider = new ChromeLocalProvider();
    await expect(provider.availability()).resolves.toEqual({
      status: 'unavailable',
      message: 'This browser does not have an on-device model available.',
    });
  });
});

describe('ChromeLocalProvider generate/stream', () => {
  it('generates using a session built from system + prior messages, prompting with the last one', async () => {
    const prompt = vi.fn().mockResolvedValue('an answer');
    const destroy = vi.fn();
    const create = vi.fn().mockResolvedValue({ prompt, promptStreaming: vi.fn(), destroy });
    setGlobalLanguageModel({ availability: vi.fn(), create });

    const provider = new ChromeLocalProvider();
    const result = await provider.generate({
      system: 'sys',
      messages: [
        { role: 'user', content: 'first' },
        { role: 'user', content: 'second' },
      ],
    });

    expect(result).toBe('an answer');
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        initialPrompts: [
          { role: 'system', content: 'sys' },
          { role: 'user', content: 'first' },
        ],
      }),
    );
    expect(prompt).toHaveBeenCalledWith('second', {});
    expect(destroy).toHaveBeenCalled();
  });

  it('destroys the session even when prompting throws', async () => {
    const destroy = vi.fn();
    const create = vi.fn().mockResolvedValue({ prompt: vi.fn().mockRejectedValue(new Error('x')), promptStreaming: vi.fn(), destroy });
    setGlobalLanguageModel({ availability: vi.fn(), create });
    const provider = new ChromeLocalProvider();
    await expect(provider.generate({ system: 's', messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow();
    expect(destroy).toHaveBeenCalled();
  });

  it('treats a hanging create() as unavailable rather than hanging the caller', async () => {
    vi.useFakeTimers();
    setGlobalLanguageModel({ availability: vi.fn(), create: () => new Promise(() => {}) });
    const provider = new ChromeLocalProvider(50);
    const pending = provider.generate({ system: 's', messages: [{ role: 'user', content: 'hi' }] });
    const assertion = expect(pending).rejects.toMatchObject({ kind: 'unavailable' });
    await vi.advanceTimersByTimeAsync(60);
    await assertion;
    vi.useRealTimers();
  });
});
