import type { CourseTask } from '../domain';

/** Statuses that no longer belong in any deadline bucket. */
const INACTIVE_STATUSES = new Set(['submitted', 'graded', 'archived']);

export interface DeadlineBuckets {
  today: CourseTask[];
  upcoming: CourseTask[];
  overdue: CourseTask[];
  needsReview: CourseTask[];
}

function getZonedParts(date: Date, timeZone: string) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = formatter.formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

/** The instant that is midnight, in `timeZone`, on the day containing `date`. */
function startOfDayInZone(date: Date, timeZone: string): Date {
  const p = getZonedParts(date, timeZone);
  const wallClockAsUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const offsetMs = wallClockAsUTC - date.getTime();
  const midnightWallAsUTC = Date.UTC(p.year, p.month - 1, p.day, 0, 0, 0);
  return new Date(midnightWallAsUTC - offsetMs);
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function taskNeedsReview(task: CourseTask): boolean {
  const { due } = task;
  if (due.iso === null) return true;
  if (due.confidence === 'medium' || due.confidence === 'low') return true;
  if (due.timeAssumed) return true;
  if (due.zoneEvidence === 'assumed-local') return true;
  return false;
}

/**
 * Buckets tasks into Today / Upcoming (next 7 days, excl. today) / Overdue /
 * Needs review (VISION §25), using each task's current `due` value (already
 * the effective value after any student correction was applied upstream).
 * `now` and `timeZone` are injectable so bucketing is deterministic in tests.
 */
export function deadlineBuckets(
  tasks: CourseTask[],
  now: Date,
  timeZone: string,
): DeadlineBuckets {
  const buckets: DeadlineBuckets = { today: [], upcoming: [], overdue: [], needsReview: [] };

  const startOfToday = startOfDayInZone(now, timeZone);
  const startOfTomorrow = new Date(startOfToday.getTime() + DAY_MS);
  const endOfUpcoming = new Date(startOfToday.getTime() + 8 * DAY_MS);

  for (const task of tasks) {
    if (INACTIVE_STATUSES.has(task.status)) continue;

    if (taskNeedsReview(task)) {
      buckets.needsReview.push(task);
      continue;
    }

    const due = new Date(task.due.iso as string);
    const dueMs = due.getTime();

    if (dueMs < startOfToday.getTime()) {
      buckets.overdue.push(task);
    } else if (dueMs < startOfTomorrow.getTime()) {
      buckets.today.push(task);
    } else if (dueMs < endOfUpcoming.getTime()) {
      buckets.upcoming.push(task);
    }
  }

  return buckets;
}
