import { describe, expect, it, vi } from 'vitest';
import type { CourseTask } from '@/core/domain';
import { DEFAULT_REMINDER_PREFERENCES, REMINDER_PREFERENCES_KEY, type ReminderStorageArea } from '@/core/reminders';
import { DEFERRED_REMINDERS_KEY, handleReminderAlarm, REMINDER_ALARM_PREFIX, reconcileReminders, type ReminderAlarms, type ReminderNotifications, type ReminderSchedulerDeps } from './reminders';

const dueIso = '2026-09-20T16:00:00.000Z';
const now = new Date('2026-09-18T12:00:00.000Z');

function task(status: CourseTask['status'] = 'todo'): CourseTask {
  return {
    id: 'task-1',
    courseId: 'course-1',
    title: 'Assignment 1',
    kind: 'assignment',
    due: { iso: dueIso, raw: dueIso, zoneEvidence: 'explicit', timeAssumed: false, confidence: 'high' },
    dueHistory: [],
    dueConflict: null,
    status,
    weight: null,
    provenance: {
      sourceUrl: 'https://mylearningspace.wlu.ca/d2l/home/1',
      pageTitle: 'Synthetic course page',
      platformId: 'd2l',
      pageType: 'assignment',
      capturedAt: now.toISOString(),
      extractionVersion: 1,
      strategy: 'test-fixture',
    },
    corrections: [],
    studentEdited: false,
    manual: false,
    archived: false,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

function taskWith(overrides: Partial<CourseTask>): CourseTask {
  return { ...task(), ...overrides, due: { ...task().due, ...(overrides.due ?? {}) } };
}

function setup(tasks: CourseTask[]) {
  const values: Record<string, unknown> = {
    [REMINDER_PREFERENCES_KEY]: { ...DEFAULT_REMINDER_PREFERENCES, enabled: true },
  };
  const storage: ReminderStorageArea = {
    get: vi.fn(async (key: string) => ({ [key]: values[key] })),
    set: vi.fn(async (items: Record<string, unknown>) => { Object.assign(values, items); }),
  };
  const alarms = {
    getAll: vi.fn(async () => [{ name: 'motion:retry:workflow-1', scheduledTime: 0 }, { name: `${REMINDER_ALARM_PREFIX}stale`, scheduledTime: 0 }]),
    create: vi.fn(async () => undefined),
    clear: vi.fn(async () => true),
  } satisfies ReminderAlarms;
  const notifications = { create: vi.fn(async () => 'notification-1') } satisfies ReminderNotifications;
  const deps: ReminderSchedulerDeps = {
    alarms,
    notifications,
    storage,
    getTasks: vi.fn(async () => tasks),
    now: () => now,
    timeZone: () => 'America/Toronto',
    hasRestrictedContext: async () => false,
  };
  return { deps, alarms, notifications, storage };
}

describe('reminder scheduler', () => {
  it('clears stale reminder alarms, preserves workflow alarms, and caps future work', async () => {
    const { deps, alarms } = setup([task()]);
    const result = await reconcileReminders(deps);
    expect(alarms.clear).toHaveBeenCalledWith(`${REMINDER_ALARM_PREFIX}stale`);
    expect(alarms.clear).not.toHaveBeenCalledWith('motion:retry:workflow-1');
    expect(alarms.create).toHaveBeenCalledWith(
      `${REMINDER_ALARM_PREFIX}task-1:2d:${dueIso}`,
      { when: new Date('2026-09-18T16:00:00.000Z').getTime() },
    );
    expect(result.scheduled).toBe(3);
  });

  it('re-checks submission state before creating a notification', async () => {
    const { deps, notifications } = setup([task('submitted')]);
    const fired = await handleReminderAlarm(
      { name: `${REMINDER_ALARM_PREFIX}task-1:2d:${dueIso}` },
      deps,
    );
    expect(fired).toBe(false);
    expect(notifications.create).not.toHaveBeenCalled();
  });

  it('records a sent reminder and shows it only once', async () => {
    const { deps, notifications, storage } = setup([task()]);
    deps.now = () => new Date('2026-09-18T17:00:00.000Z');
    const alarm = { name: `${REMINDER_ALARM_PREFIX}task-1:2d:${dueIso}` };
    expect(await handleReminderAlarm(alarm, deps)).toBe(true);
    expect(await handleReminderAlarm(alarm, deps)).toBe(false);
    expect(notifications.create).toHaveBeenCalledOnce();
    expect(storage.set).toHaveBeenCalledWith(expect.objectContaining({ 'motion.reminders.sent': expect.any(Object) }));
  });

  it('suppresses delivery in a restricted tab and delivers after the tab is safe', async () => {
    const { deps, notifications } = setup([task()]);
    let restricted = true;
    deps.hasRestrictedContext = async () => restricted;
    deps.now = () => new Date('2026-09-18T16:00:00.000Z');
    const alarm = { name: `${REMINDER_ALARM_PREFIX}task-1:2d:${dueIso}` };

    expect(await handleReminderAlarm(alarm, deps)).toBe(false);
    expect(notifications.create).not.toHaveBeenCalled();

    restricted = false;
    deps.now = () => new Date('2026-09-18T17:00:00.000Z');
    expect(await handleReminderAlarm(alarm, deps)).toBe(true);
    expect(notifications.create).toHaveBeenCalledOnce();
  });

  it('keeps a suppressed retry in a stateful alarm set during reconcile', async () => {
    const values: Record<string, unknown> = { [REMINDER_PREFERENCES_KEY]: { ...DEFAULT_REMINDER_PREFERENCES, enabled: true } };
    const alarmsByName = new Map<string, chrome.alarms.Alarm>();
    const storage: ReminderStorageArea = {
      get: vi.fn(async (key: string) => ({ [key]: values[key] })),
      set: vi.fn(async (items: Record<string, unknown>) => { Object.assign(values, items); }),
    };
    const alarms: ReminderAlarms = {
      getAll: vi.fn(async () => [...alarmsByName.values()]),
      create: vi.fn(async (name, info) => { alarmsByName.set(name, { name, scheduledTime: info.when }); }),
      clear: vi.fn(async (name) => alarmsByName.delete(name)),
    };
    const deps: ReminderSchedulerDeps = {
      alarms, storage, notifications: { create: vi.fn(async () => 'n') }, getTasks: async () => [task()],
      now: () => new Date('2026-09-18T16:00:00.000Z'), timeZone: () => 'America/Toronto', hasRestrictedContext: async () => true,
    };
    const alarm = { name: `${REMINDER_ALARM_PREFIX}task-1:2d:${dueIso}` };
    await handleReminderAlarm(alarm, deps);
    expect(values[DEFERRED_REMINDERS_KEY]).toEqual(expect.objectContaining({ [alarm.name.slice(REMINDER_ALARM_PREFIX.length)]: expect.any(String) }));
    expect(alarmsByName.has(alarm.name)).toBe(true);
  });

  it('rejects an old alarm when a later reminder for the same task is already useful', async () => {
    const lateTask = taskWith({ due: { ...task().due, iso: '2026-09-18T14:00:00.000Z' } });
    const { deps, notifications } = setup([lateTask]);
    deps.now = () => new Date('2026-09-18T13:00:00.000Z');
    const oldAlarm = { name: `${REMINDER_ALARM_PREFIX}task-1:2d:2026-09-18T14:00:00.000Z` };

    expect(await handleReminderAlarm(oldAlarm, deps)).toBe(false);
    expect(notifications.create).not.toHaveBeenCalled();
  });

  it('recomputes notification copy from the remaining time at delivery', async () => {
    const lateTask = taskWith({ due: { ...task().due, iso: '2026-09-18T14:00:00.000Z' } });
    const { deps, notifications } = setup([lateTask]);
    deps.now = () => new Date('2026-09-18T13:00:00.000Z');
    const alarm = { name: `${REMINDER_ALARM_PREFIX}task-1:2h:2026-09-18T14:00:00.000Z` };

    expect(await handleReminderAlarm(alarm, deps)).toBe(true);
    expect(notifications.create).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ title: expect.stringContaining('in 1 hour'), message: expect.stringContaining('in 1 hour') }),
    );
  });

  it('does not notify when delivery occurs during current quiet hours', async () => {
    const { deps, notifications } = setup([task()]);
    deps.now = () => new Date('2026-09-18T04:00:00.000Z');
    const alarm = { name: `${REMINDER_ALARM_PREFIX}task-1:2d:${dueIso}` };

    expect(await handleReminderAlarm(alarm, deps)).toBe(false);
    expect(notifications.create).not.toHaveBeenCalled();
  });

  it('reconciles after an alarm so the cap can refill', async () => {
    const { deps, alarms } = setup([task()]);
    deps.now = () => new Date('2026-09-18T17:00:00.000Z');
    const alarm = { name: `${REMINDER_ALARM_PREFIX}task-1:2d:${dueIso}` };

    await handleReminderAlarm(alarm, deps);
    expect(alarms.getAll).toHaveBeenCalled();
  });
});
