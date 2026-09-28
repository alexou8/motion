import { afterEach, describe, expect, it, vi } from 'vitest';

describe('service worker browser entry points', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('does not mutate workspaces from the toolbar action when the popup is declared', async () => {
    const actionClicked = vi.fn();
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
      sidePanel: { open: vi.fn(async () => undefined), setPanelBehavior: vi.fn(async () => undefined) },
      tabs: { onUpdated: event(), onRemoved: event() },
    });

    await import('./service-worker');

    expect(actionClicked).not.toHaveBeenCalled();
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
