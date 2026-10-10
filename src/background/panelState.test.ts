import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteDatabase, openDatabase } from '@/core/storage/db';
import { sessionRepository } from '@/core/storage/repositories';
import { buildPanelState, discoveryBusy, PANEL_RECOVERY_INTERVAL_MS } from './panelState';

const { recoverWorkflows } = vi.hoisted(() => ({ recoverWorkflows: vi.fn(async () => undefined) }));
vi.mock('./recovery', () => ({ recoverWorkflows }));

const NOW = '2026-09-16T12:00:00.000Z';

beforeEach(async () => {
  await deleteDatabase('motion');
  recoverWorkflows.mockClear();
  const session: Record<string, unknown> = {
    'motion.activeSessionId': 's1',
    'motion.streaming': { sessionId: 's1', requestKey: 'request-1', text: 'Planning…' },
  };
  vi.stubGlobal('chrome', {
    storage: {
      session: { get: vi.fn(async (key: string | string[]) => typeof key === 'string' ? { [key]: session[key] } : Object.fromEntries(key.map((item) => [item, session[item]]))) },
      local: { get: vi.fn(async () => ({})) },
    },
    tabs: { query: vi.fn(async () => []) },
    permissions: { contains: vi.fn(async () => false) },
    runtime: { id: 'test-extension' },
  });
});

