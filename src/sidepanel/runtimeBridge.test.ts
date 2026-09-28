import { afterEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_PANEL_STATE } from '@/core/view';
import { createRuntimeBridge, resolveLmsTab } from './runtimeBridge';

/**
 * Regression coverage for the "Scan all courses" tab-resolution bug: at click
 * time the side panel's own extension page is briefly the "active" tab, so a
 * naive `chrome.tabs.query({ active: true, currentWindow: true })` resolved
 * the panel itself instead of the LMS tab (docs: SOL-9 follow-up).
 */
describe('resolveLmsTab', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubChrome(activeTab: Partial<chrome.tabs.Tab> | undefined, windowTabs: Partial<chrome.tabs.Tab>[]) {
    vi.stubGlobal('chrome', {
      tabs: {
        query: vi.fn(async (opts: { active?: boolean }) => {
          if (opts.active) return activeTab ? [activeTab] : [];
          return windowTabs;
        }),
      },
    });
  }

  it('returns the active tab when it is a real http(s) page', async () => {
    stubChrome({ id: 1, url: 'https://mylearningspace.wlu.ca/d2l/home' }, []);
    const tab = await resolveLmsTab();
    expect(tab?.id).toBe(1);
  });

  it('falls back to the most recently accessed qualifying tab when the active tab is the panel itself', async () => {
    stubChrome(
      { id: 1, url: 'chrome-extension://abc/src/sidepanel/index.html' },
      [
        { id: 1, url: 'chrome-extension://abc/src/sidepanel/index.html', lastAccessed: 500 },
        { id: 2, url: 'https://mylearningspace.wlu.ca/d2l/home', lastAccessed: 100 },
        { id: 3, url: 'https://mylearningspace.wlu.ca/d2l/le/content', lastAccessed: 300 },
      ],
    );
    const tab = await resolveLmsTab();
    expect(tab?.id).toBe(3);
  });

  it('returns null when no tab in the window qualifies', async () => {
    stubChrome(
      { id: 1, url: 'chrome-extension://abc/src/sidepanel/index.html' },
      [
        { id: 1, url: 'chrome-extension://abc/src/sidepanel/index.html', lastAccessed: 500 },
        { id: 2, url: 'chrome://extensions', lastAccessed: 100 },
      ],
    );
    const tab = await resolveLmsTab();
    expect(tab).toBeNull();
  });
});

it('publishes streaming storage changes while a session message is still pending', async () => {
  let currentState = EMPTY_PANEL_STATE;
  let storageListener: ((changes: Record<string, chrome.storage.StorageChange>) => void) | undefined;
  let releaseMessage!: (value: unknown) => void;
  const messagePending = new Promise<unknown>((resolve) => { releaseMessage = resolve; });
  const sendMessage = vi.fn((message: { type?: string }) => message.type === 'get-state'
    ? Promise.resolve({ ok: true, result: currentState })
    : messagePending);
  const chromeEvent = { addListener: vi.fn() };
  vi.stubGlobal('chrome', {
    runtime: { sendMessage },
    tabs: { query: vi.fn(async () => []), onActivated: chromeEvent, onUpdated: chromeEvent },
    storage: {
      session: {
        onChanged: { addListener: vi.fn((listener) => { storageListener = listener; }) },
      },
    },
    permissions: { contains: vi.fn(async () => true) },
  });

  const bridge = createRuntimeBridge();
  let notifications = 0;
  bridge.subscribe(() => { notifications += 1; });
  await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledWith({ type: 'get-state' }));
  await vi.waitFor(() => expect(notifications).toBeGreaterThan(0));

  let commandFinished = false;
  const command = Promise.resolve(bridge.send({ type: 'session-message', sessionId: 'session-1', text: 'Continue', tabId: null }))
    .then(() => { commandFinished = true; });
  await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'session-message' })));

  currentState = { ...currentState, streaming: { sessionId: 'session-1', text: 'Motion is replying' } };
  storageListener?.({ 'motion.streaming': { oldValue: undefined, newValue: { sessionId: 'session-1', text: 'Motion is replying' } } });

  await vi.waitFor(() => expect(bridge.getState().streaming?.text).toBe('Motion is replying'));
  expect(commandFinished).toBe(false);
  expect(notifications).toBeGreaterThan(1);

  const stateReads = () => sendMessage.mock.calls.filter(([message]) => message.type === 'get-state').length;
  const readsBeforeSelection = stateReads();
  storageListener?.({ 'motion.activeSessionId': { oldValue: null, newValue: 'session-1' } });
  await vi.waitFor(() => expect(stateReads()).toBeGreaterThan(readsBeforeSelection));

  releaseMessage({ ok: true, result: null });
  await command;
});

it('does not let an older state read overwrite a newer streaming snapshot', async () => {
  let releaseOldRead!: (value: unknown) => void;
  const oldRead = new Promise<unknown>((resolve) => { releaseOldRead = resolve; });
  let storageListener: ((changes: Record<string, chrome.storage.StorageChange>) => void) | undefined;
  const latestState = { ...EMPTY_PANEL_STATE, streaming: { sessionId: 'session-1', text: 'Current reply' } };
  let stateReads = 0;
  const sendMessage = vi.fn((message: { type?: string }) => {
    if (message.type !== 'get-state') return Promise.resolve({ ok: true, result: null });
    stateReads += 1;
    return stateReads === 1
      ? oldRead
      : Promise.resolve({ ok: true, result: latestState });
  });
  const chromeEvent = { addListener: vi.fn() };
  vi.stubGlobal('chrome', {
    runtime: { sendMessage },
    tabs: { query: vi.fn(async () => []), onActivated: chromeEvent, onUpdated: chromeEvent },
    storage: { session: { onChanged: { addListener: vi.fn((listener) => { storageListener = listener; }) } } },
    permissions: { contains: vi.fn(async () => true) },
  });

  const bridge = createRuntimeBridge();
  await vi.waitFor(() => expect(stateReads).toBe(1));
  storageListener?.({ 'motion.streaming': { oldValue: undefined, newValue: latestState.streaming } });
  await vi.waitFor(() => expect(bridge.getState().streaming?.text).toBe('Current reply'));

  releaseOldRead({ ok: true, result: EMPTY_PANEL_STATE });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(bridge.getState().streaming?.text).toBe('Current reply');
});
