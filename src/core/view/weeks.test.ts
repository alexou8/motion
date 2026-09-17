import { describe, expect, it } from 'vitest';
import { courseTaskSchema, type CourseTask } from '../domain';
import { groupByWeek } from './weeks';

const TZ = 'America/Toronto';

function task(id: string, iso: string | null): CourseTask {
  return courseTaskSchema.parse({
    id,
    courseId: 'synthetic-course',
    title: id,
    kind: 'assignment',
    due: { iso, raw: iso ?? 'No parsed date', zoneEvidence: 'explicit', timeAssumed: false, confidence: 'high' },
    status: 'todo',
    weight: null,
    provenance: { sourceUrl: 'https://lms.example.test/tasks', pageTitle: 'Synthetic tasks', platformId: 'd2l', pageType: 'assignment-list', capturedAt: '2026-03-08T15:00:00.000Z', extractionVersion: 1 },
    corrections: [], studentEdited: false, manual: false, archived: false,
    createdAt: '2026-03-08T15:00:00.000Z', updatedAt: '2026-03-08T15:00:00.000Z',
  });
}

describe('groupByWeek', () => {
  it('uses local calendar days across the spring DST boundary', () => {
    // Mar 8 is the 23-hour DST change day in Toronto. Mar 9 remains in the
    // same Monday-start week, not a week later because a day was 23 hours.
    const now = new Date('2026-03-08T15:00:00.000Z');
    const groups = groupByWeek([
      task('overdue', '2026-03-07T17:00:00.000Z'),
      task('sunday', '2026-03-08T20:00:00.000Z'),
      task('monday', '2026-03-09T14:00:00.000Z'),
      task('following-monday', '2026-03-16T14:00:00.000Z'),
    ], now, TZ);

    expect(groups.find((group) => group.key === 'overdue')?.tasks.map((item) => item.id)).toEqual(['overdue']);
    expect(groups.find((group) => group.key === 'thisWeek')?.tasks.map((item) => item.id)).toEqual(['sunday']);
    expect(groups.find((group) => group.key === 'nextWeek')?.tasks.map((item) => item.id)).toEqual(['monday']);
    expect(groups.find((group) => group.key === 'later')?.tasks.map((item) => item.id)).toEqual(['following-monday']);
  });

  it('treats Sunday consistently at the Monday/Sunday week-start edge', () => {
    const now = new Date('2026-09-20T16:00:00.000Z'); // Sunday noon in Toronto
    const sunday = task('sunday', '2026-09-20T18:00:00.000Z');
    const monday = task('monday', '2026-09-21T14:00:00.000Z');

    const mondayStart = groupByWeek([sunday, monday], now, TZ, 'monday');
    expect(mondayStart.find((group) => group.key === 'thisWeek')?.tasks.map((item) => item.id)).toEqual(['sunday']);
    expect(mondayStart.find((group) => group.key === 'nextWeek')?.tasks.map((item) => item.id)).toEqual(['monday']);

    const sundayStart = groupByWeek([sunday, monday], now, TZ, 'sunday');
    expect(sundayStart.find((group) => group.key === 'thisWeek')?.tasks.map((item) => item.id)).toEqual(['sunday', 'monday']);
  });
});
