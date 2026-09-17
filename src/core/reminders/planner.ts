import type { CourseTask } from '../domain';
import {
  REMINDER_OFFSETS,
  type ReminderOffset,
  type ReminderPreferences,
} from './preferences';

export interface PlannedReminder {
  id: string;
  taskId: string;
  fireAt: Date;
  title: string;
  body: string;
}

const OFFSET_HOURS: Record<ReminderOffset, number> = { '2d': 48, morning: 0, '2h': 2 };
const MINUTES_PER_DAY = 24 * 60;

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function zonedParts(date: Date, timeZone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return {
    year: value('year'),
    month: value('month'),
    day: value('day'),
    hour: value('hour'),
    minute: value('minute'),
    second: value('second'),
  };
}

/** Resolve a local wall-clock time without assuming the host process timezone. */
function localDate(
  date: Pick<ZonedParts, 'year' | 'month' | 'day'>,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  let guess = Date.UTC(date.year, date.month - 1, date.day, hour, minute, 0);
  // Correct the UTC guess using the offset observed in the requested zone.
  // Four passes cover DST transitions while keeping the function deterministic.
  for (let i = 0; i < 4; i += 1) {
    const actual = zonedParts(new Date(guess), timeZone);
    const actualWall = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second,
    );
    const desiredWall = Date.UTC(date.year, date.month - 1, date.day, hour, minute, 0);
    guess += desiredWall - actualWall;
  }
  return new Date(guess);
}

function civilDay(date: Pick<ZonedParts, 'year' | 'month' | 'day'>, delta: number): Pick<ZonedParts, 'year' | 'month' | 'day'> {
  const next = new Date(Date.UTC(date.year, date.month - 1, date.day + delta));
  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
}

function minutesOfDay(parts: ZonedParts): number {
  return parts.hour * 60 + parts.minute;
}

function timeMinutes(value: string): number {
  const [hour, minute] = value.split(':').map(Number);
  return (hour ?? 0) * 60 + (minute ?? 0);
}

function isQuiet(date: Date, quietHours: ReminderPreferences['quietHours'], timeZone: string): boolean {
  const minute = minutesOfDay(zonedParts(date, timeZone));
  const start = timeMinutes(quietHours.start);
  const end = timeMinutes(quietHours.end);
  if (start === end) return false;
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

/** Move a quiet-hours collision to the next end boundary; skip if it crosses due. */
function moveOutOfQuiet(
  candidate: Date,
  due: Date,
  quietHours: ReminderPreferences['quietHours'],
  timeZone: string,
): Date | null {
  if (!isQuiet(candidate, quietHours, timeZone)) return candidate;
  const parts = zonedParts(candidate, timeZone);
  const start = timeMinutes(quietHours.start);
  const end = timeMinutes(quietHours.end);
  const candidateMinute = minutesOfDay(parts);
  const overnight = start > end;
  const endDay = overnight && candidateMinute >= start ? civilDay(parts, 1) : { year: parts.year, month: parts.month, day: parts.day };
  const moved = localDate(endDay, Math.floor(end / 60), end % 60, timeZone);
  return moved.getTime() >= due.getTime() ? null : moved;
}

function effectiveKind(kind: string, offsets: ReminderPreferences['offsets']): string {
  if (kind === 'content') return 'other';
  return offsets[kind] ? kind : 'other';
}

function approximateSuffix(task: CourseTask): string {
  return task.due.zoneEvidence === 'assumed-local' ? ' (approximate time)' : '';
}

function dueVerb(task: CourseTask): string {
  return task.kind === 'quiz' ? 'closes' : 'is due';
}

function dueTime(task: CourseTask, timeZone: string): string {
  const text = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(task.due.iso as string));
  return text.replace(/\s?(AM|PM)$/i, (_, meridiem: string) => ` ${meridiem.toLowerCase()}`);
}

function leadText(offset: ReminderOffset): string {
  if (offset === '2d') return 'in 2 days';
  if (offset === '2h') return 'in 2 hours';
  return 'today';
}

function reminderCopy(task: CourseTask, offset: ReminderOffset, timeZone: string): { title: string; body: string } {
  const verb = dueVerb(task);
  const suffix = approximateSuffix(task);
  const title = `${task.title} ${verb} ${leadText(offset)}`;
  const body = offset === 'morning'
    ? `${task.title} ${verb} at ${dueTime(task, timeZone)}${suffix}.`
    : `${task.title} ${verb} ${leadText(offset)}${suffix}. It ${verb} at ${dueTime(task, timeZone)}${suffix}.`;
  return { title, body };
}

function fireTime(task: CourseTask, offset: ReminderOffset, prefs: ReminderPreferences, timeZone: string): Date | null {
  const due = new Date(task.due.iso as string);
  if (offset !== 'morning') {
    return moveOutOfQuiet(
      new Date(due.getTime() - OFFSET_HOURS[offset] * 60 * 60 * 1_000),
      due,
      prefs.quietHours,
      timeZone,
    );
  }
  const dueParts = zonedParts(due, timeZone);
  const end = timeMinutes(prefs.quietHours.end);
  const morningMinute = Math.max(8 * 60, end);
  const candidate = localDate(dueParts, Math.floor(morningMinute / 60), morningMinute % 60, timeZone);
  return candidate.getTime() >= due.getTime() ? null : candidate;
}

