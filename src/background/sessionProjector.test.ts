import { beforeEach, describe, expect, it } from 'vitest';
import { agentSessionSchema } from '@/core/session';
import { deleteDatabase, openDatabase } from '@/core/storage/db';
import { sessionRepository } from '@/core/storage/repositories';
import { workflowSchema, type Workflow } from '@/core/workflows';
import { projectWorkflow } from './sessionProjector';

const NOW = '2026-09-16T12:00:00.000Z';

function workflow(status: Workflow['status']): Workflow {
  return workflowSchema.parse({
    id: 'workflow-1',
    definitionId: 'agent-turn',
    definitionVersion: 1,
    title: 'Synthetic one-step workflow',
    courseId: null,
    params: { sessionId: 'session-1', turnSeq: 1 },
    steps: [{
      id: 't1-0',
      title: 'Read the synthetic page',
      action: 'read-page',
      risk: 'low',
      input: { url: 'https://lms.example.test/page' },
      status: status === 'completed' ? 'done' : 'running',
      attempt: 1,
      result: status === 'completed' ? 'Read the page.' : null,
      finishedAt: status === 'completed' ? NOW : null,
    }],
    status,
    currentStepId: status === 'completed' ? null : 't1-0',
    createdAt: NOW,
    updatedAt: NOW,
  });
}

beforeEach(async () => {
  await deleteDatabase('motion');
});

describe('sessionProjector', () => {
  it('projects a completed one-step workflow as done instead of working', async () => {
    const db = await openDatabase();
    await sessionRepository(db).put(agentSessionSchema.parse({
      id: 'session-1',
      title: 'Synthetic session',
      goal: 'Read a page',
      status: 'working',
      createdAt: NOW,
      updatedAt: NOW,
      plan: { steps: [{ id: 't1-0', title: 'Read the synthetic page', status: 'active' }], currentStepId: 't1-0' },
    }));
    db.close();

    await projectWorkflow(workflow('completed'));
    await projectWorkflow(workflow('completed'));

    const readDb = await openDatabase();
    const stored = await sessionRepository(readDb).get('session-1');
    expect(stored?.status).toBe('completed');
    expect(stored?.plan).toEqual({
      steps: [{ id: 't1-0', title: 'Read the synthetic page', status: 'done' }],
      currentStepId: null,
    });
    expect(stored?.activity).toHaveLength(1);
    expect(stored?.activity[0]?.summary).toContain('Completed');
    expect(stored?.blockers).toHaveLength(0);
    readDb.close();
  });
});
