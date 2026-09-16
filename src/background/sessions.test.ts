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

import { handleSessionMessage } from './sessions';

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
});
