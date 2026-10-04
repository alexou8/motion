import type { CourseTask } from '../domain';
import { isUndatedMaterial } from './coursework';

/** Statuses that no longer belong in any deadline bucket. */
const INACTIVE_STATUSES = new Set(['submitted', 'graded', 'archived']);

export interface DeadlineBuckets {
  today: CourseTask[];
  upcoming: CourseTask[];
  overdue: CourseTask[];
  needsReview: CourseTask[];
}

function calendarDay(date: Date, formatter: Intl.DateTimeFormat): number {
  const parts = formatter.formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return Math.floor(Date.UTC(get('year'), get('month') - 1, get('day')) / DAY_MS);
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function taskNeedsReview(task: CourseTask): boolean {
  if (isUndatedMaterial(task)) return false;
  if (task.dueConflict) return true;
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
export function deadlineBuckets(tasks: CourseTask[], now: Date, timeZone: string): DeadlineBuckets {
  const buckets: DeadlineBuckets = { today: [], upcoming: [], overdue: [], needsReview: [] };

  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const today = calendarDay(now, formatter);

  for (const task of tasks) {
    if (INACTIVE_STATUSES.has(task.status) || task.archived || isUndatedMaterial(task)) continue;

    if (taskNeedsReview(task)) {
      buckets.needsReview.push(task);
      continue;
    }

    const due = new Date(task.due.iso as string);
    const dueMs = due.getTime();

    const dueDay = calendarDay(due, formatter);
    if (dueMs < now.getTime()) {
      buckets.overdue.push(task);
    } else if (dueDay === today) {
      buckets.today.push(task);
    } else if (dueDay <= today + 7) {
      buckets.upcoming.push(task);
    }
  }

  return buckets;
}
