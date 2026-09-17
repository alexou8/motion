import { describe, expect, it } from 'vitest';
import type { CourseTask, DueDate } from '../domain';
import { deadlineBuckets } from './deadlines';

const TZ = 'America/Toronto';
const NOW = new Date('2026-03-10T15:00:00.000Z'); // 10:00 EST (UTC-5) in Toronto, no DST yet

function due(overrides: Partial<DueDate>): DueDate {
  return {
    iso: null,
    raw: '',
    zoneEvidence: 'explicit',
    timeAssumed: false,
    confidence: 'high',
    ...overrides,
  };
}

function task(id: string, overrides: Partial<CourseTask> = {}): CourseTask {
  return {
    id,
    courseId: 'c1',
    title: id,
    kind: 'assignment',
    due: due({}),
    dueHistory: [],
    dueConflict: null,
    status: 'todo',
    weight: null,
    provenance: {
      sourceUrl: 'https://lms.example.com/a',
      pageTitle: '',
      platformId: 'd2l',
      pageType: 'assignment',
      capturedAt: NOW.toISOString(),
      extractionVersion: 1,
    },
    corrections: [],
    studentEdited: false,
    manual: false,
    archived: false,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...overrides,
  };
}

describe('deadlineBuckets', () => {
  it('places a task due today (Toronto) in today, not overdue/upcoming', () => {
    // 2026-03-10 23:30 UTC = 18:30 EST — still "today" in Toronto.
    const t = task('t-today', { due: due({ iso: '2026-03-10T23:30:00.000Z' }) });
    const buckets = deadlineBuckets([t], NOW, TZ);
    expect(buckets.today.map((x) => x.id)).toEqual(['t-today']);
    expect(buckets.overdue).toHaveLength(0);
    expect(buckets.upcoming).toHaveLength(0);
  });

  it('a task due just after Toronto midnight is tomorrow, in upcoming not today', () => {
    // Toronto is in EDT (UTC-4) in March; midnight starting 2026-03-11 local
    // is 2026-03-11T04:00:00Z. One minute after that is "tomorrow", i.e. upcoming.
    const t = task('t-after-midnight', { due: due({ iso: '2026-03-11T04:01:00.000Z' }) });
    const buckets = deadlineBuckets([t], NOW, TZ);
    expect(buckets.today).toHaveLength(0);
    expect(buckets.upcoming.map((x) => x.id)).toEqual(['t-after-midnight']);
  });

  it('a task due one minute before Toronto midnight is still today', () => {
    const t = task('t-before-midnight', { due: due({ iso: '2026-03-11T03:59:00.000Z' }) });
    const buckets = deadlineBuckets([t], NOW, TZ);
    expect(buckets.today.map((x) => x.id)).toEqual(['t-before-midnight']);
    expect(buckets.upcoming).toHaveLength(0);
  });

  it('places a past-due, not-submitted task in overdue', () => {
    const t = task('t-overdue', { due: due({ iso: '2026-03-09T12:00:00.000Z' }) });
    const buckets = deadlineBuckets([t], NOW, TZ);
    expect(buckets.overdue.map((x) => x.id)).toEqual(['t-overdue']);
  });

  it('excludes submitted/graded/archived tasks from overdue', () => {
    const submitted = task('t-submitted', {
      due: due({ iso: '2026-03-09T12:00:00.000Z' }),
      status: 'submitted',
    });
    const graded = task('t-graded', { due: due({ iso: '2026-03-09T12:00:00.000Z' }), status: 'graded' });
    const archived = task('t-archived', { due: due({ iso: '2026-03-09T12:00:00.000Z' }), archived: true, status: 'archived' });
    const buckets = deadlineBuckets([submitted, graded, archived], NOW, TZ);
    expect(buckets.overdue).toHaveLength(0);
    expect(buckets.needsReview).toHaveLength(0);
    expect(buckets.today).toHaveLength(0);
    expect(buckets.upcoming).toHaveLength(0);
  });

  it('places a task within the next 7 days (excluding today) in upcoming', () => {
    const t = task('t-upcoming', { due: due({ iso: '2026-03-15T12:00:00.000Z' }) });
    const buckets = deadlineBuckets([t], NOW, TZ);
    expect(buckets.upcoming.map((x) => x.id)).toEqual(['t-upcoming']);
  });

  it('excludes a task more than 7 days out', () => {
    const t = task('t-far', { due: due({ iso: '2026-04-01T12:00:00.000Z' }) });
    const buckets = deadlineBuckets([t], NOW, TZ);
    expect(buckets.upcoming).toHaveLength(0);
    expect(buckets.overdue).toHaveLength(0);
    expect(buckets.today).toHaveLength(0);
  });

  it('flags null iso, low/medium confidence, timeAssumed, and assumed zone as needs review', () => {
    const nullIso = task('t-null', { due: due({ iso: null }) });
    const lowConfidence = task('t-low', {
      due: due({ iso: '2026-03-15T12:00:00.000Z', confidence: 'low' }),
    });
    const timeAssumed = task('t-time-assumed', {
      due: due({ iso: '2026-03-15T12:00:00.000Z', timeAssumed: true }),
    });
    const assumedZone = task('t-zone-assumed', {
      due: due({ iso: '2026-03-15T12:00:00.000Z', zoneEvidence: 'assumed-local' }),
    });
    const buckets = deadlineBuckets([nullIso, lowConfidence, timeAssumed, assumedZone], NOW, TZ);
    expect(buckets.needsReview.map((x) => x.id).sort()).toEqual(
      ['t-low', 't-null', 't-time-assumed', 't-zone-assumed'].sort(),
    );
    expect(buckets.upcoming).toHaveLength(0);
  });

  it('a confirmed correction with explicit zone/time is never needs-review', () => {
    const t = task('t-confirmed', {
      due: due({ iso: '2026-03-15T12:00:00.000Z', confidence: 'confirmed', zoneEvidence: 'explicit' }),
    });
    const buckets = deadlineBuckets([t], NOW, TZ);
    expect(buckets.needsReview).toHaveLength(0);
    expect(buckets.upcoming.map((x) => x.id)).toEqual(['t-confirmed']);
  });
});
