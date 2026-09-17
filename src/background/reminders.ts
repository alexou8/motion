import { z } from 'zod';
import { courseTaskSchema, type CourseTask } from '@/core/domain';
import {
  loadReminderPreferences,
  REMINDER_PREFERENCES_KEY,
  SENT_REMINDERS_KEY,
  type ReminderOffset,
  type ReminderPreferences,
  type ReminderStorageArea,
} from '@/core/reminders';
import {
  isQuiet,
  isSupersededByLaterOffset,
  planReminders,
  remainingCopy,
  type PlannedReminder,
} from '@/core/reminders';
import { openDatabase } from '@/core/storage/db';
import { STORE } from '@/core/storage/schema';
import { Repository } from '@/core/storage/repository';

export const REMINDER_ALARM_PREFIX = 'motion-reminder:';
export const REMINDER_NOTIFICATION_PREFIX = 'motion-reminder-notification:';
export const DEFERRED_REMINDERS_KEY = 'motion.reminders.deferred';
export const MAX_SCHEDULED_REMINDERS = 50;
/** How long a suppressed reminder (restricted tab or quiet hours) waits before retrying. */
const SUPPRESSED_RETRY_DELAY_MS = 15 * 60 * 1_000;
const OBSERVATION_KEY_PREFIX = 'observation:';

type ReminderAlarm = Pick<chrome.alarms.Alarm, 'name'>;
export interface ReminderAlarms {
  getAll(): Promise<chrome.alarms.Alarm[]>;
  create(name: string, alarmInfo: { when: number }): Promise<void>;
  clear(name: string): Promise<boolean>;
}

export interface ReminderNotifications {
  create(
    notificationId: string,
    options: chrome.notifications.NotificationOptions,
  ): Promise<string>;
  onClicked?: { addListener(listener: (notificationId: string) => void): void };
}

export interface ReminderSchedulerDeps {
  alarms: ReminderAlarms;
  notifications?: ReminderNotifications;
  storage: ReminderStorageArea;
  getTasks: () => Promise<CourseTask[]>;
  now: () => Date;
  timeZone: () => string;
  openTask?: (taskId: string) => Promise<void>;
  /**
   * True when any tab is currently a restricted (graded/timed/proctored)
   * attempt. Reminders are suppressed rather than shown over an attempt.
   */
  hasRestrictedContext: () => Promise<boolean>;
}

const sentRemindersSchema = z.record(z.string().datetime());
const deferredRemindersSchema = z.record(z.string().datetime());

function defaultDeps(): ReminderSchedulerDeps {
  return {
    alarms: chrome.alarms as unknown as ReminderAlarms,
    notifications: chrome.notifications as unknown as ReminderNotifications | undefined,
    storage: chrome.storage.local as unknown as ReminderStorageArea,
    getTasks: async () => {
      const db = await openDatabase();
      return (await new Repository(db, STORE.tasks, courseTaskSchema).all()).records;
    },
    now: () => new Date(),
    timeZone: () => Intl.DateTimeFormat().resolvedOptions().timeZone,
    hasRestrictedContext: defaultHasRestrictedContext,
  };
}

/**
 * Reads the same per-tab `observation:<tabId>` session-storage rows the
 * content bridge writes (see `src/background/router.ts`), without importing
 * that module, to keep this slice's ownership additive. A restricted flag on
 * any tab means an attempt could be active anywhere in the browser, not just
 * the focused tab.
 */
async function defaultHasRestrictedContext(): Promise<boolean> {
  const tabs = await chrome.tabs.query({});
  const ids = tabs.map((tab) => tab.id).filter((id): id is number => id !== undefined);
  if (ids.length === 0) return false;
  const keys = ids.map((id) => `${OBSERVATION_KEY_PREFIX}${id}`);
  const stored = await chrome.storage.session.get(keys);
  return keys.some((key) => {
    const value = stored[key];
    return typeof value === 'object' && value !== null && (value as { restricted?: boolean }).restricted === true;
  });
}

async function readSent(storage: ReminderStorageArea): Promise<Record<string, string>> {
  const raw = (await storage.get(SENT_REMINDERS_KEY))[SENT_REMINDERS_KEY];
  const parsed = sentRemindersSchema.safeParse(raw);
  return parsed.success ? parsed.data : {};
}

