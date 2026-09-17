import { beforeEach, describe, expect, it } from 'vitest';
import { adoptTab, agentSessionSchema, appendMessage, excludeSource, releaseTab } from '@/core/session';
import { deleteDatabase, openDatabase } from './db';
import { mergeExtractedTask, sessionRepository, updateSession, updateTask, upsertExtractedTask } from './repositories';
import { Repository } from './repository';
import { STORE } from './schema';
import { courseTaskSchema, type CourseTask } from '../domain';

const DB = 'motion-session-cas-test';
const NOW = '2026-09-16T12:00:00.000Z';

function session() {
  return agentSessionSchema.parse({
    id: 'session-1',
    title: 'Synthetic session',
    goal: 'Test concurrent session updates',
    createdAt: NOW,
    updatedAt: NOW,
  });
}

beforeEach(async () => {
  await deleteDatabase(DB);
});

describe('updateSession', () => {
  it('defaults revision to zero and increments it inside the write transaction', async () => {
    const db = await openDatabase(DB);
    await sessionRepository(db).put(session());

    const updated = await updateSession(db, 'session-1', (current) => ({
      ...appendMessage(current, { id: 'm1', role: 'student', text: 'Hello' }, NOW),
      updatedAt: NOW,
    }));

    expect(updated?.revision).toBe(1);
    expect(updated?.conversation.at(-1)?.text).toBe('Hello');
    expect((await sessionRepository(db).get('session-1'))?.revision).toBe(1);
    db.close();
  });

  it('serializes concurrent mutations without losing either update', async () => {
    const db = await openDatabase(DB);
    await sessionRepository(db).put(session());

    const [first, second] = await Promise.all([
      updateSession(db, 'session-1', (current) =>
        appendMessage(current, { id: 'm1', role: 'student', text: 'First' }, NOW),
      ),
      updateSession(db, 'session-1', (current) =>
        appendMessage(current, { id: 'm2', role: 'student', text: 'Second' }, NOW),
      ),
    ]);

    const stored = await sessionRepository(db).get('session-1');
    expect(first?.revision).toBe(1);
    expect(second?.revision).toBe(2);
    expect(stored?.revision).toBe(2);
    expect(stored?.conversation.map((entry) => entry.id)).toEqual(['m1', 'm2']);
    db.close();
  });

  it('preserves the student release when adopt and release events race', async () => {
    const db = await openDatabase(DB);
    await sessionRepository(db).put(agentSessionSchema.parse({
      ...session(),
      workspace: { ownedTabIds: [], adoptedTabIds: [7], releasedTabIds: [] },
    }));

    await Promise.all([
      updateSession(db, 'session-1', (current) => releaseTab(current, 7, 'Student released tab 7.', NOW)),
      updateSession(db, 'session-1', (current) => adoptTab(current, 7, NOW)),
    ]);

    const stored = await sessionRepository(db).get('session-1');
    expect(stored?.workspace.adoptedTabIds).not.toContain(7);
    expect(stored?.workspace.releasedTabIds).toContain(7);
    db.close();
  });

  it('preserves source exclusion and a concurrent conversation message', async () => {
    const db = await openDatabase(DB);
    await sessionRepository(db).put(agentSessionSchema.parse({
      ...session(),
      context: { sources: [{ url: 'https://lms.example.test/page', title: 'Page', kind: 'reading', excluded: false, provenance: 'observed' }] },
    }));

    await Promise.all([
      updateSession(db, 'session-1', (current) => excludeSource(current, 'https://lms.example.test/page', NOW)),
      updateSession(db, 'session-1', (current) => appendMessage(current, { id: 'm-race', role: 'student', text: 'Keep my message' }, NOW)),
    ]);

    const stored = await sessionRepository(db).get('session-1');
    expect(stored?.context.sources[0]?.excluded).toBe(true);
    expect(stored?.conversation.at(-1)?.id).toBe('m-race');
    db.close();
  });

  it('aborts when the mutator returns null and leaves the record unchanged', async () => {
    const db = await openDatabase(DB);
    await sessionRepository(db).put(session());

    await expect(updateSession(db, 'session-1', () => null)).resolves.toBeNull();
    expect((await sessionRepository(db).get('session-1'))?.revision).toBe(0);
    db.close();
  });
});

