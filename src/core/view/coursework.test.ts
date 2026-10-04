import { describe, expect, it } from 'vitest';
import { courseTaskSchema, type Course, type CourseTask } from '../domain';
import { filterCoursework, isUndatedMaterial, type CourseworkFilters } from './coursework';
import { deadlineBuckets, taskNeedsReview } from './deadlines';
import { groupByWeek } from './weeks';

const NOW = new Date('2026-10-01T12:00:00Z');
const courses: Course[] = [
  {
    id: 'one',
    platformId: 'synthetic',
    name: 'Synthetic computing',
    code: 'TEST 101',
    archived: false,
    lastVerifiedAt: NOW.toISOString(),
  },
  {
    id: 'two',
    platformId: 'synthetic',
    name: 'Synthetic writing',
    code: 'TEST 202',
    archived: false,
    lastVerifiedAt: NOW.toISOString(),
  },
];
function task(overrides: Partial<CourseTask> = {}): CourseTask {
  return courseTaskSchema.parse({
    id: 'slides',
    courseId: 'one',
    title: 'Lecture slides',
    kind: 'content',
    due: { iso: null, raw: '', confidence: 'low', zoneEvidence: 'none' },
    provenance: {
      sourceUrl: 'https://lms.example.test/content',
      pageTitle: 'Synthetic module',
      platformId: 'synthetic',
      pageType: 'content-module',
      capturedAt: NOW.toISOString(),
      extractionVersion: 1,
    },
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...overrides,
  });
}
const filters: CourseworkFilters = { query: '', courseId: 'all', kind: 'all', status: 'active' };

describe('coursework browsing', () => {
  const slides = task();
  const assignment = task({
    id: 'essay',
    courseId: 'two',
    title: 'Essay outline',
    kind: 'assignment',
    due: {
      iso: '2026-10-02T12:00:00Z',
      raw: 'October 2, noon UTC',
      confidence: 'high',
      zoneEvidence: 'explicit',
      timeAssumed: false,
    },
  });
  const submitted = task({
    id: 'done',
    title: 'Finished assignment',
    kind: 'assignment',
    status: 'submitted',
  });
  const archived = task({ id: 'archived', archived: true });
  const tasks = [slides, archived, submitted, assignment];

  it('shows dated active work first, includes undated materials and excludes archived rows', () => {
    expect(filterCoursework(tasks, courses, filters).map((item) => item.id)).toEqual([
      'essay',
      'slides',
    ]);
    expect(filterCoursework(tasks, courses, { ...filters, status: 'all' })).toHaveLength(3);
    expect(tasks[0]).toBe(slides);
  });
  it('combines title/course search, course, kind and status filters', () => {
    expect(
      filterCoursework(tasks, courses, {
        ...filters,
        query: ' test 101 SLIDES ',
        kind: 'content',
        courseId: 'one',
      }),
    ).toEqual([slides]);
    expect(
      filterCoursework(tasks, courses, { ...filters, query: 'writing outline', courseId: 'two' }),
    ).toEqual([assignment]);
    expect(filterCoursework(tasks, courses, { ...filters, status: 'completed' })).toEqual([
      submitted,
    ]);
    expect(filterCoursework(tasks, courses, { ...filters, query: 'unknown' })).toEqual([]);
  });
  it('does not invent a deadline or review warning for undated materials', () => {
    expect(isUndatedMaterial(slides)).toBe(true);
    expect(taskNeedsReview(slides)).toBe(false);
    expect(deadlineBuckets([slides, assignment, archived], NOW, 'UTC')).toEqual({
      today: [],
      upcoming: [assignment],
      overdue: [],
      needsReview: [],
    });
    expect(groupByWeek([slides], NOW, 'UTC')).toEqual([]);
  });
  it('keeps malformed date evidence and correction conflicts reviewable', () => {
    const malformed = task({ due: { ...slides.due, raw: 'Due next Flursday' } });
    const conflict = task({
      ...assignment,
      dueConflict: {
        observed: {
          iso: '2026-10-03T12:00:00Z',
          raw: 'October 3',
          observedAt: NOW.toISOString(),
          provenance: assignment.provenance,
        },
      },
    });
    expect(taskNeedsReview(malformed)).toBe(true);
    expect(taskNeedsReview(conflict)).toBe(true);
    expect(deadlineBuckets([malformed, conflict], NOW, 'UTC').needsReview).toEqual([
      malformed,
      conflict,
    ]);
  });
});