async function markSent(storage: ReminderStorageArea, id: string, at: Date): Promise<void> {
  const sent = await readSent(storage);
  sent[id] = at.toISOString();
  await storage.set({ [SENT_REMINDERS_KEY]: sent });
}

async function readDeferred(storage: ReminderStorageArea): Promise<Record<string, string>> {
  const raw = (await storage.get(DEFERRED_REMINDERS_KEY))[DEFERRED_REMINDERS_KEY];
  const parsed = deferredRemindersSchema.safeParse(raw);
  return parsed.success ? parsed.data : {};
}

async function writeDeferred(storage: ReminderStorageArea, deferred: Record<string, string>): Promise<void> {
  await storage.set({ [DEFERRED_REMINDERS_KEY]: deferred });
}

function isReminderAlarm(name: string): boolean {
  return name.startsWith(REMINDER_ALARM_PREFIX);
}

function alarmName(id: string): string {
  return `${REMINDER_ALARM_PREFIX}${id}`;
}

function plansFor(
  tasks: CourseTask[],
  prefs: ReminderPreferences,
  now: Date,
  timeZone: string,
  sent: Record<string, string>,
): PlannedReminder[] {
  return planReminders(tasks, prefs, now, timeZone).filter((plan) => sent[plan.id] === undefined);
}

/**
 * Makes the alarm set equal to the next 50 unsent plans. Only alarms with our
 * prefix are ever touched, so workflow recovery alarms cannot collide.
 */
export async function reconcileReminders(
  deps: ReminderSchedulerDeps = defaultDeps(),
): Promise<{ scheduled: number; cleared: number }> {
  const [prefs, tasks, sent, deferred, existing] = await Promise.all([
    loadReminderPreferences(deps.storage),
    deps.getTasks(),
    readSent(deps.storage),
    readDeferred(deps.storage),
    deps.alarms.getAll(),
  ]);
  const now = deps.now();
  const normalPlans = plansFor(tasks, prefs, now, deps.timeZone(), sent);
  // A suppressed alarm is intentionally past its original fire time. Keep it
  // in the desired set until its bounded retry has either fired or expired.
  const deferredPlans = planReminders(tasks, prefs, new Date(0), deps.timeZone())
    .flatMap((plan) => {
      const retryAt = deferred[plan.id];
      if (!retryAt) return [];
      // If Chrome slept past the retry, wake again promptly rather than
      // dropping the deferred reminder before its due-time guard is reached.
      return [{ ...plan, fireAt: new Date(Math.max(new Date(retryAt).getTime(), now.getTime() + 1_000)) }];
    });
  const plans = [...new Map([...normalPlans, ...deferredPlans].map((plan) => [plan.id, plan])).values()]
    .sort((left, right) => left.fireAt.getTime() - right.fireAt.getTime())
    .slice(0, MAX_SCHEDULED_REMINDERS);
  const wanted = new Set(plans.map((plan) => alarmName(plan.id)));
  let cleared = 0;
  for (const alarm of existing) {
    if (isReminderAlarm(alarm.name) && !wanted.has(alarm.name)) {
      if (await deps.alarms.clear(alarm.name)) cleared += 1;
    }
  }
  for (const plan of plans) {
    const name = alarmName(plan.id);
    if (!existing.some((alarm) => alarm.name === name)) {
      await deps.alarms.create(name, { when: plan.fireAt.getTime() });
    }
  }
  return { scheduled: plans.length, cleared };
}

/**
 * Re-checks durable task state and preferences at fire time. An alarm is only
 * a wake-up hint: a submission or moved due date always wins over the alarm.
 */
