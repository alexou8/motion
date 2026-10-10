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

  it('logs a failed alarm recovery instead of leaving an unhandled rejection', async () => {
    const event = () => ({ addListener: vi.fn() });
    vi.stubGlobal('chrome', {
      alarms: { onAlarm: event() },
      permissions: { onRemoved: event() },
      runtime: { id: 'test-extension-id', onInstalled: event(), onMessage: event(), onStartup: event() },
      tabs: { onUpdated: event(), onRemoved: event() },
    });
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const worker = await import('./service-worker');

    worker.handleAlarm({ name: 'motion:retry:workflow-8' } as chrome.alarms.Alarm, async () => {
      throw new Error('Synthetic recovery failure');
    });
    await vi.waitFor(() => expect(consoleWarn).toHaveBeenCalledWith(expect.stringContaining('Synthetic recovery failure')));
    consoleWarn.mockRestore();
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

  it('opens first-run settings on install and recovers in-flight model requests on update', async () => {
    const event = () => ({ addListener: vi.fn() });
    const installed = event();
    const openOptionsPage = vi.fn(async () => undefined);
    const recoverStaleModelRequests = vi.fn(async () => undefined);
    const recoverWorkflows = vi.fn(async () => undefined);
    vi.doMock('./sessions', () => ({ recoverStaleModelRequests }));
    vi.doMock('./recovery', async (importOriginal) => ({
      ...(await importOriginal<typeof import('./recovery')>()),
      recoverWorkflows,
    }));
    vi.doMock('./reminders', () => ({
      reconcileReminders: vi.fn(async () => ({ scheduled: 0, cleared: 0 })),
      registerReminderListeners: vi.fn(),
    }));
    vi.stubGlobal('chrome', {
      alarms: { onAlarm: event() },
      permissions: { onRemoved: event() },
      runtime: { id: 'test-extension-id', onInstalled: installed, onMessage: event(), onStartup: event(), openOptionsPage },
      tabs: { onUpdated: event(), onRemoved: event() },
    });
    await import('./service-worker');
    const onInstalled = installed.addListener.mock.calls[0]?.[0] as (details: { reason: string }) => void;

    onInstalled({ reason: 'install' });
    expect(openOptionsPage).toHaveBeenCalledOnce();
    expect(recoverStaleModelRequests).not.toHaveBeenCalled();

    onInstalled({ reason: 'update' });
    expect(openOptionsPage).toHaveBeenCalledOnce();
    expect(recoverWorkflows).toHaveBeenCalledOnce();
    expect(recoverStaleModelRequests).toHaveBeenCalledOnce();
    vi.doUnmock('./sessions');
    vi.doUnmock('./recovery');
    vi.doUnmock('./reminders');
  });
});