describe('panel agent state', () => {
  it('exposes the selected session summary, active session, and its bounded stream', async () => {
    const db = await openDatabase();
    await sessionRepository(db).put({
      id: 's1', title: 'CP363 · Synthetic Assignment 2', goal: 'Work on Assignment 2', courseId: null, taskId: null,
      status: 'waiting', createdAt: NOW, updatedAt: NOW,
      workspace: { groupId: null, groupTitle: '', sessionKey: null, ownedTabIds: [], adoptedTabIds: [], releasedTabIds: [] },
      plan: { steps: [{ id: 't1-0', title: 'Read instructions', status: 'active' }], currentStepId: 't1-0' },
      blockers: [{ id: 'b1', kind: 'provider', message: 'Open Motion to continue Chrome local AI.' }],
      context: { sources: [] }, artifacts: [], agent: { providerId: null, model: null }, conversation: [], activity: [], workflowIds: [],
      modelTurnGeneration: 1,
      pendingModelRequest: { key: 'request-1', providerId: 'openai', startedAt: NOW, generation: 1 },
    });

    const state = await buildPanelState();
    expect(state.sessions).toEqual([expect.objectContaining({ id: 's1', needsYou: 1, currentStepTitle: 'Read instructions' })]);
    expect(state.activeSession?.id).toBe('s1');
    expect(state.streaming).toEqual({ sessionId: 's1', text: 'Planning…' });
  });

  it('does not expose a stale preview after its durable request claim was cleared', async () => {
    const db = await openDatabase();
    await sessionRepository(db).put({
      id: 's1', title: 'Synthetic session', goal: 'Keep working', courseId: null, taskId: null,
      status: 'waiting', createdAt: NOW, updatedAt: NOW,
      workspace: { groupId: null, groupTitle: '', sessionKey: null, ownedTabIds: [], adoptedTabIds: [], releasedTabIds: [] },
      plan: { steps: [], currentStepId: null }, blockers: [], context: { sources: [] }, artifacts: [],
      agent: { providerId: 'openai', model: 'gpt-6-luna' }, conversation: [], activity: [], workflowIds: [],
      modelTurnGeneration: 2, pendingModelRequest: null,
    });

    const state = await buildPanelState();

    expect(state.activeSession?.pendingModelRequest).toBeNull();
    expect(state.streaming).toBeNull();
  });

  it('does not expose a preview for an older request generation', async () => {
    const db = await openDatabase();
    await sessionRepository(db).put({
      id: 's1', title: 'Synthetic session', goal: 'Keep working', courseId: null, taskId: null,
      status: 'working', createdAt: NOW, updatedAt: NOW,
      workspace: { groupId: null, groupTitle: '', sessionKey: null, ownedTabIds: [], adoptedTabIds: [], releasedTabIds: [] },
      plan: { steps: [], currentStepId: null }, blockers: [], context: { sources: [] }, artifacts: [],
      agent: { providerId: 'openai', model: 'gpt-6-luna' }, conversation: [], activity: [], workflowIds: [],
      modelTurnGeneration: 2,
      pendingModelRequest: { key: 'request-1', providerId: 'openai', startedAt: NOW, generation: 1 },
    });

    const state = await buildPanelState();

    expect(state.streaming).toBeNull();
  });

  it('does not expose a preview whose request key belongs to an older turn', async () => {
    const db = await openDatabase();
    await sessionRepository(db).put({
      id: 's1', title: 'Synthetic session', goal: 'Keep working', courseId: null, taskId: null,
      status: 'working', createdAt: NOW, updatedAt: NOW,
      workspace: { groupId: null, groupTitle: '', sessionKey: null, ownedTabIds: [], adoptedTabIds: [], releasedTabIds: [] },
      plan: { steps: [], currentStepId: null }, blockers: [], context: { sources: [] }, artifacts: [],
      agent: { providerId: 'openai', model: 'gpt-6-luna' }, conversation: [], activity: [], workflowIds: [],
      modelTurnGeneration: 2,
      pendingModelRequest: { key: 'request-2', providerId: 'openai', startedAt: NOW, generation: 2 },
    });

    const state = await buildPanelState();

    expect(state.streaming).toBeNull();
  });

  it('checks configured cloud readiness without fetching its model catalogue', async () => {
    const session: Record<string, unknown> = {
      'motion.secret.openai': 'sk-test-CANARY1234567890',
    };
    const fetchImpl = vi.fn();
    vi.stubGlobal('fetch', fetchImpl);
    vi.stubGlobal('chrome', {
      storage: {
        session: {
          get: vi.fn(async (key: string | string[]) => typeof key === 'string'
            ? { [key]: session[key] }
            : Object.fromEntries(key.map((item) => [item, session[item]]))),
        },
        local: {
          get: vi.fn(async (key: string) => key === 'motion.preferences'
            ? {
                [key]: {
                  providerId: 'openai',
                  model: 'account-specific-model',
                  cloudDisclosureAccepted: ['openai'],
                  autoOpenRelatedTabs: false,
                  allowedConfigurableActions: [],
                },
              }
            : {}),
        },
      },
      tabs: { query: vi.fn(async () => []) },
      permissions: { contains: vi.fn(async () => true) },
      runtime: { id: 'test-extension' },
    });

    const state = await buildPanelState();
    expect(state.ai).toMatchObject({ providerId: 'openai', status: 'available' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not report a scan as running once its lease has expired', async () => {
    const origin = 'https://mylearningspace.wlu.ca';
    const values: Record<string, unknown> = {
      'observation:4': { url: `${origin}/d2l/home/363`, pageType: 'course-home', title: 'Synthetic course', restrictionReason: null, warnings: [], observedAt: NOW },
    };
    let discovery: Record<string, unknown> = { optedIn: true, busy: true, busyRunId: 'dead-worker', busyUntil: '2020-01-01T00:00:00.000Z' };
    Object.assign(chrome.storage.session, {
      get: vi.fn(async (key: string | string[]) => typeof key === 'string' ? { [key]: values[key] } : Object.fromEntries(key.map((item) => [item, values[item]]))),
    });
    Object.assign(chrome.storage.local, { get: vi.fn(async (key: string) => key === `motion.discovery:${origin}` ? { [key]: discovery } : {}) });
    Object.assign(chrome.tabs, { query: vi.fn(async () => [{ id: 4 }]) });

    expect((await buildPanelState()).discovery).toMatchObject({ host: origin, busy: false });

    discovery = { ...discovery, busyUntil: new Date(Date.now() + 60_000).toISOString() };
    expect((await buildPanelState()).discovery.busy).toBe(true);
    expect(discoveryBusy({ busy: true }, new Date())).toBe(false);
  });

  it('runs workflow recovery at most once per interval across rapid refreshes', async () => {
    const values: Record<string, unknown> = {};
    Object.assign(chrome.storage.session, {
      get: vi.fn(async (key: string | string[]) => typeof key === 'string' ? { [key]: values[key] } : Object.fromEntries(key.map((item) => [item, values[item]]))),
      set: vi.fn(async (next: Record<string, unknown>) => { Object.assign(values, next); }),
    });
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(NOW));
    try {
      await buildPanelState();
      await buildPanelState();
      await buildPanelState();
      expect(recoverWorkflows).toHaveBeenCalledTimes(1);

      now.mockReturnValue(Date.parse(NOW) + PANEL_RECOVERY_INTERVAL_MS);
      await buildPanelState();
      expect(recoverWorkflows).toHaveBeenCalledTimes(2);
    } finally {
      now.mockRestore();
    }
  });

  it('closes the database connection it opens for each refresh', async () => {
    const probe = await openDatabase();
    const prototype = Object.getPrototypeOf(probe) as IDBDatabase;
    probe.close();
    const close = vi.spyOn(prototype, 'close');
    try {
      await buildPanelState();
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      close.mockRestore();
    }
  });
});
