import { describe, expect, it } from 'vitest';
import { attachInferenceHost, type PortLike } from './inferenceHost';
import type { AIProvider, GenerateRequest, ProviderAvailability, ProviderCapabilities } from '@/core/ai/types';
import { ProviderError } from '@/core/ai/types';

function fakePort(): PortLike & { emit(msg: unknown): void; sent: unknown[] } {
  const listeners: ((message: unknown) => void)[] = [];
  const sent: unknown[] = [];
  return {
    name: 'motion-inference',
    postMessage: (msg) => sent.push(msg),
    onMessage: {
      addListener: (fn) => listeners.push(fn),
      removeListener: (fn) => listeners.splice(listeners.indexOf(fn), 1),
    },
    onDisconnect: { addListener: () => {} },
    emit(msg) {
      for (const l of listeners) l(msg);
    },
    sent,
  };
}

function stubProvider(stream: (req: GenerateRequest) => AsyncIterable<string>): AIProvider {
  return {
    id: 'chrome-local',
    displayName: 'stub',
    async capabilities(): Promise<ProviderCapabilities> {
      return { streaming: true, cancellation: true, backgroundExecution: false, cloud: false, requiresKey: false, structuredOutput: false };
    },
    async availability(): Promise<ProviderAvailability> {
      return { status: 'available', message: '' };
    },
    async generate() {
      return '';
    },
    stream,
  };
}

async function flush() {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

describe('attachInferenceHost', () => {
  it('streams deltas then done for a generate frame', async () => {
    const provider = stubProvider(async function* () {
      yield 'a';
      yield 'b';
    });
    const port = fakePort();
    attachInferenceHost(port, provider);

    port.emit({ type: 'generate', requestId: 'r1', request: { system: 's', messages: [] } });
    await flush();

    expect(port.sent).toEqual([
      { type: 'delta', requestId: 'r1', text: 'a' },
      { type: 'delta', requestId: 'r1', text: 'b' },
      { type: 'done', requestId: 'r1' },
    ]);
  });

  it('sends an error frame when the provider throws, carrying no secret', async () => {
    const provider = stubProvider(async function* () {
      throw new ProviderError('invalid-key', 'Your OpenAI API key is no longer valid. Reconnect.');
    });
    const port = fakePort();
    attachInferenceHost(port, provider);
    port.emit({ type: 'generate', requestId: 'r1', request: { system: 's', messages: [] } });
    await flush();

    expect(port.sent).toEqual([{ type: 'error', requestId: 'r1', kind: 'invalid-key', message: 'Your OpenAI API key is no longer valid. Reconnect.' }]);
  });

  it('aborts the generation signal on a cancel frame', async () => {
    let sawAbort = false;
    const provider = stubProvider(async function* (req) {
      await new Promise<void>((resolve) => {
        req.signal?.addEventListener('abort', () => {
          sawAbort = true;
          resolve();
        });
      });
      // Nothing more yielded after abort.
    });
    const port = fakePort();
    attachInferenceHost(port, provider);
    port.emit({ type: 'generate', requestId: 'r1', request: { system: 's', messages: [] } });
    await flush();
    port.emit({ type: 'cancel', requestId: 'r1' });
    await flush();
    expect(sawAbort).toBe(true);
  });

  it('ignores a frame that fails schema validation instead of throwing', async () => {
    const provider = stubProvider(async function* () {
      yield 'x';
    });
    const port = fakePort();
    attachInferenceHost(port, provider);
    expect(() => port.emit({ type: 'not-a-real-type' })).not.toThrow();
  });
});
