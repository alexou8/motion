import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActRequest } from '@/core/actor/contracts';

const { connectActorPort } = vi.hoisted(() => ({ connectActorPort: vi.fn() }));
vi.mock('./actorChannel', () => ({ connectActorPort }));

import { actInContentScript, askContentScript, sendToContentScript } from './contentBridge';

type Listener = (...args: unknown[]) => void;

function port(options: { postMessage?: (message: unknown) => void } = {}) {
  const messages = new Set<Listener>();
  const disconnects = new Set<Listener>();
  return {
    onMessage: {
      addListener: (listener: Listener) => messages.add(listener),
      removeListener: (listener: Listener) => messages.delete(listener),
    },
    onDisconnect: {
      addListener: (listener: Listener) => disconnects.add(listener),
      removeListener: (listener: Listener) => disconnects.delete(listener),
    },
    postMessage: vi.fn((message: unknown) => options.postMessage?.(message)),
    disconnect: vi.fn(),
    emitMessage: (message: unknown) => [...messages].forEach((listener) => listener(message)),
    emitDisconnect: () => [...disconnects].forEach((listener) => listener()),
  };
}

const request: ActRequest = {
  type: 'fill',
  snapshotId: 'snapshot-1',
  handle: 'input-1',
  value: 'answer',
};

const success = { ok: true as const, evidence: {} };

beforeEach(() => {
  vi.stubGlobal('chrome', { tabs: { sendMessage: vi.fn() } });
  vi.useFakeTimers();
  connectActorPort.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('sendToContentScript', () => {
  it('retries until the content script responds', async () => {
    const sendMessage = chrome.tabs.sendMessage as ReturnType<typeof vi.fn>;
    sendMessage.mockRejectedValueOnce(new Error('not ready')).mockResolvedValueOnce({ ok: true });

    const pending = sendToContentScript(7, { type: 'motion:snapshot' });
    await vi.advanceTimersByTimeAsync(150);

    await expect(pending).resolves.toEqual({ ok: true });
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenLastCalledWith(7, { type: 'motion:snapshot' }, { frameId: 0 });
  });

  it('rejects after all bounded attempts fail', async () => {
    const error = new Error('missing content script');
    const sendMessage = chrome.tabs.sendMessage as ReturnType<typeof vi.fn>;
    sendMessage.mockRejectedValue(error);

    const pending = sendToContentScript(7, { type: 'motion:snapshot' });
    const assertion = expect(pending).rejects.toBe(error);
    await vi.advanceTimersByTimeAsync(300);

    await assertion;
    expect(sendMessage).toHaveBeenCalledTimes(3);
  });
});

describe('askContentScript', () => {
  it('returns null for an invalid observer response', async () => {
    (chrome.tabs.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
      content: { hostile: true },
    });
    await expect(askContentScript(7)).resolves.toBeNull();
  });
});

describe('actInContentScript', () => {
  it('returns a validated response and ignores a mismatched request id', async () => {
    const actorPort = port({
      postMessage: (message: unknown) => {
        const requestId = (message as { requestId: string }).requestId;
        actorPort.emitMessage({
          type: 'motion:act-result',
          requestId: crypto.randomUUID(),
          result: success,
        });
        actorPort.emitMessage({ type: 'motion:act-result', requestId, result: success });
      },
    });
    connectActorPort.mockReturnValue(actorPort);

    await expect(actInContentScript(7, request)).resolves.toEqual(success);
    expect(actorPort.disconnect).toHaveBeenCalledOnce();
  });

  it('returns null when the actor disconnects before responding', async () => {
    const actorPort = port({ postMessage: () => actorPort.emitDisconnect() });
    connectActorPort.mockReturnValue(actorPort);
    await expect(actInContentScript(7, request)).resolves.toBeNull();
  });

  it('times out and disconnects an actor that never responds', async () => {
    const actorPort = port();
    connectActorPort.mockReturnValue(actorPort);

    const pending = actInContentScript(7, request);
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(pending).resolves.toBeNull();
    expect(actorPort.disconnect).toHaveBeenCalledOnce();
  });

  it('returns null when posting to the actor port fails', async () => {
    const actorPort = port({
      postMessage: () => {
        throw new Error('closed');
      },
    });
    connectActorPort.mockReturnValue(actorPort);
    await expect(actInContentScript(7, request)).resolves.toBeNull();
  });

  it('returns null for an invalid actor response', async () => {
    const actorPort = port({
      postMessage: (message: unknown) => {
        const requestId = (message as { requestId: string }).requestId;
        actorPort.emitMessage({ type: 'motion:act-result', requestId, result: { ok: 'yes' } });
        actorPort.emitDisconnect();
      },
    });
    connectActorPort.mockReturnValue(actorPort);
    await expect(actInContentScript(7, request)).resolves.toBeNull();
  });
});
