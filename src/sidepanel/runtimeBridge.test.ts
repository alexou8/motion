import { afterEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_PANEL_STATE } from '@/core/view';
import { createRuntimeBridge, resolveLmsTab, toUiCommandResult } from './runtimeBridge';
import { parseWorkerResult } from './responses';

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

it('refreshes saved coursework when an extraction finishes after its page observation', async () => {
  let currentState = EMPTY_PANEL_STATE;
  let storageListener: ((changes: Record<string, chrome.storage.StorageChange>) => void) | undefined;
  const chromeEvent = { addListener: vi.fn() };
  vi.stubGlobal('chrome', {
    runtime: { sendMessage: vi.fn(async () => ({ ok: true, result: currentState })) },
    tabs: { query: vi.fn(async () => []), onActivated: chromeEvent, onUpdated: chromeEvent },
    storage: { session: { onChanged: { addListener: vi.fn((listener) => { storageListener = listener; }) } } },
    permissions: { contains: vi.fn(async () => true) },
  });
  const bridge = createRuntimeBridge();
  let notifications = 0;
  bridge.subscribe(() => { notifications += 1; });
  await vi.waitFor(() => expect(notifications).toBe(1));
  currentState = { ...EMPTY_PANEL_STATE, courses: [{
    id: 'synthetic-course', platformId: 'd2l', name: 'Synthetic saved course',
    archived: false, lastVerifiedAt: '2026-10-02T12:00:00Z',
  }] };
  storageListener?.({ 'motion.courseworkRevision': { newValue: 'synthetic-revision' } });
  await vi.waitFor(() => expect(bridge.getState().courses[0]?.name).toBe('Synthetic saved course'));
  expect(notifications).toBe(2);
});

describe('worker command outcomes', () => {
  it('replaces an older worker command-list error with actionable refresh guidance', () => {
    const parseResult = vi.fn();
    const result = toUiCommandResult(
      {
        ok: false,
        error: "Malformed message: Invalid discriminator value. Expected 'synthetic-old-command'",
      },
      parseResult,
    );
    expect(result).toMatchObject({
      ok: false,
      code: 'extension-refresh-required',
      recoverable: true,
    });
    if (!result.ok) {
      expect(result.message).toMatch(/Reload Motion/);
      expect(result.message).toMatch(/refresh the course page/);
      expect(result.message).not.toContain('synthetic-old-command');
    }
    expect(parseResult).not.toHaveBeenCalled();
  });

  it('keeps a worker refusal distinct from a malformed transport response', () => {
    expect(toUiCommandResult({ ok: false, code: 'restricted-page', error: 'Motion will not act inside this assessment.' }))
      .toEqual({ ok: false, code: 'restricted-page', message: 'Motion will not act inside this assessment.' });
    expect(toUiCommandResult({ ok: 'yes' }))
      .toEqual(expect.objectContaining({ ok: false, code: 'transport-malformed-response' }));
  });

  it('rejects an unexpected success payload instead of pretending the command succeeded', () => {
    expect(toUiCommandResult({ ok: true, result: { value: 'wrong' } }, () => null))
      .toEqual(expect.objectContaining({ ok: false, code: 'transport-invalid-result' }));
  });

  it('keeps worker domain no-ops visible after a successful transport envelope', () => {
    expect(toUiCommandResult({ ok: true, result: { updated: false, reason: 'That workspace tab is no longer open.' } }))
      .toEqual({ ok: false, code: 'command-refused', message: 'That workspace tab is no longer open.' });
    expect(toUiCommandResult({ ok: true, result: { requested: false } }))
      .toEqual(expect.objectContaining({ ok: false, code: 'command-refused' }));
    expect(toUiCommandResult({ ok: true, result: { session: { id: 'old' }, refusal: { message: 'This session is archived.' } } }))
      .toEqual({ ok: false, code: 'command-refused', message: 'This session is archived.' });
  });

  it('accepts a deliberate session-list selection but rejects malformed selections', () => {
    expect(toUiCommandResult({ ok: true, result: { selected: null } })).toEqual({ ok: true });
    expect(parseWorkerResult('session-select', { selected: null })).toEqual({ selected: null });
    expect(parseWorkerResult('session-select', { selected: 9 })).toBeNull();
  });
});

