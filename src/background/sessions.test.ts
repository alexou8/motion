import { beforeEach, describe, expect, it, vi } from 'vitest';
import { agentSessionSchema } from '@/core/session';
import { deleteDatabase, openDatabase } from '@/core/storage/db';
import { sessionRepository } from '@/core/storage/repositories';

const NOW = '2026-09-16T12:00:00.000Z';
const { runModelTurn } = vi.hoisted(() => ({ runModelTurn: vi.fn() }));

vi.mock('./modelTurn', () => ({
  recoverStaleModelRequests: vi.fn(),
  runFallbackPlan: vi.fn(),
  runModelTurn,
  stopGeneration: vi.fn(),
}));

import { handleSessionMessage, sessionCreateBehavior } from './sessions';

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
