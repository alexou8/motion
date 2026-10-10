import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A separate file because the observer registers page listeners at import:
 * each case loads a fresh module so one case's listeners cannot answer for
 * another's.
 */
describe('observer after the extension context is invalidated', () => {
  const D2L_URL = 'https://school.brightspace.com/d2l/le/content/363/home';

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    document.title = 'Synthetic module - TEST-101 - Synthetic Course';
    document.body.innerHTML = '<main><h1>Synthetic module</h1></main>';
    vi.stubGlobal('location', new URL(D2L_URL));
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function exercisePage(): Promise<void> {
    // Client-side navigation, a DOM settle, and a return to the tab: each of
    // these would report the page again on a live script.
    vi.stubGlobal('location', new URL('https://school.brightspace.com/d2l/le/content/363/viewContent/12/View'));
    await vi.advanceTimersByTimeAsync(1_500);
    document.body.append(document.createElement('p'));
    await vi.advanceTimersByTimeAsync(3_500);
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
  }

  it('stops watching once the runtime id is gone and sendMessage throws synchronously', async () => {
    const sendMessage = vi.fn(() => {
      throw new Error('Extension context invalidated.');
    });
    vi.stubGlobal('chrome', { runtime: { id: undefined, sendMessage } });
    const { initObserver } = await import('./observer');

    expect(() => initObserver()).not.toThrow();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);

    await exercisePage();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops watching when sendMessage reports an invalidated context even before the id clears', async () => {
    const sendMessage = vi.fn(() => {
      throw new Error('Extension context invalidated.');
    });
    vi.stubGlobal('chrome', { runtime: { id: 'motion-extension-id', sendMessage } });
    const { initObserver } = await import('./observer');

    initObserver();
    await exercisePage();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps watching when the worker is merely asleep', async () => {
    const sendMessage = vi.fn(() => Promise.reject(new Error('Could not establish connection. Receiving end does not exist.')));
    vi.stubGlobal('chrome', { runtime: { id: 'motion-extension-id', sendMessage } });
    const { initObserver } = await import('./observer');

    initObserver();
    await exercisePage();
    expect(sendMessage.mock.calls.length).toBeGreaterThan(1);
  });
});
