import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkflowEngine, type ApprovalStore, type StepCapability } from './engine';
import { InMemoryWorkflowStore } from '../storage/workflowStore';
import { canTransition, LEASE_TTL_MS, type WorkflowDefinition } from './types';
import type { ApprovalRequest } from '../policy';

class MemoryApprovals implements ApprovalStore {
  readonly rows = new Map<string, ApprovalRequest>();
  async save(approval: ApprovalRequest) {
    this.rows.set(approval.id, approval);
  }
  async get(id: string) {
    return this.rows.get(id) ?? null;
  }
}

const START = new Date('2026-03-02T12:00:00.000Z');

function clock(start = START) {
  let current = start.getTime();
  return {
    now: () => new Date(current),
    advance: (ms: number) => {
      current += ms;
    },
  };
}

let idCounter = 0;
const newId = () => `id-${++idCounter}`;

const readOnlyDefinition: WorkflowDefinition = {
  id: 'scan-course',
  version: 1,
  title: 'Scan this course for deadlines',
  description: 'Reads the course pages you can already see and collects due dates.',
  plan: () => [
    { id: 'read', title: 'Read the assignment list', action: 'read-page' },
    { id: 'extract', title: 'Extract deadlines', action: 'extract-deadlines' },
  ],
};

function capability(action: StepCapability['action'], impl?: Partial<StepCapability>) {
  return {
    action,
    execute: async () => ({ kind: 'done' as const, result: `did ${action}` }),
    ...impl,
  } satisfies StepCapability;
}

function makeEngine(overrides: Partial<ConstructorParameters<typeof WorkflowEngine>[0]> = {}) {
  const time = clock();
  const store = new InMemoryWorkflowStore();
  const approvals = new MemoryApprovals();
  const engine = new WorkflowEngine({
    store,
    approvals,
    capabilities: [capability('read-page'), capability('extract-deadlines')],
    definitions: [readOnlyDefinition],
    now: time.now,
    newId,
    ownerId: 'worker-a',
    ...overrides,
  });
  return { engine, store, approvals, time };
}

beforeEach(() => {
  idCounter = 0;
});

describe('planning', () => {
  it('runs a read-only workflow to completion', async () => {
    const { engine } = makeEngine();
    const created = await engine.create('scan-course');
    const done = await engine.advance(created.id);

    expect(done?.status).toBe('completed');
    expect(done?.steps.map((s) => s.status)).toEqual(['done', 'done']);
    expect(done?.currentStepId).toBeNull();
    expect(done?.lease).toBeNull();
  });

  it('refuses to plan a step whose action has no capability', async () => {
    const { engine } = makeEngine({
      capabilities: [capability('read-page')], // extract-deadlines missing
    });
    await expect(engine.create('scan-course')).rejects.toThrow(/No capability/i);
  });

  it('rejects a definition with duplicate step ids', async () => {
    const broken: WorkflowDefinition = {
      id: 'broken',
      version: 1,
      title: 'Broken',
      description: '',
      plan: () => [
        { id: 'a', title: 'One', action: 'read-page' },
        { id: 'a', title: 'Two', action: 'read-page' },
      ],
    };
    const { engine } = makeEngine({ definitions: [readOnlyDefinition, broken] });
    await expect(engine.create('broken')).rejects.toThrow(/Duplicate step id/i);
  });

  it('records the definition version on the workflow', async () => {
    const { engine } = makeEngine();
    const created = await engine.create('scan-course');
    expect(created.definitionVersion).toBe(1);
  });
});