export async function handleReminderAlarm(
  alarm: ReminderAlarm,
  deps: ReminderSchedulerDeps = defaultDeps(),
): Promise<boolean> {
  if (!isReminderAlarm(alarm.name) || !deps.notifications) return false;
  const id = alarm.name.slice(REMINDER_ALARM_PREFIX.length);
  const [prefs, tasks, sent, deferred] = await Promise.all([
    loadReminderPreferences(deps.storage),
    deps.getTasks(),
    readSent(deps.storage),
    readDeferred(deps.storage),
  ]);
  try {
    if (sent[id] !== undefined) return false;
    // Use an epoch baseline to find the deterministic id even if Chrome wakes
    // the worker late. The current due/status/prefs are still checked by this
    // fresh plan and by its exact id.
    const plan = planReminders(tasks, prefs, new Date(0), deps.timeZone()).find((item) => item.id === id);
    const currentNow = deps.now();
    const currentTask = plan ? tasks.find((task) => task.id === plan.taskId) : undefined;
    const currentDue = currentTask?.due.iso === null || currentTask?.due.iso === undefined
      ? Number.NaN
      : new Date(currentTask.due.iso).getTime();
    if (!plan || !currentTask || plan.fireAt.getTime() > currentNow.getTime() || !Number.isFinite(currentDue) || currentDue <= currentNow.getTime()) {
      delete deferred[id];
      await writeDeferred(deps.storage, deferred);
      return false;
    }
    const offset = id.slice(plan.taskId.length + 1).split(':')[0] as ReminderOffset;
    if (isSupersededByLaterOffset(currentTask, offset, prefs, currentNow, deps.timeZone())) {
      // A closer, still-useful reminder's own window is already open; this
      // wake-up is stale and reconciliation will have armed the fresher one.
      delete deferred[id];
      await writeDeferred(deps.storage, deferred);
      return false;
    }
    const timeZone = deps.timeZone();
    const suppressedByAttempt = await deps.hasRestrictedContext();
    const suppressedByQuietHours = isQuiet(currentNow, prefs.quietHours, timeZone);
    if (suppressedByAttempt || suppressedByQuietHours) {
      // Do not mark sent: re-arm a bounded delay so the reminder is not lost,
      // without ever showing a notification over an attempt or during quiet
      // hours.
      const retryAt = Math.min(
        currentNow.getTime() + SUPPRESSED_RETRY_DELAY_MS,
        currentDue - 1_000,
      );
      if (retryAt > currentNow.getTime()) {
        await deps.alarms.create(alarm.name, { when: retryAt });
        deferred[id] = new Date(retryAt).toISOString();
        await writeDeferred(deps.storage, deferred);
      }
      return false;
    }
    const { title, body } = remainingCopy(currentTask, currentNow, timeZone);
    await deps.notifications.create(`${REMINDER_NOTIFICATION_PREFIX}${id}`, {
      type: 'basic',
      iconUrl: 'src/assets/icons/icon-128.png',
      title,
      message: body,
    });
    await markSent(deps.storage, id, currentNow);
    delete deferred[id];
    await writeDeferred(deps.storage, deferred);
    return true;
  } finally {
    // Refill the alarm set toward the cap whichever way this alarm resolved:
    // firing, superseding, or suppressing all retire one slot.
    await reconcileReminders(deps).catch(() => undefined);
  }
}

async function openTaskInMotion(taskId: string): Promise<void> {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const windowId = tabs[0]?.windowId;
  if (windowId !== undefined && chrome.sidePanel?.open) {
    await chrome.sidePanel.open({ windowId });
    return;
  }
  if (chrome.runtime.openOptionsPage) await chrome.runtime.openOptionsPage();
  // The options hash is intentionally stable; task-specific focus is only
  // attempted through the side panel API when Chrome exposes it.
  void taskId;
}

/** Registers MV3 listeners synchronously; each event rehydrates state. */
export function registerReminderListeners(): void {
  chrome.alarms.onAlarm.addListener((alarm) => {
    void handleReminderAlarm(alarm).catch(() => undefined);
  });
  chrome.notifications?.onClicked?.addListener((notificationId) => {
    if (!notificationId.startsWith(REMINDER_NOTIFICATION_PREFIX)) return;
    void openTaskInMotion(notificationId.slice(REMINDER_NOTIFICATION_PREFIX.length)).catch(() => undefined);
  });
  chrome.storage?.onChanged?.addListener((changes, areaName) => {
    if (areaName !== 'local' || changes[REMINDER_PREFERENCES_KEY] === undefined) return;
    void reconcileReminders().catch(() => undefined);
  });
}
