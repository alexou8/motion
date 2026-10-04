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
      permissions: { onRemoved: event() },
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
      permissions: { onRemoved: event() },
      runtime: { id: 'test-extension-id', onInstalled: event(), onMessage: event(), onStartup: event() },
      sidePanel: { open: vi.fn(async () => undefined), setPanelBehavior: vi.fn(async () => undefined) },
      tabs: { onUpdated: event(), onRemoved: event() },
    });
    const worker = await import('./service-worker');
    const recover = vi.fn(async () => undefined);

    worker.handleAlarm({ name: 'motion:lease:workflow-7' } as chrome.alarms.Alarm, recover);

    expect(recover).toHaveBeenCalledWith('workflow-7');
  });

  it('stops active cloud requests when browser permission is revoked, retaining local inference', async () => {
    const event = () => ({ addListener: vi.fn() });
    const removed = event();
    vi.stubGlobal('chrome', {
      alarms: { onAlarm: event() },
      permissions: { onRemoved: removed },
      runtime: { id: 'test-extension-id', onInstalled: event(), onMessage: event(), onStartup: event() },
      tabs: { onUpdated: event(), onRemoved: event() },
    });
    const registry = await import('./cloudRequests');
    const cloud = registry.registerCloudRequest('cloud', 'openai');
    const local = registry.registerCloudRequest('local', 'chrome-local');
    await import('./service-worker');

    const onRemoved = removed.addListener.mock.calls[0]?.[0] as (() => void);
    onRemoved();

    expect(cloud.signal.aborted).toBe(true);
    expect(local.signal.aborted).toBe(false);
    registry.releaseCloudRequest('cloud', cloud);
    registry.releaseCloudRequest('local', local);
  });
});
