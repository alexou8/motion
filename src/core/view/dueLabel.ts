import type { DueDate } from '../domain';

/** Calendar-day labels must not depend on a rounded 24-hour duration. */
export function relativeDue(iso: string | null, now: Date, timeZone: string): string {
  if (!iso) return 'Date not parsed';
  const due = new Date(iso);
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  });
  const day = (date: Date) => {
    const parts = formatter.formatToParts(date);
    const value = (type: string) => Number(parts.find((part) => part.type === type)?.value);
    return Date.UTC(value('year'), value('month') - 1, value('day')) / 86_400_000;
  };
  const days = day(due) - day(now);
  if (days === 0) return due.getTime() < now.getTime() ? 'Overdue today' : 'Due today';
  if (days === 1) return 'Due tomorrow';
  if (days === -1) return 'Due yesterday';
  if (days > 1) return `Due in ${days} days`;
  return `${Math.abs(days)} days overdue`;
}

export function dueDateLabel(due: Pick<DueDate, 'iso' | 'timeAssumed'>, timeZone: string): string {
  if (!due.iso) return 'an unparsed date';
  return new Intl.DateTimeFormat(undefined, {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(due.timeAssumed ? {} : { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }),
  }).format(new Date(due.iso));
}
