import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checklistSchema,
  courseTaskSchema,
  noteSchema,
  EXTRACTION_VERSION,
  type CourseTask,
  type PageType,
} from '@/core/domain';
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
        remove: vi.fn(async (key: string) => {
          delete sessionStore[key];
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

describe('building a checklist from assignment instructions', () => {
  const CONTENT = {
    pageType: 'assignment',
    title: 'Assignment 2 — Normalization',
    url: 'https://mylearningspace.wlu.ca/d2l/lms/dropbox/user/folder_submit_files.d2l?ou=363&db=101',
    text: 'Assignment 2 instructions',
    headings: ['Assignment 2'],
    links: [],
    instructionBlocks: [
      { kind: 'paragraph', text: 'This assignment explores normalization.' },
      { kind: 'list-item', text: 'You must cite at least 3 peer-reviewed sources in APA format.' },
      { kind: 'list-item', text: 'Submissions should be at least 1500 words.' },
      { kind: 'table-cell', text: 'Depth of analysis — worth 40 marks' },
    ],
    capturedAt: NOW,
    warnings: [],
  };

  function stubContentScript(response: unknown) {
    (chrome.tabs.sendMessage as ReturnType<typeof vi.fn>).mockImplementation(async () => response);
  }

  it('creates a checklist whose every item traces back to the instructions', async () => {
    stubContentScript({ content: CONTENT });

    const result = (await handleMessage({
      type: 'build-checklist',
      tabId: 7,
      taskId: null,
    })) as { checklistId: string; items: number };

    expect(result.items).toBeGreaterThan(0);

    const db = await openDatabase();
    const checklists = new Repository(db, STORE.checklists, checklistSchema);
    const stored = await checklists.get(result.checklistId);

    expect(stored?.items.length).toBe(result.items);
    for (const item of stored?.items ?? []) {
      expect(item.provenance.sourceUrl).toBe(CONTENT.url);
      expect(item.provenance.strategy).toMatch(/^requirement:/);
      expect(item.done).toBe(false);
    }
    // The prose sentence that states no requirement is not on the list.
    expect(stored?.items.map((i) => i.text)).not.toContain(
      'This assignment explores normalization.',
    );
  });

  it('says it found nothing rather than inventing requirements', async () => {
    stubContentScript({
      content: { ...CONTENT, instructionBlocks: [{ kind: 'paragraph', text: 'Welcome to week 6.' }] },
    });

    const result = (await handleMessage({ type: 'build-checklist', tabId: 7, taskId: null })) as {
      checklistId: string | null;
      reason?: string;
    };

    expect(result.checklistId).toBeNull();
    expect(result.reason).toMatch(/could not find anything stated as a requirement/i);
  });

  it('reports plainly when the page has no instructions on it', async () => {
    stubContentScript({ content: { ...CONTENT, instructionBlocks: [] } });
    const result = (await handleMessage({ type: 'build-checklist', tabId: 7, taskId: null })) as {
      checklistId: string | null;
      reason?: string;
    };
    expect(result.checklistId).toBeNull();
    expect(result.reason).toMatch(/does not look like it has assignment instructions/i);
  });

  it('reports a page it could not read instead of throwing', async () => {
    stubContentScript(undefined);
    const result = (await handleMessage({ type: 'build-checklist', tabId: 7, taskId: null })) as {
      checklistId: string | null;
      reason?: string;
    };
    expect(result.checklistId).toBeNull();
    expect(result.reason).toMatch(/could not read/i);
  });

  it('lets the student tick an item off', async () => {
    stubContentScript({ content: CONTENT });
    const created = (await handleMessage({
      type: 'build-checklist',
      tabId: 7,
      taskId: null,
    })) as { checklistId: string };

    const db = await openDatabase();
    const checklists = new Repository(db, STORE.checklists, checklistSchema);
    const first = (await checklists.get(created.checklistId))!.items[0]!;

    await handleMessage({
      type: 'toggle-requirement',
      checklistId: created.checklistId,
      requirementId: first.id,
      done: true,
    });

    const updated = await checklists.get(created.checklistId);
    expect(updated?.items.find((i) => i.id === first.id)?.done).toBe(true);
  });
});

describe('reviewing a draft against a checklist', () => {
  it('reports coverage without storing the draft anywhere', async () => {
    (chrome.tabs.sendMessage as ReturnType<typeof vi.fn>).mockImplementation(async () => ({
      content: {
        pageType: 'assignment',
        title: 'A2',
        url: 'https://mylearningspace.wlu.ca/d2l/lms/dropbox/user/folder_submit_files.d2l?ou=363',
        text: '',
        headings: [],
        links: [],
        instructionBlocks: [
          { kind: 'list-item', text: 'You must discuss functional dependencies.' },
          { kind: 'list-item', text: 'You must cite at least 3 sources.' },
        ],
        capturedAt: NOW,
        warnings: [],
      },
    }));

    const created = (await handleMessage({
      type: 'build-checklist',
      tabId: 7,
      taskId: null,
    })) as { checklistId: string };

    const result = (await handleMessage({
      type: 'review-draft',
      checklistId: created.checklistId,
      draft: 'My report discusses functional dependencies across the schema in detail.',
    })) as { review: { findings: { coverage: string }[] } | null; summary: string };

    expect(result.review?.findings).toHaveLength(2);
    expect(result.review?.findings.some((f) => f.coverage === 'addressed')).toBe(true);
    expect(result.summary).toBeTruthy();

    // The student's own draft is their work in progress; Motion keeps no copy.
    const db = await openDatabase();
    const checklists = new Repository(db, STORE.checklists, checklistSchema);
    const stored = JSON.stringify(await checklists.get(created.checklistId));
    expect(stored).not.toContain('My report discusses');
  });

  it('reports a missing checklist rather than throwing', async () => {
    const result = (await handleMessage({
      type: 'review-draft',
      checklistId: 'gone',
      draft: 'text',
    })) as { review: null; summary: string };
    expect(result.review).toBeNull();
    expect(result.summary).toMatch(/no longer available/i);
  });
});

describe('drafting coursework for review', () => {
  function stubModel(availability: string, output?: string) {
    vi.stubGlobal('LanguageModel', {
      availability: async () => availability,
      create: async () => ({
        prompt: async () => output ?? '',
        promptStreaming: async function* () {
          yield output ?? '';
        },
        destroy: () => undefined,
      }),
    });
  }

  it('stores the draft as a labelled generated block', async () => {
    stubModel('available', 'A first draft about normalization.');

    const result = (await handleMessage({
      type: 'compose-draft',
      kind: 'full-draft',
      checklistId: null,
      title: 'Assignment 2',
    })) as { noteId: string; draft: string; label: string };

    expect(result.draft).toContain('normalization');
    expect(result.label).toMatch(/rewrite it in your own words/i);

    const db = await openDatabase();
    const notes = new Repository(db, STORE.notes, noteSchema);
    const stored = await notes.get(result.noteId);

    // The label travels with the data, not with whichever screen renders it.
    expect(stored?.blocks[0]?.origin).toBe('generated');
    expect(stored?.blocks[0]?.generatedBy).toBe('chrome-on-device');
  });

  it('surfaces claims the draft could not support', async () => {
    stubModel('available', 'Redundancy falls by 40% [needs a source]. Updates get simpler.');
    const result = (await handleMessage({
      type: 'compose-draft',
      kind: 'full-draft',
      checklistId: null,
      title: 'A2',
    })) as { unsupported: string[] };
    expect(result.unsupported).toHaveLength(1);
    expect(result.unsupported[0]).toContain('40%');
  });

  it('explains an unavailable model instead of failing silently', async () => {
    stubModel('unavailable');
    const result = (await handleMessage({
      type: 'compose-draft',
      kind: 'outline',
      checklistId: null,
      title: 'A2',
    })) as { noteId: string | null; reason?: string };

    expect(result.noteId).toBeNull();
    expect(result.reason).toMatch(/does not have an on-device model/i);
  });

  it('tells the student a download is needed rather than pretending to draft', async () => {
    stubModel('downloadable');
    const result = (await handleMessage({
      type: 'compose-draft',
      kind: 'outline',
      checklistId: null,
      title: 'A2',
    })) as { noteId: string | null; reason?: string };
    expect(result.noteId).toBeNull();
    expect(result.reason).toMatch(/download/i);
  });

  it('reports a generation failure without leaving a half-written note', async () => {
    vi.stubGlobal('LanguageModel', {
      availability: async () => 'available',
      create: async () => ({
        prompt: async () => {
          throw new Error('Model ran out of context.');
        },
        promptStreaming: async function* () {},
        destroy: () => undefined,
      }),
    });

    const result = (await handleMessage({
      type: 'compose-draft',
      kind: 'full-draft',
      checklistId: null,
      title: 'A2',
    })) as { noteId: string | null; reason?: string };

    expect(result.noteId).toBeNull();
    expect(result.reason).toMatch(/ran out of context/i);

    const db = await openDatabase();
    const notes = new Repository(db, STORE.notes, noteSchema);
    expect((await notes.all()).records).toHaveLength(0);
  });

  it('reports model availability for the panel', async () => {
    stubModel('available');
    const status = (await handleMessage({ type: 'model-status' })) as { availability: string };
    expect(status.availability).toBe('available');
  });
});

describe('talking to the content script', () => {
  it('addresses the main frame explicitly', async () => {
    const send = chrome.tabs.sendMessage as ReturnType<typeof vi.fn>;
    send.mockClear();
    send.mockImplementation(async () => undefined);

    await handleMessage({ type: 'request-extraction', tabId: 11 });

    expect(send).toHaveBeenCalledWith(11, { type: 'motion:extract' }, { frameId: 0 });
  });

  it('retries a listener that has not registered yet before giving up', async () => {
    const send = chrome.tabs.sendMessage as ReturnType<typeof vi.fn>;
    send.mockClear();
    let calls = 0;
    send.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) throw new Error('Could not establish connection. Receiving end does not exist.');
      return undefined;
    });

    const result = (await handleMessage({ type: 'request-extraction', tabId: 11 })) as { requested: boolean };

    expect(calls).toBe(2);
    expect(result).toEqual({ requested: true });
    send.mockImplementation(async () => undefined);
  });

  it('reports that extraction was not requested when no content script answers', async () => {
    const send = chrome.tabs.sendMessage as ReturnType<typeof vi.fn>;
    send.mockClear();
    send.mockRejectedValue(new Error('Could not establish connection. Receiving end does not exist.'));

    const result = (await handleMessage({ type: 'request-extraction', tabId: 11 })) as { requested: boolean };

    expect(result).toEqual({ requested: false });
    send.mockImplementation(async () => undefined);
  });
});

