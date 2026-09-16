import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('content-script request authentication', () => {
  let listener: (raw: unknown, sender: chrome.runtime.MessageSender, sendResponse: (response?: unknown) => void) => void;

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    const addListener = vi.fn((candidate: typeof listener) => {
      listener = candidate;
    });
    vi.stubGlobal('chrome', {
      runtime: {
        id: 'motion-extension-id',
        onMessage: { addListener },
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
});
