import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentSessionSchema } from '@/core/session';
import { deleteDatabase, openDatabase } from '@/core/storage/db';
import { sessionRepository } from '@/core/storage/repositories';
import { FakeTabs } from '@/test/fakeTabs';
import { NAVIGATION_MARKERS_KEY } from '@/platform/tabs';
import { closeSessionWorkspace, onTabRemoved, onTabUpdated } from './workspaceEvents';

const NOW = '2026-03-02T12:00:00.000Z';
let sessionStore: Record<string, unknown>;

function makeSession(overrides: Partial<Parameters<typeof agentSessionSchema.parse>[0]> = {}) {
  return agentSessionSchema.parse({
    id: 'session-1',
    title: 'CP363 · Assignment 2',
    goal: 'Work on Assignment 2',
    courseId: 'course-1',
    taskId: 'task-1',
    createdAt: NOW,
    updatedAt: NOW,
    workspace: {
      groupId: 100,
      groupTitle: 'Motion · CP363 · Assignment 2',
      sessionKey: 'session-1',
      ownedTabIds: [],
      adoptedTabIds: [],
      releasedTabIds: [],
    },
    ...overrides,
  });
}

async function putSession(session: ReturnType<typeof makeSession>) {
  const db = await openDatabase();
  await sessionRepository(db).put(session);
  db.close();
}

async function getSession() {
  const db = await openDatabase();
  const found = await sessionRepository(db).get('session-1');
  db.close();
  return found;
}

beforeEach(async () => {
  await deleteDatabase('motion');
  sessionStore = {};
  vi.stubGlobal('chrome', {
    runtime: { id: 'extension-id' },
    storage: {
      session: {
        get: vi.fn(async (key: string) => ({ [key]: sessionStore[key] })),
        set: vi.fn(async (values: Record<string, unknown>) => Object.assign(sessionStore, values)),
        remove: vi.fn(async (key: string) => { delete sessionStore[key]; }),
      },
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('workspace ownership events', () => {
  it('releases a user-closed tab so a later reconciliation cannot re-add it', async () => {
    await putSession(makeSession({ workspace: {
      groupId: 100,
      groupTitle: 'Motion · CP363 · Assignment 2',
      sessionKey: 'session-1',
      ownedTabIds: [7],
      adoptedTabIds: [],
      releasedTabIds: [],
    } }));

    await onTabRemoved(7);
    const updated = await getSession();
    expect(updated?.workspace.ownedTabIds).not.toContain(7);
    expect(updated?.workspace.releasedTabIds).toContain(7);
    expect(updated?.activity.at(-1)?.kind).toBe('user-override');
  });

  it('releases a tab moved out of Motion’s group', async () => {
    await putSession(makeSession({ workspace: {
      groupId: 100,
      groupTitle: 'Motion · CP363 · Assignment 2',
      sessionKey: 'session-1',
      ownedTabIds: [7],
      adoptedTabIds: [],
      releasedTabIds: [],
    } }));

    await onTabUpdated(7, { groupId: -1 }, { id: 7, groupId: -1 } as chrome.tabs.Tab);
    const updated = await getSession();
    expect(updated?.workspace.ownedTabIds).not.toContain(7);
    expect(updated?.workspace.releasedTabIds).toContain(7);
  });

  it('converts a user-navigated owned tab to adopted and never closes it', async () => {
    await putSession(makeSession({ workspace: {
      groupId: 100,
      groupTitle: 'Motion · CP363 · Assignment 2',
      sessionKey: 'session-1',
      ownedTabIds: [7],
      adoptedTabIds: [],
      releasedTabIds: [],
    } }));

    await onTabUpdated(7, { url: 'https://mylearningspace.wlu.ca/student-page' }, {
      id: 7,
      groupId: 100,
      url: 'https://mylearningspace.wlu.ca/student-page',
    } as chrome.tabs.Tab);
    const updated = await getSession();
    expect(updated?.workspace.ownedTabIds).not.toContain(7);
    expect(updated?.workspace.adoptedTabIds).toContain(7);
    expect(updated?.activity.at(-1)?.kind).toBe('user-override');

    const tabs = new FakeTabs();
    tabs.currentSession = 'session-1';
    tabs.groups.set(100, 'Motion · CP363 · Assignment 2');
    tabs.tabs.set(7, { url: 'https://mylearningspace.wlu.ca/student-page', groupId: 100, operationId: null });
    await closeSessionWorkspace(updated!, tabs);
    expect(tabs.tabs.has(7)).toBe(true);
  });

  it('does not convert Motion navigation into a user override', async () => {
    await putSession(makeSession({ workspace: {
      groupId: 100,
      groupTitle: 'Motion · CP363 · Assignment 2',
      sessionKey: 'session-1',
      ownedTabIds: [7],
      adoptedTabIds: [],
      releasedTabIds: [],
    } }));
    sessionStore[NAVIGATION_MARKERS_KEY] = { '7': 'motion-nav-1' };

    await onTabUpdated(7, { url: 'https://mylearningspace.wlu.ca/motion-page' }, {
      id: 7,
      groupId: 100,
      url: 'https://mylearningspace.wlu.ca/motion-page',
    } as chrome.tabs.Tab);
    const updated = await getSession();
    expect(updated?.workspace.ownedTabIds).toContain(7);
    expect(updated?.workspace.adoptedTabIds).not.toContain(7);
    expect(sessionStore[NAVIGATION_MARKERS_KEY]).toEqual({});
  });

  it('closes only same-session owned tabs and leaves adopted tabs', async () => {
    const tabs = new FakeTabs();
    tabs.currentSession = 'session-1';
    tabs.groups.set(100, 'Motion · CP363 · Assignment 2');
    tabs.tabs.set(7, { url: 'https://mylearningspace.wlu.ca/a', groupId: 100, operationId: 'owned' });
    tabs.tabs.set(8, { url: 'https://mylearningspace.wlu.ca/student', groupId: 100, operationId: null });
    tabs.tabs.set(9, { url: 'https://mylearningspace.wlu.ca/released', groupId: 100, operationId: 'released' });
    const session = makeSession({ workspace: {
      groupId: 100,
      groupTitle: 'Motion · CP363 · Assignment 2',
      sessionKey: 'session-1',
      ownedTabIds: [7, 9],
      adoptedTabIds: [8],
      releasedTabIds: [9],
    } });

    await closeSessionWorkspace(session, tabs);
    expect(tabs.tabs.has(7)).toBe(false);
    expect(tabs.tabs.has(8)).toBe(true);
    expect(tabs.tabs.has(9)).toBe(true);
  });
});
