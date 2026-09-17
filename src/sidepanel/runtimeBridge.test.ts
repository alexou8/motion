import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveLmsTab } from './runtimeBridge';

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