describe('active-tab context and worker failures', () => {
  afterEach(() => vi.unstubAllGlobals());

  function stub({
    tab,
    granted = true,
    getState,
  }: {
    tab: Partial<chrome.tabs.Tab> | undefined;
    granted?: boolean;
    getState: () => unknown;
  }) {
    const chromeEvent = { addListener: vi.fn() };
    const reload = vi.fn(async () => undefined);
    const sendMessage = vi.fn(async (message: { type?: string }) =>
      message.type === 'get-state' ? getState() : { ok: true, result: { requested: true } },
    );
    vi.stubGlobal('chrome', {
      runtime: { sendMessage },
      tabs: {
        query: vi.fn(async () => (tab ? [tab] : [])),
        reload,
        onActivated: chromeEvent,
        onUpdated: chromeEvent,
      },
      storage: { session: { onChanged: { addListener: vi.fn() } } },
      permissions: { contains: vi.fn(async () => granted) },
    });
    return { reload, sendMessage };
  }

  it('keeps the active tab url when page permission is needed', async () => {
    stub({
      tab: { id: 4, url: 'https://synthetic.brightspace.com/d2l/home', title: 'Synthetic home' },
      granted: false,
      getState: () => ({ ok: true, result: EMPTY_PANEL_STATE }),
    });
    const bridge = createRuntimeBridge();
    await vi.waitFor(() => expect(bridge.getState().connection).toBe('permission-needed'));
    expect(bridge.getState().page.url).toBe('https://synthetic.brightspace.com/d2l/home');
  });

  it('flags a supported, permitted tab the worker has never observed as needing a reload', async () => {
    const { reload } = stub({
      tab: { id: 4, url: 'https://synthetic.brightspace.com/d2l/home' },
      getState: () => ({ ok: true, result: EMPTY_PANEL_STATE }),
    });
    const bridge = createRuntimeBridge();
    await vi.waitFor(() => expect(bridge.getState().tabNeedsReload).toBe(true));
    expect(bridge.getState().connection).toBe('idle');
    await expect(bridge.send({ type: 'reload-tab' })).resolves.toEqual({ ok: true });
    expect(reload).toHaveBeenCalledWith(4);
  });

  it('never offers or performs a reload inside a quiz attempt Motion has not observed', async () => {
    const { reload } = stub({
      tab: { id: 4, url: 'https://synthetic.brightspace.com/d2l/lms/quizzing/user/attempt/quiz_start_frame_auto.d2l?ou=999999&qi=7' },
      getState: () => ({ ok: true, result: EMPTY_PANEL_STATE }),
    });
    const bridge = createRuntimeBridge();
    await vi.waitFor(() => expect(bridge.getState().connection).toBe('restricted'));
    expect(bridge.getState().tabNeedsReload).toBeFalsy();
    expect(bridge.getState().page.restrictionReason).toBeTruthy();
    await expect(bridge.send({ type: 'reload-tab' })).resolves.toMatchObject({ ok: false, code: 'restricted' });
    expect(reload).not.toHaveBeenCalled();
  });

  it('does not ask to reload a tab Motion does not support', async () => {
    const { reload } = stub({
      tab: { id: 4, url: 'https://unrelated.example.test/' },
      getState: () => ({ ok: true, result: EMPTY_PANEL_STATE }),
    });
    const bridge = createRuntimeBridge();
    await vi.waitFor(() => expect(bridge.getState().connection).toBe('unsupported'));
    expect(bridge.getState().tabNeedsReload).toBeFalsy();
    await expect(bridge.send({ type: 'reload-tab' })).resolves.toMatchObject({ ok: false });
    expect(reload).not.toHaveBeenCalled();
  });

  it('surfaces a failed state read and clears it after a successful retry', async () => {
    let answer: unknown = { ok: false, error: 'The background worker did not respond.' };
    stub({ tab: undefined, getState: () => answer });
    const bridge = createRuntimeBridge();
    await vi.waitFor(() =>
      expect(bridge.getState().workerError).toBe('The background worker did not respond.'),
    );
    await expect(bridge.send({ type: 'refresh' })).resolves.toMatchObject({ ok: false });
    answer = { ok: true, result: EMPTY_PANEL_STATE };
    await expect(bridge.send({ type: 'refresh' })).resolves.toEqual({ ok: true });
    expect(bridge.getState().workerError).toBeUndefined();
  });
});

describe('content script missing', () => {
  it('turns the worker reason code into a readable, recoverable refusal', () => {
    expect(
      toUiCommandResult({
        ok: true,
        result: {
          requested: false,
          reason: 'content-script-missing',
          message: 'Reload this tab so Motion can read it.',
        },
      }),
    ).toEqual({
      ok: false,
      code: 'content-script-missing',
      message: 'Reload this tab so Motion can read it.',
      recoverable: true,
    });
    expect(
      toUiCommandResult({ ok: true, result: { requested: false, reason: 'content-script-missing' } }),
    ).toMatchObject({ code: 'content-script-missing', message: 'Reload this tab so Motion can read it.' });
  });
});