describe('resumption identifies steps by stable id, not index', () => {
  it('resumes at the right step after an update reorders the plan', async () => {
    const time = clock();
    const store = new InMemoryWorkflowStore();
    const approvals = new MemoryApprovals();

    // v1 runs the first step, then stalls on a blocked second step.
    const v1: WorkflowDefinition = {
      id: 'plan',
      version: 1,
      title: 'Plan',
      description: '',
      plan: () => [
        { id: 'read', title: 'Read', action: 'read-page' },
        { id: 'extract', title: 'Extract', action: 'extract-deadlines' },
      ],
    };

    const engine1 = new WorkflowEngine({
      store,
      approvals,
      capabilities: [
        capability('read-page'),
        capability('extract-deadlines', {
          execute: async () => ({ kind: 'blocked', reason: 'Sign in to continue.' }),
        }),
      ],
      definitions: [v1],
      now: time.now,
      newId,
      ownerId: 'worker-a',
    });

    const created = await engine1.create('plan');
    await engine1.advance(created.id);
    const stalled = await store.get(created.id);
    expect(stalled?.currentStepId).toBe('extract');
    expect(stalled?.status).toBe('blocked');

    // A later version inserts a step at the front. If resumption used an index,
    // the workflow would resume into the wrong action.
    const engine2 = new WorkflowEngine({
      store,
      approvals,
      capabilities: [capability('read-page'), capability('extract-deadlines')],
      definitions: [
        {
          ...v1,
          version: 2,
          plan: () => [
            { id: 'preflight', title: 'Check access', action: 'read-page' },
            { id: 'read', title: 'Read', action: 'read-page' },
            { id: 'extract', title: 'Extract', action: 'extract-deadlines' },
          ],
        },
      ],
      now: time.now,
      newId,
      ownerId: 'worker-b',
    });

    const resumed = await engine2.resume(created.id);
    expect(resumed?.status).toBe('completed');
    // It finished 'extract' — the step it was actually on.
    expect(resumed?.steps.find((s) => s.id === 'extract')?.status).toBe('done');
  });
});

describe('concurrency', () => {
  it('lets only one execution claim a workflow at a time', async () => {
    const time = clock();
    const store = new InMemoryWorkflowStore();
    const approvals = new MemoryApprovals();
    let concurrent = 0;
    let maxConcurrent = 0;

    const slow = capability('read-page', {
      execute: async () => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 5));
        concurrent -= 1;
        return { kind: 'done', result: 'read' };
      },
    });

    const options = {
      store,
      approvals,
      capabilities: [slow, capability('extract-deadlines')],
      definitions: [readOnlyDefinition],
      now: time.now,
      newId,
    };
    const a = new WorkflowEngine({ ...options, ownerId: 'worker-a' });
    const b = new WorkflowEngine({ ...options, ownerId: 'worker-b' });

    const created = await a.create('scan-course');
    await Promise.all([a.advance(created.id), b.advance(created.id)]);

    expect(maxConcurrent).toBe(1);
    const final = await store.get(created.id);
    expect(final?.status).toBe('completed');
    // Each step ran once, not twice.
    expect(final?.steps.every((s) => s.attempt === 1)).toBe(true);
  });

  it('lets another worker reclaim a lease left behind by a killed worker', async () => {
    const { engine, store, time } = makeEngine();
    const created = await engine.create('scan-course');

    // Simulate a worker that claimed the workflow and was then killed.
    await store.update(created.id, (current) => ({
      ...current,
      status: 'running',
      lease: {
        owner: 'dead-worker',
        generation: 1,
        expiresAt: new Date(time.now().getTime() + LEASE_TTL_MS).toISOString(),
      },
    }));

    // Before expiry, nobody else may take it.
    const blocked = await engine.advance(created.id);
    expect(blocked?.steps[0]?.status).toBe('pending');

    time.advance(LEASE_TTL_MS + 1);
    const recovered = await engine.advance(created.id);
    expect(recovered?.status).toBe('completed');
  });
});

