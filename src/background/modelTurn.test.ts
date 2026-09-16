import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteDatabase, openDatabase } from '@/core/storage/db';
import { sessionRepository } from '@/core/storage/repositories';
import type { AgentSession } from '@/core/session';
import { recoverStaleModelRequests, stopGeneration } from './modelTurn';

const NOW = '2026-09-16T12:00:00.000Z';

function session(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: 'session-1', title: 'CP363 · Synthetic Assignment 2', goal: 'Work on Assignment 2', courseId: null, taskId: null,
    status: 'working' as const, createdAt: NOW, updatedAt: NOW,
    workspace: { groupId: null, groupTitle: '', sessionKey: null, ownedTabIds: [], adoptedTabIds: [], releasedTabIds: [] },
    plan: { steps: [], currentStepId: null }, blockers: [], context: { sources: [] }, artifacts: [],
    agent: { providerId: 'openai', model: 'gpt-5' }, conversation: [], activity: [], workflowIds: [],
    pendingModelRequest: { key: 'request-1', providerId: 'openai', startedAt: '2026-09-16T11:57:59.000Z' },
    ...overrides,
  };
}

beforeEach(async () => {
  await deleteDatabase('motion');
  vi.stubGlobal('chrome', {
    storage: { session: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined), remove: vi.fn(async () => undefined) } },
    alarms: { create: vi.fn(async () => undefined) },
  });
});

describe('model request recovery', () => {
  it('turns a stale persisted request into a retry blocker without sending it again', async () => {
    const db = await openDatabase();
    const repo = sessionRepository(db);
    await repo.put(session());

    await recoverStaleModelRequests(Date.parse(NOW));

    const stored = await repo.get('session-1');
    expect(stored?.pendingModelRequest).toBeNull();
    expect(stored?.blockers).toEqual([
      expect.objectContaining({ kind: 'provider', message: 'Motion was interrupted while waiting for openai. Retry?' }),
    ]);
  });

  it('clears visible streaming state when stopped after a worker restart', async () => {
    await stopGeneration('session-1');
    expect(chrome.storage.session.remove).toHaveBeenCalledWith('motion.streaming');
  });
});