function extractedTask(overrides: Partial<CourseTask> = {}): CourseTask {
  return courseTaskSchema.parse({
    id: 'task-1', courseId: 'course-1', title: 'Synthetic assignment', kind: 'assignment',
    due: {
      iso: '2026-09-17T21:00:00.000Z', raw: 'Due Thu, Sep 17', zoneEvidence: 'explicit',
      timeAssumed: false, confidence: 'high', lastObservedAt: NOW,
    },
    status: 'todo', weight: null,
    provenance: { sourceUrl: 'https://lms.example.test/task', pageTitle: 'Synthetic task', platformId: 'd2l', pageType: 'assignment', capturedAt: NOW, extractionVersion: 1 },
    corrections: [], studentEdited: false, manual: false, archived: false, createdAt: NOW, updatedAt: NOW,
    ...overrides,
  });
}

describe('mergeExtractedTask due history', () => {
  it('defaults history fields when reading an existing task row', () => {
    const task = extractedTask();
    expect(task.dueHistory).toEqual([]);
    expect(task.dueConflict).toBeNull();
  });

  it('records an actual LMS date move, but not a raw-text reformat', () => {
    const current = extractedTask();
    const formattingOnly = extractedTask({ due: { ...current.due, raw: 'Closes Thursday, September 17' } });
    expect(mergeExtractedTask(current, formattingOnly).dueHistory).toEqual([]);

    const moved = extractedTask({
      due: { ...current.due, iso: '2026-09-24T21:00:00.000Z', raw: 'Due Thu, Sep 24', lastObservedAt: '2026-09-18T12:00:00.000Z' },
      updatedAt: '2026-09-18T12:00:00.000Z',
    });
    const merged = mergeExtractedTask(current, moved);
    expect(merged.due.iso).toBe(moved.due.iso);
    expect(merged.dueChangedAt).toBe(moved.updatedAt);
    expect(merged.dueHistory).toMatchObject([{ iso: current.due.iso, raw: current.due.raw }]);
  });

  it('keeps a student-set due date and exposes a newer LMS date for review', () => {
    const current = extractedTask({
      due: { ...extractedTask().due, iso: '2026-09-19T21:00:00.000Z', confidence: 'confirmed' },
      corrections: [{ field: 'due.iso', originalValue: '2026-09-17T21:00:00.000Z', correctedValue: '2026-09-19T21:00:00.000Z', correctedAt: NOW }],
      studentEdited: true,
    });
    const incoming = extractedTask({ due: { ...current.due, iso: '2026-09-24T21:00:00.000Z', raw: 'Due Sep 24' } });
    const merged = mergeExtractedTask(current, incoming);

    expect(merged.due.iso).toBe('2026-09-19T21:00:00.000Z');
    expect(merged.dueConflict?.observed.iso).toBe('2026-09-24T21:00:00.000Z');
    expect(merged.dueHistory.at(-1)?.iso).toBe('2026-09-17T21:00:00.000Z');
  });

  it('accepts a newer LMS terminal status after a student status correction', () => {
    const current = extractedTask({
      status: 'todo',
      studentEdited: true,
      corrections: [{ field: 'status', originalValue: 'submitted', correctedValue: 'todo', correctedAt: NOW }],
    });
    const merged = mergeExtractedTask(current, extractedTask({ status: 'submitted', updatedAt: '2026-09-17T00:00:00.000Z' }));
    expect(merged.status).toBe('submitted');
    expect(merged.corrections).toEqual(current.corrections);
  });

  it('keeps a student status correction against an older LMS observation', () => {
    const current = extractedTask({
      status: 'todo', studentEdited: true,
      corrections: [{ field: 'status', originalValue: 'submitted', correctedValue: 'todo', correctedAt: NOW }],
    });
    const merged = mergeExtractedTask(current, extractedTask({ status: 'submitted', updatedAt: '2025-08-01T00:00:00.000Z' }));
    expect(merged.status).toBe('todo');
  });

  it('uses the newest status correction as the authority boundary', () => {
    const current = extractedTask({
      status: 'in-progress', studentEdited: true,
      corrections: [
        { field: 'status', originalValue: 'submitted', correctedValue: 'todo', correctedAt: '2026-09-16T12:00:00.000Z' },
        { field: 'status', originalValue: 'todo', correctedValue: 'in-progress', correctedAt: '2026-09-18T12:00:00.000Z' },
      ],
    });
    const merged = mergeExtractedTask(current, extractedTask({ status: 'submitted', updatedAt: '2026-09-17T00:00:00.000Z' }));
    expect(merged.status).toBe('in-progress');
  });

  it('does not turn a second student correction into a false LMS date conflict', () => {
    const original = extractedTask();
    const onceCorrected = extractedTask({
      due: { ...original.due, iso: '2026-09-18T21:00:00.000Z', confidence: 'confirmed' },
      studentEdited: true,
      corrections: [{ field: 'due.iso', originalValue: original.due.iso, correctedValue: '2026-09-18T21:00:00.000Z', correctedAt: NOW }],
    });
    const twiceCorrected = extractedTask({
      due: { ...onceCorrected.due, iso: '2026-09-19T21:00:00.000Z' },
      studentEdited: true,
      corrections: [...onceCorrected.corrections, { field: 'due.iso', originalValue: onceCorrected.due.iso, correctedValue: '2026-09-19T21:00:00.000Z', correctedAt: '2026-09-16T13:00:00.000Z' }],
    });
    const merged = mergeExtractedTask(twiceCorrected, original);
    expect(merged.due.iso).toBe('2026-09-19T21:00:00.000Z');
    expect(merged.dueConflict).toBeNull();
    expect(merged.dueHistory).toEqual([]);
  });

  it('does not let an undated low-confidence sighting erase a known deadline', () => {
    const current = extractedTask();
    const weak = extractedTask({
      due: { ...current.due, iso: null, raw: '', confidence: 'low' },
    });
    const merged = mergeExtractedTask(current, weak);
    expect(merged.due).toEqual(current.due);
    expect(merged.dueHistory).toEqual([]);
  });

  it('does not raise a conflict for an undated sighting of a corrected deadline', () => {
    const current = extractedTask({
      due: { ...extractedTask().due, iso: '2025-09-24T21:00:00.000Z', confidence: 'confirmed' },
      corrections: [{ field: 'due.iso', originalValue: '2025-09-17T21:00:00.000Z', correctedValue: '2025-09-24T21:00:00.000Z', correctedAt: NOW }],
      studentEdited: true,
    });
    const merged = mergeExtractedTask(current, extractedTask({ due: { ...current.due, iso: null, confidence: 'low' } }));
    expect(merged.due.iso).toBe(current.due.iso);
    expect(merged.dueConflict).toBeNull();
  });

  it('ignores a medium-confidence sighting weaker than the original LMS date', () => {
    const original = extractedTask();
    const current = extractedTask({
      due: { ...original.due, iso: '2026-09-19T21:00:00.000Z', confidence: 'confirmed' },
      corrections: [{ field: 'due.iso', originalValue: original.due.iso, correctedValue: '2026-09-19T21:00:00.000Z', correctedAt: NOW }],
      studentEdited: true,
    });
    const incoming = extractedTask({ due: { ...original.due, iso: '2026-09-24T21:00:00.000Z', confidence: 'medium' } });
    const merged = mergeExtractedTask(current, incoming);
    expect(merged.due.iso).toBe(current.due.iso);
    expect(merged.dueConflict).toBeNull();
  });

  it('clears a due conflict once the effective date matches Learn again', () => {
    const current = extractedTask({
      due: { ...extractedTask().due, iso: '2025-09-24T21:00:00.000Z', confidence: 'confirmed' },
      corrections: [{ field: 'due.iso', originalValue: '2025-09-17T21:00:00.000Z', correctedValue: '2025-09-24T21:00:00.000Z', correctedAt: NOW }],
      studentEdited: true,
      dueConflict: { observed: { iso: '2025-09-24T21:00:00.000Z', raw: 'Due Sep 24', observedAt: NOW, provenance: extractedTask().provenance } },
    });
    const merged = mergeExtractedTask(current, extractedTask({ due: { ...current.due, iso: '2025-09-24T21:00:00.000Z' } }));
    expect(merged.dueConflict).toBeNull();
  });

  it('keeps a conflict when Learn repeats its moved date but the student value differs', () => {
    const current = extractedTask({
      due: { ...extractedTask().due, iso: '2025-09-19T21:00:00.000Z', confidence: 'confirmed' },
      corrections: [{ field: 'due.iso', originalValue: '2025-09-17T21:00:00.000Z', correctedValue: '2025-09-19T21:00:00.000Z', correctedAt: NOW }],
      studentEdited: true,
      dueConflict: { observed: { iso: '2025-09-24T21:00:00.000Z', raw: 'Due Sep 24', observedAt: NOW, provenance: extractedTask().provenance } },
    });
    const merged = mergeExtractedTask(current, extractedTask({ due: { ...current.due, iso: '2025-09-24T21:00:00.000Z' } }));
    expect(merged.dueConflict?.observed.iso).toBe('2025-09-24T21:00:00.000Z');
  });

  it('preserves a title/weight correction even when the rescan brings weaker due-date evidence', () => {
    // Regression: a student-edited task whose only correction is on title
    // (not due.iso) must still keep its corrected title/weight when the
    // incoming row happens to carry a lower-confidence or undated due date.
    // The generic "weaker evidence" guard used to run first and discard the
    // student's edit before the studentEdited-preserving branch ever saw it.
    const current = extractedTask({
      title: 'Student title',
      weight: 25,
      status: 'graded',
      due: { ...extractedTask().due, iso: '2026-09-19T21:00:00.000Z', confidence: 'confirmed' },
      corrections: [{ field: 'title', originalValue: 'Synthetic assignment', correctedValue: 'Student title', correctedAt: NOW }],
      studentEdited: true,
    });
    const incoming = extractedTask({
      title: 'Synthetic assignment',
      weight: 15,
      status: 'todo',
      due: { ...extractedTask().due, iso: '2026-09-24T21:00:00.000Z', confidence: 'high' },
    });
    const merged = mergeExtractedTask(current, incoming);

    expect(merged.title).toBe('Student title');
    expect(merged.weight).toBe(25);
    expect(merged.studentEdited).toBe(true);
    expect(merged.status).toBe('graded');
    expect(merged.due.iso).toBe('2026-09-19T21:00:00.000Z');
  });

  it('caps retained moves at ten entries', () => {
    let stored = extractedTask();
    for (let index = 1; index <= 11; index += 1) {
      const iso = `2026-10-${String(index + 10).padStart(2, '0')}T21:00:00.000Z`;
      stored = mergeExtractedTask(stored, extractedTask({ due: { ...stored.due, iso, raw: `Due ${index}` } }));
    }
    expect(stored.dueHistory).toHaveLength(10);
    expect(stored.dueHistory[0]?.raw).toBe('Due 1');
  });

  it('serializes a correction and extraction upsert without losing the correction', async () => {
    const db = await openDatabase(DB);
    const task = extractedTask();
    const tasks = new Repository(db, STORE.tasks, courseTaskSchema);
    await tasks.put(task);
    await Promise.all([
      updateTask(db, task.id, (current) => ({ ...current, title: 'Student title', studentEdited: true, corrections: [{ field: 'title', originalValue: current.title, correctedValue: 'Student title', correctedAt: NOW }] })),
      upsertExtractedTask(db, extractedTask({ title: 'Learn title' }), () => false),
    ]);
    const stored = await tasks.get(task.id);
    expect(stored?.title).toBe('Student title');
    db.close();
  });
});
