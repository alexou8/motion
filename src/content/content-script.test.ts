import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('content-script request authentication', () => {
  let listener: (raw: unknown, sender: chrome.runtime.MessageSender, sendResponse: (response?: unknown) => void) => void;
  let connectListener: (port: chrome.runtime.Port) => void;

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    const addListener = vi.fn((candidate: typeof listener) => { listener = candidate; });
    const onConnectAddListener = vi.fn((candidate: typeof connectListener) => { connectListener = candidate; });
    vi.stubGlobal('chrome', {
      runtime: {
        id: 'motion-extension-id',
        onMessage: { addListener },
        onConnect: { addListener: onConnectAddListener },
        getManifest: vi.fn(() => ({ background: { service_worker: 'src/background/service-worker.js' } })),
        getURL: vi.fn((path: string) => `chrome-extension://motion-extension-id/${path}`),
        sendMessage: vi.fn(() => Promise.resolve()),
      },
    });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function loadListener(): Promise<void> {
    await import('./content-script');
  }

  it('drops a forged request from another extension', async () => {
    await loadListener();
    const sendResponse = vi.fn();

    listener({ type: 'motion:snapshot' }, { id: 'other-extension-id' }, sendResponse);

    expect(sendResponse).not.toHaveBeenCalled();
  });

  it('drops a request that carries a tab sender, even with Motion’s id', async () => {
    await loadListener();
    const sendResponse = vi.fn();

    listener(
      { type: 'motion:snapshot' },
      { id: 'motion-extension-id', tab: { id: 17, index: 0, windowId: 1 } as chrome.tabs.Tab },
      sendResponse,
    );

    expect(sendResponse).not.toHaveBeenCalled();
  });

  it('accepts a worker request from Motion without a tab sender', async () => {
    await loadListener();
    const sendResponse = vi.fn();

    listener({ type: 'motion:snapshot' }, { id: 'motion-extension-id' }, sendResponse);

    expect(sendResponse).toHaveBeenCalledWith(expect.objectContaining({ snapshotId: expect.any(String) }));
  });

  it('does not snapshot controls after navigation into an assessment attempt', async () => {
    document.body.innerHTML = '<input name="answer" />';
    vi.stubGlobal('location', new URL('https://school.brightspace.com/d2l/le/content/363/viewContent/12/View'));
    await loadListener();
    const sendResponse = vi.fn();
    const worker = { id: 'motion-extension-id' };

    listener({ type: 'motion:extract-content' }, worker, sendResponse);
    vi.stubGlobal('location', new URL('https://school.brightspace.com/d2l/lms/quizzing/user/attempt/201'));
    listener({ type: 'motion:snapshot' }, worker, sendResponse);

    // The restriction verdict and the capture are the same atomic call
    // (SOL-5): a restricted snapshot is marked `restricted` and never
    // exposes a captured element's label, so it cannot leak into a
    // provider prompt even if a caller ignored the flag.
    expect(sendResponse).toHaveBeenLastCalledWith(expect.objectContaining({
      restricted: true,
      elements: [],
    }));
  });

  it('rejects an extension-page actor request because actions only arrive over the worker port', async () => {
    document.body.innerHTML = '<button id="go">Go</button>';
    await loadListener();
    const sendResponse = vi.fn();
    listener({
      type: 'click', snapshotId: 'snap-missing', handle: 'e1',
    }, { id: 'motion-extension-id' }, sendResponse);
    expect((document.getElementById('go') as HTMLButtonElement).dataset.clicked).toBeUndefined();
    expect(sendResponse).not.toHaveBeenCalled();
  });

  function makePort(sender: unknown) {
    let messageListener: ((raw: unknown) => void) | undefined;
    let disconnectListener: (() => void) | undefined;
    const port = {
      name: 'motion-actor',
      sender: sender as chrome.runtime.MessageSender,
      disconnect: vi.fn(),
      postMessage: vi.fn(),
      onMessage: { addListener: vi.fn((candidate: (raw: unknown) => void) => { messageListener = candidate; }), removeListener: vi.fn(), hasListener: vi.fn() },
      onDisconnect: { addListener: vi.fn((candidate: () => void) => { disconnectListener = candidate; }), removeListener: vi.fn(), hasListener: vi.fn() },
      emitMessage(raw: unknown) { messageListener?.(raw); },
      emitDisconnect() { disconnectListener?.(); },
    } as unknown as chrome.runtime.Port & { emitMessage(raw: unknown): void; emitDisconnect(): void };
    return port;
  }

  it.each([
    ['side panel URL', { id: 'motion-extension-id', url: 'chrome-extension://motion-extension-id/src/sidepanel/index.html' }],
    ['options URL', { id: 'motion-extension-id', url: 'chrome-extension://motion-extension-id/src/options/index.html' }],
    ['missing sender URL', { id: 'motion-extension-id' }],
    ['foreign extension id', { id: 'other-extension-id', url: 'chrome-extension://other-extension-id/src/background/service-worker.js' }],
    ['tab sender', { id: 'motion-extension-id', url: 'chrome-extension://motion-extension-id/src/background/service-worker.js', tab: { id: 17 } }],
  ] as const)('rejects an actor port from %s', async (_label, sender) => {
    await loadListener();
    const port = makePort(sender);

    connectListener(port);

    expect(port.disconnect).toHaveBeenCalledTimes(1);
    expect(port.onMessage.addListener).not.toHaveBeenCalled();
  });

  it('accepts an actor port whose sender URL is the genuine service worker', async () => {
    await loadListener();
    const port = makePort({ id: 'motion-extension-id', url: 'chrome-extension://motion-extension-id/src/background/service-worker.js' });

    connectListener(port);

    expect(port.disconnect).not.toHaveBeenCalled();
    expect(port.onMessage.addListener).toHaveBeenCalledTimes(1);
    expect(port.onDisconnect.addListener).toHaveBeenCalledTimes(1);
  });

  it('cancels a suspended visual action when the authenticated worker port disconnects', async () => {
    const queuedFrames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      queuedFrames.push(callback);
      return queuedFrames.length;
    }));
    document.body.innerHTML = '<button id="go">Go</button>';
    let clicks = 0;
    document.getElementById('go')!.addEventListener('click', () => { clicks += 1; });
    await loadListener();
    const port = makePort({ id: 'motion-extension-id', url: 'chrome-extension://motion-extension-id/src/background/service-worker.js' });
    connectListener(port);
    const respond = vi.fn();
    listener({ type: 'motion:snapshot' }, { id: 'motion-extension-id' }, respond);
    const snapshot = respond.mock.calls[0]![0] as { snapshotId: string; elements: Array<{ handle: string }> };

    port.emitMessage({
      type: 'motion:act',
      requestId: '00000000-0000-4000-8000-000000000001',
      request: {
        type: 'click',
        snapshotId: snapshot.snapshotId,
        handle: snapshot.elements[0]!.handle,
        authorization: { nonce: '00000000-0000-4000-8000-000000000002' },
        showOnPagePointer: true,
      },
    });
    await Promise.resolve();
    expect(document.getElementById('motion-presence-root')).not.toBeNull();

    port.emitDisconnect();
    for (const frame of queuedFrames) frame(0);
    await vi.advanceTimersByTimeAsync(200);
    await Promise.resolve();

    expect(clicks).toBe(0);
    expect(port.postMessage).not.toHaveBeenCalled();
    expect(document.getElementById('motion-presence-root')).toBeNull();
  });
});
