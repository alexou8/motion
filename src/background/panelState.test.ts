import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteDatabase, openDatabase } from '@/core/storage/db';
import { sessionRepository } from '@/core/storage/repositories';
import { buildPanelState } from './panelState';

const NOW = '2026-09-16T12:00:00.000Z';

beforeEach(async () => {
  await deleteDatabase('motion');
  const session: Record<string, unknown> = {
    'motion.activeSessionId': 's1',
    'motion.streaming': { sessionId: 's1', text: 'Planning…' },
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
      context: { sources: [] }, artifacts: [], agent: { providerId: null, model: null }, conversation: [], activity: [], workflowIds: [], pendingModelRequest: null,
    });

    const state = await buildPanelState();
    expect(state.sessions).toEqual([expect.objectContaining({ id: 's1', needsYou: 1, currentStepTitle: 'Read instructions' })]);
    expect(state.activeSession?.id).toBe('s1');
    expect(state.streaming).toEqual({ sessionId: 's1', text: 'Planning…' });
  });
});
