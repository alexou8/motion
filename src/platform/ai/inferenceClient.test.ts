import { afterEach, describe, expect, it, vi } from 'vitest';
import { InferenceClientProvider } from './inferenceClient';
import type { PortLike } from './inferenceHost';

function fakePort(): PortLike & { emit(msg: unknown): void; disconnect(): void; sent: unknown[] } {
  const listeners: ((message: unknown) => void)[] = [];
  const disconnectListeners: (() => void)[] = [];
  const sent: unknown[] = [];
  return {
    name: 'motion-inference',
    postMessage: (msg) => sent.push(msg),
    onMessage: {
      addListener: (fn) => listeners.push(fn),
      removeListener: (fn) => listeners.splice(listeners.indexOf(fn), 1),
    },
    onDisconnect: {
      addListener: (fn) => disconnectListeners.push(fn),
      removeListener: (fn) => disconnectListeners.splice(disconnectListeners.indexOf(fn), 1),
    },
    emit(msg) {
      for (const l of listeners) l(msg);
    },
    disconnect() {
      for (const l of [...disconnectListeners]) l();
    },
    sent,
  };
}

async function flush() {
  for (let i = 0; i < 4; i += 1) await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
});

describe('InferenceClientProvider', () => {
  it('asks the panel whether its model is available instead of assuming a port means ready', async () => {
    const port = fakePort();
    const provider = new InferenceClientProvider(() => port);
    const pending = provider.availability();
    await flush();
    const frame = port.sent[0] as { type: string; requestId: string };
    expect(frame.type).toBe('availability');
    port.emit({ type: 'availability', requestId: frame.requestId, status: 'downloadable', message: 'needs download' });
    await expect(pending).resolves.toEqual({ status: 'downloadable', message: 'needs download' });
  });

  it('reports unavailable when the panel never answers an availability request', async () => {
    vi.useFakeTimers();
    const provider = new InferenceClientProvider(() => fakePort(), 1_000);
    const pending = provider.availability();
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toMatchObject({ status: 'unavailable' });
  });

  it('reports needs-document-context when the panel disconnects during an availability request', async () => {
    const port = fakePort();
    const provider = new InferenceClientProvider(() => port);
    const pending = provider.availability();
    await flush();
    port.disconnect();
    await expect(pending).resolves.toMatchObject({ status: 'needs-document-context' });
  });

  it('fails a stream with needs-document-context instead of hanging when the panel disconnects mid-stream', async () => {
    const port = fakePort();
    const provider = new InferenceClientProvider(() => port);
    const chunks: string[] = [];
    const consume = (async () => {
      for await (const delta of provider.stream({ system: 's', messages: [] })) chunks.push(delta);
    })();
    const settled = consume.then(() => null, (error) => error);
    await flush();
    const requestId = (port.sent[0] as { requestId: string }).requestId;
    port.emit({ type: 'delta', requestId, text: 'partial' });
    await flush();
    port.disconnect();
    await expect(settled).resolves.toMatchObject({ kind: 'needs-document-context' });
    expect(chunks).toEqual(['partial']);
  });

  it('fails a stream cleanly when the port is already closed at send time', async () => {
    const port = fakePort();
    port.postMessage = () => { throw new Error('Attempting to use a disconnected port object'); };
    const provider = new InferenceClientProvider(() => port);
    const iterator = provider.stream({ system: 's', messages: [] })[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toMatchObject({ kind: 'needs-document-context' });
  });

  it('reports needs-document-context with no port connected', async () => {
    const provider = new InferenceClientProvider(() => null);
    const availability = await provider.availability();
    expect(availability).toEqual({ status: 'needs-document-context', message: 'Open Motion to continue with Chrome’s on-device AI.' });
  });

  it('throws needs-document-context from stream() with no port', async () => {
    const provider = new InferenceClientProvider(() => null);
    const iterator = provider.stream({ system: 's', messages: [] })[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toMatchObject({ kind: 'needs-document-context' });
  });

  it('sends a generate frame and yields deltas from the host, then completes on done', async () => {
    const port = fakePort();
    const provider = new InferenceClientProvider(() => port);

    const chunks: string[] = [];
    const consume = (async () => {
      for await (const delta of provider.stream({ system: 's', messages: [{ role: 'user', content: 'hi' }] })) {
        chunks.push(delta);
      }
    })();

    await flush();
    const generateFrame = port.sent[0] as { type: string; requestId: string; request: { system: string } };
    expect(generateFrame.type).toBe('generate');
    expect(generateFrame.request.system).toBe('s');

    port.emit({ type: 'delta', requestId: generateFrame.requestId, text: 'one' });
    port.emit({ type: 'delta', requestId: generateFrame.requestId, text: 'two' });
    port.emit({ type: 'done', requestId: generateFrame.requestId });
    await consume;

    expect(chunks).toEqual(['one', 'two']);
  });

  it('rejects when the host sends an error frame', async () => {
    const port = fakePort();
    const provider = new InferenceClientProvider(() => port);
    const iterator = provider.stream({ system: 's', messages: [] })[Symbol.asyncIterator]();
    const pending = iterator.next();
    await flush();
    const requestId = (port.sent[0] as { requestId: string }).requestId;
    port.emit({ type: 'error', requestId, kind: 'unavailable', message: 'no model' });
    await expect(pending).rejects.toMatchObject({ kind: 'unavailable', message: 'no model' });
  });

  it('sends a cancel frame and stops when the request is aborted mid-stream', async () => {
    const port = fakePort();
    const provider = new InferenceClientProvider(() => port);
    const controller = new AbortController();

    const chunks: string[] = [];
    const consume = (async () => {
      try {
        for await (const delta of provider.stream({ system: 's', messages: [], signal: controller.signal })) {
          chunks.push(delta);
        }
      } catch {
        // expected once aborted
      }
    })();

    await flush();
    const requestId = (port.sent[0] as { requestId: string }).requestId;
    port.emit({ type: 'delta', requestId, text: 'partial' });
    await flush();
    controller.abort();
    await consume;

    const cancelFrame = port.sent.find((m) => (m as { type: string }).type === 'cancel');
    expect(cancelFrame).toEqual({ type: 'cancel', requestId });
    expect(chunks).toEqual(['partial']);
  });

  it('ignores frames for a different requestId', async () => {
    const port = fakePort();
    const provider = new InferenceClientProvider(() => port);
    const chunks: string[] = [];
    const consume = (async () => {
      for await (const delta of provider.stream({ system: 's', messages: [] })) chunks.push(delta);
    })();
    await flush();
    const requestId = (port.sent[0] as { requestId: string }).requestId;
    port.emit({ type: 'delta', requestId: 'someone-elses-request', text: 'nope' });
    port.emit({ type: 'delta', requestId, text: 'mine' });
    port.emit({ type: 'done', requestId });
    await consume;
    expect(chunks).toEqual(['mine']);
  });
});