describe('the connection state the panel receives', () => {
  const observation = (pageType: PageType) => ({
    type: 'page-observed' as const,
    url: 'https://mylearningspace.wlu.ca/d2l/home/999999?ou=999999',
    pageType,
    title: 'Course',
    detectionConfidence: 'high' as const,
    warnings: [],
    restricted: false,
  });

  it('does not call an unsupported page supported', async () => {
    await handleMessage(observation('unsupported'));
    const state = (await handleMessage({ type: 'get-state' })) as { connection: string };
    expect(state.connection).toBe('unsupported');
  });

  it('surfaces a signed-out page as its own state', async () => {
    await handleMessage(observation('signed-out'));
    const state = (await handleMessage({ type: 'get-state' })) as { connection: string };
    expect(state.connection).toBe('signed-out');
  });

  it('calls a readable course page supported', async () => {
    await handleMessage(observation('course-home'));
    const state = (await handleMessage({ type: 'get-state' })) as { connection: string };
    expect(state.connection).toBe('supported');
  });
});

describe('an observation from a restricted page', () => {
  it('stores nothing and drops the previous page rather than leaving it on screen', async () => {
    await handleMessage({
      type: 'page-observed',
      url: 'https://mylearningspace.wlu.ca/d2l/home/999999?ou=999999',
      pageType: 'course-home',
      title: 'Course',
      detectionConfidence: 'high',
      warnings: [],
      restricted: false,
    });

    const result = (await handleMessage({
      type: 'page-observed',
      url: 'https://mylearningspace.wlu.ca/d2l/lms/quizzing/user/attempt/201?ou=999999',
      pageType: 'quiz-attempt',
      title: 'Quiz',
      detectionConfidence: 'high',
      warnings: [],
      restricted: true,
    })) as { stored: boolean };

    expect(result).toEqual({ stored: false });
    const state = (await handleMessage({ type: 'get-state' })) as { connection: string; page: { url: string | null } };
    expect(state.connection).toBe('idle');
    expect(state.page.url).toBeNull();
  });
});
