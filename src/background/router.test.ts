import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { courseTaskSchema, noteSchema, EXTRACTION_VERSION, type CourseTask } from '@/core/domain';
import { openDatabase, deleteDatabase } from '@/core/storage/db';
import { Repository } from '@/core/storage/repository';
import { STORE } from '@/core/storage/schema';
import { handleMessage } from './router';

/**
 * Exercises the worker's data handling through the same entry point the real
 * message listener uses, so the tests cover the path that actually runs.
 */

const NOW = '2026-03-02T12:00:00.000Z';

function task(overrides: Partial<CourseTask> = {}): CourseTask {
  return courseTaskSchema.parse({
    id: 'd2l:363:relational-algebra',
    courseId: 'd2l:363',
    title: 'Relational Algebra Worksheet',
    kind: 'assignment',
    due: {
      iso: '2025-10-15T03:59:00.000Z',
      raw: 'Due on Oct 14, 2025 11:59 PM',
      zoneEvidence: 'assumed-local',
      timeAssumed: false,
      confidence: 'high',
    },
    status: 'todo',
    weight: 15,
    provenance: {
      sourceUrl: 'https://mylearningspace.wlu.ca/d2l/lms/dropbox/user/folders_list.d2l?ou=363',
      pageTitle: 'Assignments',
      platformId: 'd2l',
      pageType: 'assignment-list',
      capturedAt: NOW,
      extractionVersion: EXTRACTION_VERSION,
    },
    corrections: [],
    studentEdited: false,
    manual: false,
    archived: false,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  });
}

let sessionStore: Record<string, unknown> = {};

