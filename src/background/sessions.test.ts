import { beforeEach, describe, expect, it, vi } from 'vitest';
import { agentSessionSchema } from '@/core/session';
import { deleteDatabase, openDatabase } from '@/core/storage/db';
import { sessionRepository } from '@/core/storage/repositories';
import { FakeTabs } from '@/test/fakeTabs';

const NOW = '2026-09-16T12:00:00.000Z';
const { runModelTurn } = vi.hoisted(() => ({ runModelTurn: vi.fn() }));

vi.mock('./modelTurn', () => ({
  recoverStaleModelRequests: vi.fn(),
  runFallbackPlan: vi.fn(),
  runModelTurn,
  stopGeneration: vi.fn(),
}));

import { adoptWorkspaceTab, createOrReuseWorkspaceSession, handleSessionMessage, sessionCreateBehavior } from './sessions';

function makeSession(status: 'completed' | 'archived') {
  return agentSessionSchema.parse({
    id: 'session-1',
    title: 'Synthetic terminal session',
    goal: 'Test terminal session protection',
    status,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

beforeEach(async () => {
  await deleteDatabase('motion');
  runModelTurn.mockReset();
  const values: Record<string, unknown> = {};
  vi.stubGlobal('chrome', {
    storage: {
      session: {
        get: vi.fn(async (key: string | string[]) => typeof key === 'string'
          ? { [key]: values[key] }
          : Object.fromEntries(key.map((item) => [item, values[item]]))),
        set: vi.fn(async (next: Record<string, unknown>) => Object.assign(values, next)),
      },
    },
  });
});

describe('session lifecycle', () => {
  it('opens known resources when a resolved task starts from a course home', () => {
    expect(sessionCreateBehavior('course-home', true, true)).toBe('open-related');
    expect(sessionCreateBehavior(undefined, true, true)).toBe('open-related');
  });
});

describe('terminal AgentSession entry points', () => {
  it.each(['completed', 'archived'] as const)('refuses every mutating entry for %s sessions', async (status) => {
    const db = await openDatabase();
    await sessionRepository(db).put(makeSession(status));
    db.close();

    const message = await handleSessionMessage({ type: 'session-message', sessionId: 'session-1', text: 'Continue' , tabId: null });
    const command = await handleSessionMessage({ type: 'session-command', sessionId: 'session-1', command: 'resume' });
    const source = await handleSessionMessage({ type: 'session-source', sessionId: 'session-1', url: 'https://lms.example.test/page', excluded: true });
    const tab = await handleSessionMessage({ type: 'session-tab', sessionId: 'session-1', tabId: 7, op: 'adopt' });
    const select = await handleSessionMessage({ type: 'session-select', sessionId: 'session-1' });

    for (const result of [message, command, source, tab, select]) {
      expect(result).toEqual(expect.objectContaining({ refusal: {
        kind: 'terminal-session',
        status,
        message: expect.stringContaining(status),
      } }));
    }
    expect(runModelTurn).not.toHaveBeenCalled();

    const readDb = await openDatabase();
    const stored = await sessionRepository(readDb).get('session-1');
    expect(stored?.status).toBe(status);
    expect(stored?.revision).toBe(0);
    readDb.close();
  });

  it('retries the failed follow-up turn, not the original session goal (SOL-18)', async () => {
    const db = await openDatabase();
    await sessionRepository(db).put(agentSessionSchema.parse({
      id: 'session-1',
      title: 'Synthetic session',
      goal: 'Work on Assignment 2',
      status: 'active',
      createdAt: NOW,
      updatedAt: NOW,
      conversation: [
        { id: 'm1', role: 'student', text: 'Work on Assignment 2', at: NOW },
        { id: 'm2', role: 'student', text: 'Summarize the rubric', at: NOW },
      ],
    }));
    db.close();
    runModelTurn.mockResolvedValueOnce(undefined);

    await handleSessionMessage({ type: 'session-command', sessionId: 'session-1', command: 'retry-model' });

    expect(runModelTurn).toHaveBeenCalledWith('session-1', 'Summarize the rubric', {}, true);
  });

  it('accepts a follow-up message after a workflow has completed its plan', async () => {
    const db = await openDatabase();
    await sessionRepository(db).put(agentSessionSchema.parse({ ...makeSession('completed'), status: 'waiting' }));
    db.close();
    runModelTurn.mockResolvedValueOnce(undefined);

    const result = await handleSessionMessage({ type: 'session-message', sessionId: 'session-1', text: 'Can you summarize that?', tabId: null });

    expect(result).not.toHaveProperty('refusal');
    expect(runModelTurn).toHaveBeenCalledWith('session-1', 'Can you summarize that?');
  });
});

describe('workspace tab focus', () => {
  it('focuses only a live tab still recorded in the selected workspace', async () => {
    const db = await openDatabase();
    await sessionRepository(db).put(agentSessionSchema.parse({
      id: 'session-focus',
      title: 'Synthetic workspace',
      goal: 'Focus a tab',
      status: 'active',
      createdAt: NOW,
      updatedAt: NOW,
      workspace: { groupId: 4, groupTitle: 'Motion · synthetic', sessionKey: 'test', ownedTabIds: [7], adoptedTabIds: [], releasedTabIds: [] },
    }));
    db.close();
    const get = vi.fn(async () => ({ id: 7, windowId: 2 }));
    const update = vi.fn(async () => undefined);
    Object.assign(chrome, { tabs: { ...(chrome.tabs ?? {}), get, update }, windows: { update } });

    await expect(handleSessionMessage({ type: 'session-tab', sessionId: 'session-focus', tabId: 7, op: 'focus' }))
      .resolves.toEqual({ updated: true, focused: true });
    expect(update).toHaveBeenCalledWith(2, { focused: true });
    expect(update).toHaveBeenCalledWith(7, { active: true });

    await expect(handleSessionMessage({ type: 'session-tab', sessionId: 'session-focus', tabId: 8, op: 'focus' }))
      .resolves.toEqual({ updated: false, reason: 'That tab is no longer in this Motion workspace.' });
  });
});

describe('popup workspace session', () => {
  it('reuses only the exact page in the same browser session without rekeying workspace IDs', async () => {
    const input = {
      title: 'Synthetic assignment',
      goal: 'Work on Synthetic assignment.',
      courseId: 'course-1',
      pageUrl: 'https://lms.example.test/course-1/assignment-2',
      browserSessionKey: 'browser-session',
    };
    const first = await createOrReuseWorkspaceSession(input);
    const second = await createOrReuseWorkspaceSession(input);

    expect(second.id).toBe(first.id);
    expect(second.workspace.adoptedTabIds).toEqual([]);
    expect(second.workspace.ownedTabIds).toEqual([]);
    expect(second.workspace.sessionKey).toBe('browser-session');

    const afterRestart = await createOrReuseWorkspaceSession({ ...input, browserSessionKey: 'new-browser-session' });
    expect(afterRestart.id).not.toBe(first.id);
  });

  it('will not attach a current tab to retained IDs from an earlier browser session', async () => {
    const session = await createOrReuseWorkspaceSession({
      title: 'Synthetic assignment', goal: 'Work on Synthetic assignment.', courseId: 'course-1',
      pageUrl: 'https://lms.example.test/course-1/assignment-2', browserSessionKey: 'old-browser-session',
    });
    const tabs = new FakeTabs();
    const tabId = tabs.addStudentTab('https://lms.example.test/course-1/assignment-2');

    await expect(adoptWorkspaceTab(session.id, tabId, tabs)).resolves.toEqual({
      updated: false,
      reason: 'This workspace belongs to an earlier browser session.',
    });
    expect((await sessionRepository(await openDatabase()).get(session.id))?.workspace.adoptedTabIds).toEqual([]);
  });

  it('refuses to group a tab that navigated away from the session page', async () => {
    const tabs = new FakeTabs();
    const session = await createOrReuseWorkspaceSession({
      title: 'Synthetic assignment', goal: 'Work on Synthetic assignment.', courseId: 'course-1',
      pageUrl: 'https://lms.example.test/course-1/assignment-2', browserSessionKey: tabs.currentSession,
    });
    const tabId = tabs.addStudentTab('https://lms.example.test/course-1/quiz-attempt');

    await expect(adoptWorkspaceTab(session.id, tabId, tabs)).resolves.toEqual({
      updated: false,
      reason: 'That page changed before Motion could add it to this workspace.',
    });
    expect(tabs.groups.size).toBe(0);
  });

  it('preserves a released tab and a tab already grouped by the student', async () => {
    const tabs = new FakeTabs();
    const session = await createOrReuseWorkspaceSession({
      title: 'Synthetic assignment', goal: 'Work on Synthetic assignment.', courseId: 'course-1',
      pageUrl: 'https://lms.example.test/course-1/assignment-2', browserSessionKey: tabs.currentSession,
    });
    const releasedTab = tabs.addStudentTab('https://lms.example.test/course-1/assignment-2');
    const groupedTab = tabs.addStudentTab('https://lms.example.test/course-1/assignment-2');
    await tabs.ensureGroup({ title: 'Student research', color: 'grey' }, [groupedTab]);
    const db = await openDatabase();
    const stored = await sessionRepository(db).get(session.id);
    await sessionRepository(db).put({ ...stored!, workspace: { ...stored!.workspace, releasedTabIds: [releasedTab] } });
    db.close();

    await expect(adoptWorkspaceTab(session.id, releasedTab, tabs)).resolves.toEqual({
      updated: false,
      reason: 'This tab was removed from the Motion workspace.',
    });
    await expect(adoptWorkspaceTab(session.id, groupedTab, tabs)).resolves.toEqual({
      updated: false,
      reason: 'This tab is in a group chosen by the student.',
    });
    expect((await tabs.get(groupedTab))?.groupId).not.toBeNull();
  });

  it('re-reads the tab immediately before grouping to preserve a navigation race', async () => {
    const tabs = new FakeTabs();
    const session = await createOrReuseWorkspaceSession({
      title: 'Synthetic assignment', goal: 'Work on Synthetic assignment.', courseId: 'course-1',
      pageUrl: 'https://lms.example.test/course-1/assignment-2', browserSessionKey: tabs.currentSession,
    });
    const tabId = tabs.addStudentTab('https://lms.example.test/course-1/assignment-2');
    const get = tabs.get.bind(tabs);
    let reads = 0;
    vi.spyOn(tabs, 'get').mockImplementation(async (id) => {
      reads += 1;
      if (reads === 2) tabs.tabs.get(id)!.url = 'https://lms.example.test/course-1/quiz-attempt';
      return get(id);
    });

    await expect(adoptWorkspaceTab(session.id, tabId, tabs)).resolves.toEqual({
      updated: false,
      reason: 'That page changed before Motion could add it to this workspace.',
    });
    expect(tabs.groups.size).toBe(0);
  });
});
