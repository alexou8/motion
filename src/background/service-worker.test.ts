import { afterEach, describe, expect, it, vi } from 'vitest';

describe('service worker browser entry points', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('registers the toolbar action as an explicit side-panel trigger', async () => {
    const actionClicked = vi.fn();
    const open = vi.fn(async () => undefined);
    const event = () => ({ addListener: vi.fn() });

    vi.stubGlobal('chrome', {
      action: { onClicked: { addListener: actionClicked } },
      alarms: { onAlarm: event() },
      runtime: {
        id: 'test-extension-id',
        onInstalled: event(),
        onMessage: event(),
        onStartup: event(),
      },
      sidePanel: {
        open,
        setPanelBehavior: vi.fn(async () => undefined),
      },
      tabs: { onUpdated: event(), onRemoved: event() },
    });

    await import('./service-worker');

    expect(actionClicked).toHaveBeenCalledOnce();
    const handler = actionClicked.mock.calls[0]?.[0] as (tab: chrome.tabs.Tab) => void;
    handler({ windowId: 42 } as chrome.tabs.Tab);
    expect(open).toHaveBeenCalledWith({ windowId: 42 });
  });

  it('opens the panel even when grouping later fails', async () => {
    const actionClicked = vi.fn();
    const open = vi.fn(async () => undefined);
    const event = () => ({ addListener: vi.fn() });
    vi.stubGlobal('chrome', {
      action: { onClicked: { addListener: actionClicked } },
      alarms: { onAlarm: event() },
      runtime: { id: 'test-extension-id', onInstalled: event(), onMessage: event(), onStartup: event() },
      sidePanel: { open, setPanelBehavior: vi.fn(async () => undefined) },
      tabs: { onUpdated: event(), onRemoved: event() },
    });
    await import('./service-worker');
    const handler = actionClicked.mock.calls[0]?.[0] as (tab: chrome.tabs.Tab) => void;
    handler({ id: 1, url: 'https://mylearningspace.wlu.ca/d2l/home/999', windowId: 42 } as chrome.tabs.Tab);
    expect(open).toHaveBeenCalledWith({ windowId: 42 });
  });

  it('recovers the workflow named by an expired lease alarm', async () => {
    const event = () => ({ addListener: vi.fn() });
    vi.stubGlobal('chrome', {
      action: { onClicked: { addListener: vi.fn() } },
      alarms: { onAlarm: event() },
      runtime: { id: 'test-extension-id', onInstalled: event(), onMessage: event(), onStartup: event() },
      sidePanel: { open: vi.fn(async () => undefined), setPanelBehavior: vi.fn(async () => undefined) },
      tabs: { onUpdated: event(), onRemoved: event() },
    });
    const worker = await import('./service-worker');
    const recover = vi.fn(async () => undefined);

    worker.handleAlarm({ name: 'motion:lease:workflow-7' } as chrome.alarms.Alarm, recover);

    expect(recover).toHaveBeenCalledWith('workflow-7');
  });
});