beforeEach(async () => {
  await deleteDatabase('motion');
  sessionStore = {};
  vi.stubGlobal('chrome', {
    storage: {
      session: {
        get: vi.fn(async (key: string) => ({ [key]: sessionStore[key] })),
        set: vi.fn(async (values: Record<string, unknown>) => {
          Object.assign(sessionStore, values);
        }),
        clear: vi.fn(async () => {
          sessionStore = {};
        }),
      },
      local: { clear: vi.fn(async () => undefined) },
    },
    tabs: { sendMessage: vi.fn(async () => undefined) },
    runtime: { id: 'test-extension-id' },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function tasksRepo() {
  const db = await openDatabase();
  return new Repository(db, STORE.tasks, courseTaskSchema);
}

describe('storing an extraction', () => {
  it('writes extracted tasks', async () => {
    const result = (await handleMessage({
      type: 'extraction-result',
      requestId: '00000000-0000-4000-8000-000000000000',
      url: 'https://mylearningspace.wlu.ca/d2l/lms/dropbox/user/folders_list.d2l?ou=363',
      course: null,
      tasks: [task()],
      content: null,
      warnings: [],
    })) as { tasks: number };

    expect(result.tasks).toBe(1);
    const repo = await tasksRepo();
    expect((await repo.all()).records).toHaveLength(1);
  });

  it('does not overwrite a task the student has edited', async () => {
    const repo = await tasksRepo();
    await repo.put(task({ title: 'My own title', studentEdited: true }));

    await handleMessage({
      type: 'extraction-result',
      requestId: '00000000-0000-4000-8000-000000000000',
      url: 'https://mylearningspace.wlu.ca/d2l/lms/dropbox/user/folders_list.d2l?ou=363',
      course: null,
      tasks: [task({ title: 'Scraped title again' })],
      content: null,
      warnings: [],
    });

    const stored = await repo.get('d2l:363:relational-algebra');
    expect(stored?.title).toBe('My own title');
  });

  it('preserves the original creation time on a rescan', async () => {
    const repo = await tasksRepo();
    await repo.put(task({ createdAt: '2025-09-01T00:00:00.000Z' }));

    await handleMessage({
      type: 'extraction-result',
      requestId: '00000000-0000-4000-8000-000000000000',
      url: 'https://mylearningspace.wlu.ca/d2l/lms/dropbox/user/folders_list.d2l?ou=363',
      course: null,
      tasks: [task({ createdAt: NOW })],
      content: null,
      warnings: [],
    });

    const stored = await repo.get('d2l:363:relational-algebra');
    expect(stored?.createdAt).toBe('2025-09-01T00:00:00.000Z');
  });
});

describe('student corrections are additive', () => {
  it('keeps the original value and marks the task as edited', async () => {
    const repo = await tasksRepo();
    await repo.put(task());

    await handleMessage({
      type: 'correct-task',
      taskId: 'd2l:363:relational-algebra',
      field: 'dueIso',
      value: '2025-10-20T03:59:00.000Z',
    });

    const stored = await repo.get('d2l:363:relational-algebra');
    expect(stored?.due.iso).toBe('2025-10-20T03:59:00.000Z');
    expect(stored?.studentEdited).toBe(true);
    // The student's answer is authoritative from here on.
    expect(stored?.due.confidence).toBe('confirmed');
    // ...but what Motion originally read is not thrown away.
    expect(stored?.corrections).toHaveLength(1);
    expect(stored?.corrections[0]).toMatchObject({
      field: 'due.iso',
      originalValue: '2025-10-15T03:59:00.000Z',
    });
    // Nor is the raw source text.
    expect(stored?.due.raw).toBe('Due on Oct 14, 2025 11:59 PM');
  });

  it('records each correction rather than replacing the previous one', async () => {
    const repo = await tasksRepo();
    await repo.put(task());

    await handleMessage({
      type: 'correct-task',
      taskId: 'd2l:363:relational-algebra',
      field: 'title',
      value: 'First fix',
    });
    await handleMessage({
      type: 'correct-task',
      taskId: 'd2l:363:relational-algebra',
      field: 'weight',
      value: 20,
    });

    const stored = await repo.get('d2l:363:relational-algebra');
    expect(stored?.corrections).toHaveLength(2);
    expect(stored?.title).toBe('First fix');
    expect(stored?.weight).toBe(20);
  });

  it('reports rather than throws when the task is gone', async () => {
    const result = (await handleMessage({
      type: 'correct-task',
      taskId: 'does-not-exist',
      field: 'title',
      value: 'x',
    })) as { updated: boolean };
    expect(result.updated).toBe(false);
  });

  it('rejects a value of the wrong type instead of corrupting the record', async () => {
    const repo = await tasksRepo();
    await repo.put(task());

    const result = (await handleMessage({
      type: 'correct-task',
      taskId: 'd2l:363:relational-algebra',
      field: 'status',
      value: 'not-a-real-status',
    })) as { updated: boolean };

    expect(result.updated).toBe(false);
    expect((await repo.get('d2l:363:relational-algebra'))?.status).toBe('todo');
  });
});

describe('restricted pages', () => {
  it('stores nothing at all from a page marked restricted', async () => {
    const result = (await handleMessage({
      type: 'page-observed',
      url: 'https://mylearningspace.wlu.ca/d2l/lms/quizzing/user/attempt/quiz_attempt.d2l?ou=363',
      pageType: 'quiz-attempt',
      title: 'Quiz 2',
      detectionConfidence: 'high',
      warnings: [],
      restricted: true,
    })) as { stored: boolean };

    expect(result.stored).toBe(false);
    expect(sessionStore['lastObservation']).toBeUndefined();
  });

  it('records an ordinary page observation', async () => {
    const result = (await handleMessage({
      type: 'page-observed',
      url: 'https://mylearningspace.wlu.ca/d2l/home/363',
      pageType: 'course-home',
      title: 'CP363',
      detectionConfidence: 'high',
      warnings: [],
      restricted: false,
    })) as { stored: boolean };

    expect(result.stored).toBe(true);
    expect(sessionStore['lastObservation']).toMatchObject({ pageType: 'course-home' });
  });
});

describe('panel state', () => {
  it('sorts dated work first and undated work last', async () => {
    const repo = await tasksRepo();
    await repo.putMany([
      task({ id: 'a', title: 'No date', due: { ...task().due, iso: null } }),
      task({ id: 'b', title: 'Later', due: { ...task().due, iso: '2025-12-01T00:00:00.000Z' } }),
      task({ id: 'c', title: 'Sooner', due: { ...task().due, iso: '2025-10-01T00:00:00.000Z' } }),
    ]);

    const state = (await handleMessage({ type: 'get-state' })) as { tasks: CourseTask[] };
    expect(state.tasks.map((t) => t.title)).toEqual(['Sooner', 'Later', 'No date']);
  });

  it('hides archived work', async () => {
    const repo = await tasksRepo();
    await repo.putMany([task({ id: 'a' }), task({ id: 'b', archived: true })]);
    const state = (await handleMessage({ type: 'get-state' })) as { tasks: CourseTask[] };
    expect(state.tasks).toHaveLength(1);
  });

  it('reports corrupted rows instead of hiding them', async () => {
    const db = await openDatabase();
    const transaction = db.transaction(STORE.tasks, 'readwrite');
    transaction.objectStore(STORE.tasks).put({ id: 'broken', courseId: 'x' });
    await new Promise((resolve) => {
      transaction.oncomplete = resolve;
    });

    const state = (await handleMessage({ type: 'get-state' })) as { corruptedRecords: number };
    expect(state.corruptedRecords).toBe(1);
  });
});

describe('source-linked notes', () => {
  it('stores the captured text as its own block with full provenance', async () => {
    const result = (await handleMessage({
      type: 'create-note',
      title: 'Normalization requirements',
      courseId: 'd2l:363',
      taskId: null,
      capturedText: 'Your submission must include the functional dependencies.',
      sourceUrl:
        'https://mylearningspace.wlu.ca/d2l/lms/dropbox/user/folder_submit_files.d2l?ou=363&db=101',
      pageTitle: 'Assignment 2',
      pageType: 'assignment',
    })) as { noteId: string };

    const db = await openDatabase();
    const notes = new Repository(db, STORE.notes, noteSchema);
    const stored = await notes.get(result.noteId);

    expect(stored?.title).toBe('Normalization requirements');
    expect(stored?.blocks).toHaveLength(1);
    // The origin distinction is what makes AI labelling structural later.
    expect(stored?.blocks[0]?.origin).toBe('captured');
    expect(stored?.blocks[0]?.provenance).toMatchObject({
      pageTitle: 'Assignment 2',
      pageType: 'assignment',
      strategy: 'student-selection',
    });
    // A note without its source is a rumour, so the URL is mandatory.
    expect(stored?.blocks[0]?.provenance?.sourceUrl).toContain('mylearningspace.wlu.ca');
  });

  it('never produces a generated block in a release with no model', async () => {
    const result = (await handleMessage({
      type: 'create-note',
      title: 'Note',
      courseId: null,
      taskId: null,
      capturedText: 'Some text',
      sourceUrl: 'https://mylearningspace.wlu.ca/d2l/home/363',
      pageTitle: 'Home',
      pageType: 'course-home',
    })) as { noteId: string };

    const db = await openDatabase();
    const notes = new Repository(db, STORE.notes, noteSchema);
    const stored = await notes.get(result.noteId);
    expect(stored?.blocks.every((block) => block.origin !== 'generated')).toBe(true);
  });
});