function enabledOffsets(task: CourseTask, prefs: ReminderPreferences): ReminderOffset[] {
  const settings = prefs.offsets[effectiveKind(task.kind, prefs.offsets)];
  if (!settings) return [];
  return REMINDER_OFFSETS.filter((offset) => settings[offset]);
}

/**
 * Human copy derived from the actual time left, used at delivery so a late
 * wake-up never repeats a stale offset's lead text.
 */
function remainingLeadText(msRemaining: number): string {
  if (msRemaining <= 0) return 'now';
  const hours = msRemaining / (60 * 60 * 1_000);
  if (hours < 1) return 'in less than an hour';
  if (hours < 24) {
    const roundedHours = Math.round(hours);
    return `in ${roundedHours} hour${roundedHours === 1 ? '' : 's'}`;
  }
  const days = Math.round(hours / 24);
  return `in ${days} day${days === 1 ? '' : 's'}`;
}

/** Recomputes notification copy from `due - now` rather than trusting a plan's offset. */
export function remainingCopy(task: CourseTask, now: Date, timeZone: string): { title: string; body: string } {
  const due = new Date(task.due.iso as string);
  const verb = dueVerb(task);
  const suffix = approximateSuffix(task);
  const lead = remainingLeadText(due.getTime() - now.getTime());
  const title = `${task.title} ${verb} ${lead}`;
  const body = `${task.title} ${verb} ${lead}${suffix}. It ${verb} at ${dueTime(task, timeZone)}${suffix}.`;
  return { title, body };
}

/**
 * True when a later (closer-to-due) enabled offset's own fire window has
 * already opened by `now`. An alarm for an earlier offset that wakes this
 * late is superseded rather than useful — a fresher alarm covers it.
 */
export function isSupersededByLaterOffset(
  task: CourseTask,
  offset: ReminderOffset,
  prefs: ReminderPreferences,
  now: Date,
  timeZone: string,
): boolean {
  if (task.due.iso === null || task.due.iso === undefined) return false;
  const settings = prefs.offsets[effectiveKind(task.kind, prefs.offsets)];
  if (!settings) return false;
  const idx = REMINDER_OFFSETS.indexOf(offset);
  for (const later of REMINDER_OFFSETS.slice(idx + 1)) {
    if (!settings[later]) continue;
    const laterFireAt = fireTime(task, later, prefs, timeZone);
    if (laterFireAt && now.getTime() >= laterFireAt.getTime()) return true;
  }
  return false;
}

/**
 * Plans only future, actionable reminders. `now` and `timeZone` are explicit
 * so DST and quiet-hour behaviour can be tested without changing the clock.
 */
export function planReminders(
  tasks: CourseTask[],
  prefs: ReminderPreferences,
  now: Date,
  timeZone: string,
): PlannedReminder[] {
  if (!prefs.enabled) return [];
  // Keyed by task + fire minute so a quiet-hours move that lands two offsets
  // on the same instant produces one notification, not a duplicate pair.
  const byTaskAndMinute = new Map<string, { offset: ReminderOffset; offsetIndex: number; plan: PlannedReminder }>();
  for (const task of tasks) {
    if (task.archived || task.status === 'submitted' || task.status === 'graded' || task.status === 'archived') continue;
    if (task.due.iso === null || task.due.confidence === 'low') continue;
    const due = new Date(task.due.iso);
    if (!Number.isFinite(due.getTime()) || due.getTime() <= now.getTime()) continue;
    for (const offset of enabledOffsets(task, prefs)) {
      const fireAt = fireTime(task, offset, prefs, timeZone);
      if (!fireAt || fireAt.getTime() <= now.getTime() || fireAt.getTime() > due.getTime()) continue;
      const { title, body } = reminderCopy(task, offset, timeZone);
      const plan: PlannedReminder = {
        id: `${task.id}:${offset}:${task.due.iso}`,
        taskId: task.id,
        fireAt,
        title,
        body,
      };
      const key = `${task.id}|${fireAt.getTime()}`;
      const offsetIndex = REMINDER_OFFSETS.indexOf(offset);
      const existing = byTaskAndMinute.get(key);
      // Later offsets (closer to due) are the more useful lead when two
      // offsets collapse onto the same instant.
      if (!existing || offsetIndex > existing.offsetIndex) {
        byTaskAndMinute.set(key, { offset, offsetIndex, plan });
      }
    }
  }
  return Array.from(byTaskAndMinute.values())
    .map((entry) => entry.plan)
    .sort((a, b) => a.fireAt.getTime() - b.fireAt.getTime());
}

export { isQuiet, localDate, zonedParts, MINUTES_PER_DAY };
