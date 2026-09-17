import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkerChromeLocalProvider } from './chromeLocalWorker';
import type { PortLike } from './inferenceHost';

function setGlobalLanguageModel(value: unknown) {
  (globalThis as unknown as { LanguageModel?: unknown }).LanguageModel = value;
}

afterEach(() => {
  delete (globalThis as unknown as { LanguageModel?: unknown }).LanguageModel;
});

function fakePort(): PortLike & { emit(msg: unknown): void } {
  const listeners: ((message: unknown) => void)[] = [];
  return {
    name: 'motion-inference',
    postMessage: vi.fn((msg: unknown) => {
      // Auto-respond to a generate frame with one delta + done, as a stand-in host would.
      const frame = msg as { type: string; requestId: string };
      if (frame.type === 'generate') {
        queueMicrotask(() => {
          for (const l of listeners) l({ type: 'delta', requestId: frame.requestId, text: 'via-port' });
          for (const l of listeners) l({ type: 'done', requestId: frame.requestId });
        });
      }
    }),
    onMessage: {
      addListener: (fn) => listeners.push(fn),
      removeListener: (fn) => listeners.splice(listeners.indexOf(fn), 1),
    },
    onDisconnect: { addListener: () => {} },
    emit(msg) {
      for (const l of listeners) l(msg);
    },
  };
}

describe('WorkerChromeLocalProvider', () => {
  it('prefers a connected panel port when one exists', async () => {
    const port = fakePort();
    setGlobalLanguageModel({ availability: vi.fn().mockResolvedValue('available'), create: vi.fn() });
    const provider = new WorkerChromeLocalProvider(() => port);
    const availability = await provider.availability();
    expect(availability.status).toBe('available');
    const result = await provider.generate({ system: 's', messages: [{ role: 'user', content: 'hi' }] });
    expect(result).toBe('via-port');
  });

  it('runs in-context when no port is connected and the Prompt API answers available', async () => {
    const prompt = vi.fn().mockResolvedValue('in-context answer');
    setGlobalLanguageModel({
      availability: vi.fn().mockResolvedValue('available'),
      create: vi.fn().mockResolvedValue({ prompt, promptStreaming: vi.fn(), destroy: vi.fn() }),
    });
    const provider = new WorkerChromeLocalProvider(() => null);
    expect((await provider.availability()).status).toBe('available');
    const result = await provider.generate({ system: 's', messages: [{ role: 'user', content: 'hi' }] });
    expect(result).toBe('in-context answer');
  });

  it('reports needs-document-context when neither a port nor the in-context API is present', async () => {
    setGlobalLanguageModel(undefined);
    const provider = new WorkerChromeLocalProvider(() => null);
    const availability = await provider.availability();
    expect(availability.status).toBe('needs-document-context');
  });

  it('computes backgroundExecution=true only when in-context inference actually works', async () => {
    setGlobalLanguageModel({ availability: vi.fn().mockResolvedValue('available'), create: vi.fn() });
    const withApi = new WorkerChromeLocalProvider(() => null);
    expect((await withApi.capabilities()).backgroundExecution).toBe(true);

    setGlobalLanguageModel(undefined);
    const withoutApi = new WorkerChromeLocalProvider(() => null);
    expect((await withoutApi.capabilities()).backgroundExecution).toBe(false);
  });

  it('surfaces the real in-context status (e.g. downloadable) when no port is connected', async () => {
    setGlobalLanguageModel({ availability: vi.fn().mockResolvedValue('downloadable'), create: vi.fn() });
    const provider = new WorkerChromeLocalProvider(() => null);
    const availability = await provider.availability();
    expect(availability.status).toBe('downloadable');
  });
});
