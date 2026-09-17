import type { CourseTask } from '../domain';

const INACTIVE_STATUSES = new Set(['submitted', 'graded', 'archived']);

export type WeekStart = 'monday' | 'sunday';
export type DeadlineWeekKey = 'overdue' | 'thisWeek' | 'nextWeek' | 'later';

export interface DeadlineWeekGroup {
  key: DeadlineWeekKey;
  label: string;
  tasks: CourseTask[];
  count: number;
}

function zonedDate(date: Date, timeZone: string): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(date);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return { year: value('year'), month: value('month'), day: value('day') };
}

function dayIndex(date: { year: number; month: number; day: number }): number {
  return Math.floor(Date.UTC(date.year, date.month - 1, date.day) / 86_400_000);
}

function dateFromDayIndex(index: number): { year: number; month: number; day: number } {
  const date = new Date(index * 86_400_000);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function formatRange(start: number, end: number, timeZone: string): string {
  const first = dateFromDayIndex(start);
  const last = dateFromDayIndex(end);
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone, month: 'short', day: 'numeric' });
  const firstDate = new Date(Date.UTC(first.year, first.month - 1, first.day, 12));
  const lastDate = new Date(Date.UTC(last.year, last.month - 1, last.day, 12));
  return `${formatter.format(firstDate)} to ${formatter.format(lastDate)}`;
}

function groupLabel(key: DeadlineWeekKey, start: number, timeZone: string): string {
  if (key === 'overdue') return 'Overdue';
  if (key === 'later') return 'Later';
  const prefix = key === 'thisWeek' ? 'This week' : 'Next week';
  return `${prefix} · ${formatRange(start, start + 6, timeZone)}`;
}

/**
 * Groups active deadlines by local calendar week. Calendar-day arithmetic is
 * deliberately performed on date-only values, so DST's 23/25-hour days cannot
 * push an item into a neighbouring week.
 */
export function groupByWeek(
  tasks: CourseTask[],
  now: Date,
  timeZone: string,
  weekStart: WeekStart = 'monday',
): DeadlineWeekGroup[] {
  const today = dayIndex(zonedDate(now, timeZone));
  const sundayBasedDay = new Date(today * 86_400_000).getUTCDay();
  const offset = weekStart === 'monday' ? (sundayBasedDay + 6) % 7 : sundayBasedDay;
  const thisWeekStart = today - offset;
  const groups: Record<DeadlineWeekKey, CourseTask[]> = {
    overdue: [], thisWeek: [], nextWeek: [], later: [],
  };

  for (const task of tasks) {
    if (INACTIVE_STATUSES.has(task.status) || task.archived) continue;
    if (!task.due.iso) {
      groups.later.push(task);
      continue;
    }
    const dueDay = dayIndex(zonedDate(new Date(task.due.iso), timeZone));
    if (dueDay < today) groups.overdue.push(task);
    else if (dueDay < thisWeekStart + 7) groups.thisWeek.push(task);
    else if (dueDay < thisWeekStart + 14) groups.nextWeek.push(task);
    else groups.later.push(task);
  }

  const starts: Record<DeadlineWeekKey, number> = {
    overdue: thisWeekStart,
    thisWeek: thisWeekStart,
    nextWeek: thisWeekStart + 7,
    later: thisWeekStart + 14,
  };
  return (['overdue', 'thisWeek', 'nextWeek', 'later'] as const)
    .map((key) => ({
      key,
      label: groupLabel(key, starts[key], timeZone),
      tasks: groups[key].sort((a, b) => (a.due.iso ?? '').localeCompare(b.due.iso ?? '') || a.title.localeCompare(b.title)),
      count: groups[key].length,
    }))
    .filter((group) => group.count > 0);
}
