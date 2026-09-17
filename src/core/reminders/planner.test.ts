import { describe, expect, it } from 'vitest';
import type { CourseTask } from '@/core/domain';
import { DEFAULT_REMINDER_PREFERENCES, type ReminderPreferences } from './preferences';
import { planReminders } from './planner';

const NOW = new Date('2026-09-15T12:00:00.000Z');
const ZONE = 'America/Toronto';

function task(id: string, dueIso: string, overrides: Partial<CourseTask> = {}): CourseTask {
  return {
    id,
    courseId: 'd2l:course-1',
    title: 'CP363 Assignment 2',
    kind: 'assignment',
    due: {
      iso: dueIso,
      raw: dueIso,
      zoneEvidence: 'explicit',
      timeZone: ZONE,
      timeAssumed: false,
      confidence: 'high',
    },
    dueHistory: [],
    dueConflict: null,
    status: 'todo',
    weight: null,
    provenance: {
      sourceUrl: 'https://mylearningspace.wlu.ca/d2l/home/1',
      pageTitle: 'Synthetic course page',
      platformId: 'd2l',
      pageType: 'assignment',
      capturedAt: NOW.toISOString(),
      extractionVersion: 1,
      strategy: 'test-fixture',
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

function enabled(overrides: Partial<ReminderPreferences> = {}): ReminderPreferences {
  return { ...DEFAULT_REMINDER_PREFERENCES, enabled: true, ...overrides };
}

describe('planReminders', () => {
  it('moves an overnight quiet-hours reminder to 8 am when it still precedes the due time', () => {
    const planned = planReminders(
      [task('quiet', '2026-09-18T12:05:00.000Z')],
      enabled({ offsets: { ...DEFAULT_REMINDER_PREFERENCES.offsets, assignment: { '2d': false, morning: false, '2h': true } } }),
      NOW,
      ZONE,
    );
    expect(planned).toHaveLength(1);
    expect(planned[0]?.fireAt.toISOString()).toBe('2026-09-18T12:00:00.000Z');
  });

  it('skips a quiet-hours reminder when moving it would be after the due time', () => {
    const planned = planReminders(
      [task('too-late', '2026-09-18T11:30:00.000Z')],
      enabled({ offsets: { ...DEFAULT_REMINDER_PREFERENCES.offsets, assignment: { '2d': false, morning: false, '2h': true } } }),
      NOW,
      ZONE,
    );
    expect(planned).toHaveLength(0);
  });

  it('skips a quiet-hours reminder moved exactly onto the due time', () => {
    const planned = planReminders(
      [task('exactly-due', '2026-09-18T12:00:00.000Z')],
      enabled({ offsets: { ...DEFAULT_REMINDER_PREFERENCES.offsets, assignment: { '2d': false, morning: false, '2h': true } } }),
      NOW,
      ZONE,
    );
    expect(planned).toHaveLength(0);
  });

  it('collapses reminders moved to the same minute and keeps the latest useful lead', () => {
    const planned = planReminders(
      [task('same-minute', '2026-09-18T12:05:00.000Z')],
      enabled({ offsets: { ...DEFAULT_REMINDER_PREFERENCES.offsets, assignment: { '2d': false, morning: true, '2h': true } } }),
      NOW,
      ZONE,
    );
    expect(planned).toHaveLength(1);
    expect(planned[0]?.id).toContain(':2h:');
  });

  it('plans morning-of at 8 am in the requested timezone', () => {
    const planned = planReminders(
      [task('morning', '2026-09-17T20:00:00.000Z')],
      enabled({ offsets: { ...DEFAULT_REMINDER_PREFERENCES.offsets, assignment: { '2d': false, morning: true, '2h': false } } }),
      NOW,
      ZONE,
    );
    expect(planned[0]?.fireAt.toISOString()).toBe('2026-09-17T12:00:00.000Z');
  });

  it('resolves the two-hour reminder across the spring DST change', () => {
    const planned = planReminders(
      [task('dst', '2026-03-09T16:00:00.000Z')],
      enabled({ offsets: { ...DEFAULT_REMINDER_PREFERENCES.offsets, assignment: { '2d': false, morning: false, '2h': true } } }),
      new Date('2026-03-08T12:00:00.000Z'),
      ZONE,
    );
    expect(planned[0]?.fireAt.toISOString()).toBe('2026-03-09T14:00:00.000Z');
  });

  it('changes the deterministic id when the observed due date moves', () => {
    const prefs = enabled({ offsets: { ...DEFAULT_REMINDER_PREFERENCES.offsets, assignment: { '2d': true, morning: false, '2h': false } } });
    const first = planReminders([task('moved', '2026-09-20T16:00:00.000Z')], prefs, NOW, ZONE);
    const second = planReminders([task('moved', '2026-09-21T16:00:00.000Z')], prefs, NOW, ZONE);
    expect(first[0]?.id).not.toBe(second[0]?.id);
    expect(first[0]?.id).toContain('2026-09-20T16:00:00.000Z');
    expect(second[0]?.id).toContain('2026-09-21T16:00:00.000Z');
  });

  it('suppresses submitted, low-confidence, archived, and overdue tasks', () => {
    const prefs = enabled({ offsets: { ...DEFAULT_REMINDER_PREFERENCES.offsets, assignment: { '2d': true, morning: true, '2h': true } } });
    expect(planReminders([
      task('submitted', '2026-09-20T16:00:00.000Z', { status: 'submitted' }),
      task('low', '2026-09-20T16:00:00.000Z', { due: { ...task('x', '2026-09-20T16:00:00.000Z').due, confidence: 'low' } }),
      task('archived', '2026-09-20T16:00:00.000Z', { archived: true }),
      task('overdue', '2026-09-14T16:00:00.000Z'),
    ], prefs, NOW, ZONE)).toHaveLength(0);
  });

  it('marks assumed-local times as approximate without claiming attempt state', () => {
    const planned = planReminders(
      [task('approx', '2026-09-20T16:00:00.000Z', { due: { ...task('x', '2026-09-20T16:00:00.000Z').due, zoneEvidence: 'assumed-local' } })],
      enabled({ offsets: { ...DEFAULT_REMINDER_PREFERENCES.offsets, assignment: { '2d': false, morning: false, '2h': true } } }),
      NOW,
      ZONE,
    );
    expect(planned[0]?.body).toContain('(approximate time)');
    expect(planned[0]?.body).not.toContain("haven't started");
  });
});