describe('durable intents for side effects', () => {
  it('reconciles a prepared intent instead of repeating the effect', async () => {
    const time = clock();
    const store = new InMemoryWorkflowStore();
    const approvals = new MemoryApprovals();
    const execute = vi.fn(async () => ({
      kind: 'done' as const,
      result: 'opened tab',
      evidence: { tabId: 42 },
    }));
    const reconcile = vi.fn(async () => ({
      kind: 'done' as const,
      result: 'found the tab already open',
      evidence: { tabId: 42 },
    }));

    const definition: WorkflowDefinition = {
      id: 'open',
      version: 1,
      title: 'Open sources',
      description: '',
      plan: () => [{ id: 'open-tab', title: 'Open the rubric', action: 'open-tab' }],
    };

    const engine = new WorkflowEngine({
      store,
      approvals,
      capabilities: [{ action: 'open-tab', execute, reconcile }],
      definitions: [definition],
      now: time.now,
      newId,
      ownerId: 'worker-a',
    });

    const created = await engine.create('open');

    // Simulate a crash after the intent was prepared but before it completed.
    await store.update(created.id, (current) => ({
      ...current,
      status: 'running',
      lease: null,
      steps: current.steps.map((s) => ({
        ...s,
        status: 'running',
        attempt: 1,
        intent: {
          key: `${created.id}:open-tab:1`,
          state: 'prepared',
          evidence: {},
          updatedAt: time.now().toISOString(),
        },
      })),
    }));

    const recovered = await engine.recoverInterrupted();

    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
    expect(recovered[0]?.status).toBe('completed');
    const step = recovered[0]?.steps[0];
    expect(step?.intent?.state).toBe('applied');
    expect(step?.intent?.evidence).toEqual({ tabId: 42 });
  });

  it('runs the effect when reconciliation finds no evidence of it', async () => {
    const time = clock();
    const store = new InMemoryWorkflowStore();
    const approvals = new MemoryApprovals();
    const execute = vi.fn(async () => ({ kind: 'done' as const, result: 'opened tab' }));
    const reconcile = vi.fn(async () => null); // it never happened

    const engine = new WorkflowEngine({
      store,
      approvals,
      capabilities: [{ action: 'open-tab', execute, reconcile }],
      definitions: [
        {
          id: 'open',
          version: 1,
          title: 'Open',
          description: '',
          plan: () => [{ id: 'open-tab', title: 'Open', action: 'open-tab' }],
        },
      ],
      now: time.now,
      newId,
      ownerId: 'worker-a',
    });

    const created = await engine.create('open');
    await store.update(created.id, (current) => ({
      ...current,
      status: 'running',
      steps: current.steps.map((s) => ({
        ...s,
        status: 'running',
        attempt: 1,
        intent: {
          key: 'k',
          state: 'prepared',
          evidence: {},
          updatedAt: time.now().toISOString(),
        },
      })),
    }));

    await engine.recoverInterrupted();
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

describe('approval gate', () => {
  const gated: WorkflowDefinition = {
    id: 'checklist',
    version: 1,
    title: 'Build a checklist',
    description: '',
    plan: () => [
      { id: 'read', title: 'Read the instructions', action: 'read-page' },
      {
        id: 'make',
        title: 'Create a checklist from the instructions',
        action: 'create-checklist',
        input: { target: 'CP363 Assignment 2', effect: 'Adds a checklist to your workspace.' },
      },
    ],
  };

  function gatedEngine() {
    const time = clock();
    const store = new InMemoryWorkflowStore();
    const approvals = new MemoryApprovals();
    const engine = new WorkflowEngine({
      store,
      approvals,
      capabilities: [capability('read-page'), capability('create-checklist')],
      definitions: [gated],
      now: time.now,
      newId,
      ownerId: 'worker-a',
    });
    return { engine, store, approvals, time };
  }

  it('stops and asks before a medium-risk step', async () => {
    const { engine, approvals } = gatedEngine();
    const created = await engine.create('checklist');
    const parked = await engine.advance(created.id);

    expect(parked?.status).toBe('awaiting-approval');
    expect(parked?.steps.find((s) => s.id === 'make')?.status).toBe('awaiting-approval');

    const pending = [...approvals.rows.values()];
    expect(pending).toHaveLength(1);
    expect(pending[0]?.target).toBe('CP363 Assignment 2');
    expect(pending[0]?.effect).toMatch(/checklist/i);
  });

  it('proceeds once approved', async () => {
    const { engine, approvals } = gatedEngine();
    const created = await engine.create('checklist');
    await engine.advance(created.id);

    const approvalId = [...approvals.rows.keys()][0]!;
    const done = await engine.decideApproval(approvalId, true);
    expect(done?.status).toBe('completed');
  });

  it('skips the step and carries on when declined', async () => {
    const { engine, approvals } = gatedEngine();
    const created = await engine.create('checklist');
    await engine.advance(created.id);

    const approvalId = [...approvals.rows.keys()][0]!;
    const result = await engine.decideApproval(approvalId, false);

    expect(result?.steps.find((s) => s.id === 'make')?.status).toBe('skipped');
    expect(result?.status).toBe('completed');
  });

  it('does not act on an approval that was never granted', async () => {
    const { engine, store } = gatedEngine();
    const created = await engine.create('checklist');
    await engine.advance(created.id);
    // Advancing again must not sneak past the pending gate.
    await engine.advance(created.id);
    const current = await store.get(created.id);
    expect(current?.status).toBe('awaiting-approval');
    expect(current?.steps.find((s) => s.id === 'make')?.status).toBe('awaiting-approval');
  });
});

describe('prohibited actions', () => {
  it('refuses a prohibited action even with a capability registered', async () => {
    const time = clock();
    const store = new InMemoryWorkflowStore();
    const approvals = new MemoryApprovals();
    const execute = vi.fn(async () => ({ kind: 'done' as const, result: 'submitted' }));

    const engine = new WorkflowEngine({
      store,
      approvals,
      capabilities: [{ action: 'submit-assignment', execute }],
      definitions: [
        {
          id: 'bad',
          version: 1,
          title: 'Submit',
          description: '',
          plan: () => [{ id: 'submit', title: 'Submit the assignment', action: 'submit-assignment' }],
        },
      ],
      now: time.now,
      newId,
      ownerId: 'worker-a',
    });

    const created = await engine.create('bad');
    const result = await engine.advance(created.id);

    expect(execute).not.toHaveBeenCalled();
    expect(result?.status).toBe('failed');
    expect(result?.steps[0]?.error).toMatch(/does not perform/i);
  });
});

describe('failure handling', () => {
  it('schedules a retry with backoff and gives up after the limit', async () => {
    const time = clock();
    const store = new InMemoryWorkflowStore();
    const approvals = new MemoryApprovals();
    const scheduleRetry = vi.fn();
    const execute = vi.fn(async () => {
      throw new Error('network hiccup');
    });

    const engine = new WorkflowEngine({
      store,
      approvals,
      capabilities: [{ action: 'read-page', execute }],
      definitions: [
        {
          id: 'flaky',
          version: 1,
          title: 'Flaky',
          description: '',
          plan: () => [{ id: 'read', title: 'Read', action: 'read-page' }],
        },
      ],
      now: time.now,
      newId,
      ownerId: 'worker-a',
      scheduleRetry,
    });

    const created = await engine.create('flaky');

    await engine.advance(created.id);
    expect(scheduleRetry).toHaveBeenCalledTimes(1);
    let current = await store.get(created.id);
    expect(current?.status).toBe('retry-scheduled');

    time.advance(60_000);
    await engine.advance(created.id);
    time.advance(60_000);
    const final = await engine.advance(created.id);

    expect(execute).toHaveBeenCalledTimes(3);
    expect(final?.status).toBe('failed');
    expect(final?.steps[0]?.error).toMatch(/network hiccup/);
  });

  it('pauses on a blocker and preserves progress', async () => {
    const time = clock();
    const store = new InMemoryWorkflowStore();
    const approvals = new MemoryApprovals();
    const engine = new WorkflowEngine({
      store,
      approvals,
      capabilities: [
        capability('read-page'),
        capability('extract-deadlines', {
          execute: async () => ({ kind: 'blocked', reason: 'Sign in to Brightspace to continue.' }),
        }),
      ],
      definitions: [readOnlyDefinition],
      now: time.now,
      newId,
      ownerId: 'worker-a',
    });

    const created = await engine.create('scan-course');
    const blocked = await engine.advance(created.id);

    expect(blocked?.status).toBe('blocked');
    expect(blocked?.warnings).toContain('Sign in to Brightspace to continue.');
    // The completed first step is not lost.
    expect(blocked?.steps.find((s) => s.id === 'read')?.status).toBe('done');
  });
});

describe('student controls', () => {
  it('pause stops the workflow and drops the lease', async () => {
    const { engine } = makeEngine();
    const created = await engine.create('scan-course');
    const paused = await engine.pause(created.id);
    expect(paused?.status).toBe('paused');
    expect(paused?.lease).toBeNull();

    // A paused workflow is not claimable.
    const after = await engine.advance(created.id);
    expect(after?.status).toBe('paused');
  });

  it('cancel is terminal and cannot be resumed', async () => {
    const { engine } = makeEngine();
    const created = await engine.create('scan-course');
    await engine.cancel(created.id);
    const resumed = await engine.resume(created.id);
    expect(resumed?.status).toBe('cancelled');
  });

  it('retry clears the attempt count and runs again', async () => {
    const time = clock();
    const store = new InMemoryWorkflowStore();
    const approvals = new MemoryApprovals();
    let calls = 0;
    const engine = new WorkflowEngine({
      store,
      approvals,
      capabilities: [
        {
          action: 'read-page',
          execute: async () => {
            calls += 1;
            if (calls <= 3) throw new Error('boom');
            return { kind: 'done', result: 'read at last' };
          },
        },
      ],
      definitions: [
        {
          id: 'flaky',
          version: 1,
          title: 'Flaky',
          description: '',
          plan: () => [{ id: 'read', title: 'Read', action: 'read-page' }],
        },
      ],
      now: time.now,
      newId,
      ownerId: 'worker-a',
    });

    const created = await engine.create('flaky');
    await engine.advance(created.id);
    time.advance(60_000);
    await engine.advance(created.id);
    time.advance(60_000);
    const failed = await engine.advance(created.id);
    expect(failed?.status).toBe('failed');

    const retried = await engine.retry(created.id);
    expect(retried?.status).toBe('completed');
    expect(retried?.steps[0]?.result).toBe('read at last');
  });
});

describe('recovery', () => {
  it('leaves workflows waiting on a person alone', async () => {
    const { engine, store } = makeEngine();
    const created = await engine.create('scan-course');
    await store.update(created.id, (c) => ({ ...c, status: 'awaiting-approval' }));

    const resumed = await engine.recoverInterrupted();
    expect(resumed).toHaveLength(0);
    expect((await store.get(created.id))?.status).toBe('awaiting-approval');
  });

  it('does not resurrect a cancelled workflow', async () => {
    const { engine, store } = makeEngine();
    const created = await engine.create('scan-course');
    await engine.cancel(created.id);
    await engine.recoverInterrupted();
    expect((await store.get(created.id))?.status).toBe('cancelled');
  });

  it('re-arms an alarm for a retry that is not yet due', async () => {
    const scheduleRetry = vi.fn();
    const { engine, store, time } = makeEngine({ scheduleRetry });
    const created = await engine.create('scan-course');
    await store.update(created.id, (c) => ({
      ...c,
      status: 'retry-scheduled',
      retryAt: new Date(time.now().getTime() + 30_000).toISOString(),
    }));

    await engine.recoverInterrupted();
    expect(scheduleRetry).toHaveBeenCalledWith(created.id, expect.any(Date));
  });
});

describe('transition table', () => {
  it('forbids leaving a terminal state', () => {
    expect(canTransition('completed', 'running')).toBe(false);
    expect(canTransition('cancelled', 'running')).toBe(false);
  });

  it('allows the paths the engine actually uses', () => {
    expect(canTransition('queued', 'running')).toBe(true);
    expect(canTransition('running', 'awaiting-approval')).toBe(true);
    expect(canTransition('awaiting-approval', 'running')).toBe(true);
    expect(canTransition('running', 'retry-scheduled')).toBe(true);
    expect(canTransition('paused', 'running')).toBe(true);
  });
});
