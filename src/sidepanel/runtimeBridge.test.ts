import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveLmsTab, toUiCommandResult } from './runtimeBridge';
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

describe('worker command outcomes', () => {
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
