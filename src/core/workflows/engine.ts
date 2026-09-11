import type { z } from 'zod';
import {
  isApprovalUsable,
  isProhibited,
  requiresApproval,
  riskOf,
  type ActionType,
  type ApprovalRequest,
} from '../policy';
import type { WorkflowStore } from '../storage/workflowStore';
import {
  canTransition,
  isTerminal,
  LEASE_TTL_MS,
  MAX_ATTEMPTS,
  retryDelayMs,
  workflowSchema,
  type Workflow,
  type WorkflowDefinition,
  type WorkflowStatus,
  type WorkflowStep,
} from './types';

export interface ApprovalStore {
  save(approval: ApprovalRequest): Promise<void>;
  get(id: string): Promise<ApprovalRequest | null>;
}

/** What a capability reports back. */
export type StepOutcome =
  | { kind: 'done'; result: string; sourcesVisited?: string[]; evidence?: Record<string, unknown> }
  | { kind: 'skipped'; reason: string }
  /** A recoverable obstacle: a login wall, a missing permission, a closed tab. */
  | { kind: 'blocked'; reason: string };

export interface StepContext {
  workflow: Workflow;
  step: WorkflowStep;
  /** Deterministic per (workflow, step, attempt); a retry produces a new one. */
  intentKey: string;
  now: Date;
  /**
   * Whether this execution still holds the workflow. Pausing or cancelling
   * clears the lease, and a newer claim bumps its generation; a capability with
   * several effects checks this between them, so a student's "stop" stops the
   * next tab from opening rather than only the commit that follows.
   */
  stillCurrent: () => Promise<boolean>;
}

/**
 * A concrete, parameter-validated thing Motion can do.
 *
 * Capabilities are a closed set. Workflows cannot invoke generic scripting, a
 * DOM click, or an arbitrary navigation, because blocking prohibited action
 * *names* is worthless if a generic capability can reach the same effect
 * (docs/THREAT_MODEL.md T5).
 */
export interface StepCapability {
  action: ActionType;
  execute(context: StepContext): Promise<StepOutcome>;
  /**
   * Required for capabilities with effects outside IndexedDB. Called after a
   * restart when an intent was left `prepared`: it inspects real browser state
   * for the intent's marker and reports what actually happened, so the effect
   * is neither duplicated nor lost. Returning null means "it never happened;
   * safe to run again".
   */
  reconcile?(context: StepContext): Promise<StepOutcome | null>;
}

export interface EngineOptions {
  store: WorkflowStore;
  approvals: ApprovalStore;
  capabilities: StepCapability[];
  definitions: WorkflowDefinition[];
  now?: () => Date;
  newId?: () => string;
  /** Identifies this worker instance for lease ownership. */
  ownerId?: string;
  /** Schedules a retry. Backed by chrome.alarms, never setTimeout. */
  scheduleRetry?: (workflowId: string, at: Date) => void;
  onChange?: (workflow: Workflow) => void;
}

export class WorkflowEngine {
  private readonly store: WorkflowStore;
  private readonly approvals: ApprovalStore;
  private readonly capabilities: Map<ActionType, StepCapability>;
  private readonly definitions: Map<string, WorkflowDefinition>;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly ownerId: string;
  private readonly scheduleRetry: (workflowId: string, at: Date) => void;
  private readonly onChange: (workflow: Workflow) => void;

  constructor(options: EngineOptions) {
    this.store = options.store;
    this.approvals = options.approvals;
    this.capabilities = new Map(options.capabilities.map((c) => [c.action, c]));
    this.definitions = new Map(options.definitions.map((d) => [d.id, d]));
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.ownerId = options.ownerId ?? `worker-${Math.random().toString(36).slice(2, 10)}`;
    this.scheduleRetry = options.scheduleRetry ?? (() => {});
    this.onChange = options.onChange ?? (() => {});
  }

  async create(
    definitionId: string,
    params: Record<string, unknown> = {},
    meta: { courseId?: string | null; title?: string } = {},
  ): Promise<Workflow> {
    const definition = this.definitions.get(definitionId);
    if (!definition) throw new Error(`Unknown workflow definition: ${definitionId}`);

    const plan = definition.plan(params);
    if (plan.length === 0) throw new Error(`Definition ${definitionId} planned no steps`);

    const seen = new Set<string>();
    for (const step of plan) {
      if (seen.has(step.id)) throw new Error(`Duplicate step id "${step.id}" in ${definitionId}`);
      seen.add(step.id);
      if (!this.capabilities.has(step.action)) {
        // Fail at planning time rather than halfway through execution.
        throw new Error(`No capability registered for action "${step.action}"`);
      }
    }

    const timestamp = this.now().toISOString();
    const workflow = workflowSchema.parse({
      id: this.newId(),
      definitionId: definition.id,
      definitionVersion: definition.version,
      title: meta.title ?? definition.title,
      courseId: meta.courseId ?? null,
      params,
      steps: plan.map((step) => ({
        id: step.id,
        title: step.title,
        action: step.action,
        risk: riskOf(step.action),
        input: step.input ?? {},
      })),
      status: 'queued',
      currentStepId: plan[0]!.id,
      createdAt: timestamp,
      updatedAt: timestamp,
      // Checked against the schema's *input* type: step defaults (status,
      // attempt, result, ...) are applied by the parse, so they are absent here
      // by design and the output type would wrongly demand them.
    } satisfies z.input<typeof workflowSchema>);

    await this.store.create(workflow);
    this.onChange(workflow);
    return workflow;
  }

  /**
   * Run steps until the workflow finishes or needs something it cannot supply
   * itself. Safe to call from any trigger and safe to call concurrently: the
   * lease decides who actually runs.
   */
  async advance(workflowId: string): Promise<Workflow | null> {
    let guard = 0;
    while (guard++ < 100) {
      const claimed = await this.claim(workflowId);
      if (!claimed) return this.store.get(workflowId);

      const workflow = claimed;
      const step = this.currentStep(workflow);
      if (!step) {
        await this.finish(workflowId, 'completed');
        return this.store.get(workflowId);
      }

      const halted = await this.runStep(workflow, step);
      await this.release(workflowId);
      if (halted) break;
    }
    return this.store.get(workflowId);
  }

  /**
   * Atomically take the lease. Returns null when another execution holds it,
   * when the workflow is terminal, or when it is waiting on a person.
   */
  private async claim(workflowId: string): Promise<Workflow | null> {
    const now = this.now();
    return this.store.update(workflowId, (current) => {
      if (isTerminal(current.status)) return null;
      if (current.status === 'paused') return null;
      if (current.status === 'awaiting-approval' || current.status === 'awaiting-permission') {
        return null;
      }
      if (current.status === 'retry-scheduled') {
        if (current.retryAt && new Date(current.retryAt).getTime() > now.getTime()) return null;
      }
      // An expired lease is reclaimable: its holder was killed mid-step.
      if (current.lease && new Date(current.lease.expiresAt).getTime() > now.getTime()) {
        return null;
      }

      const generation = (current.lease?.generation ?? 0) + 1;
      return {
        ...current,
        status: current.status === 'queued' ? 'running' : current.status,
        lease: {
          owner: this.ownerId,
          generation,
          expiresAt: new Date(now.getTime() + LEASE_TTL_MS).toISOString(),
        },
        retryAt: null,
        updatedAt: now.toISOString(),
      };
    });
  }

  private async release(workflowId: string): Promise<void> {
    await this.store.update(workflowId, (current) =>
      current.lease?.owner === this.ownerId
        ? { ...current, lease: null, updatedAt: this.now().toISOString() }
        : null,
    );
  }

  private currentStep(workflow: Workflow): WorkflowStep | null {
    if (!workflow.currentStepId) return null;
    return workflow.steps.find((step) => step.id === workflow.currentStepId) ?? null;
  }

  /** @returns true when the workflow should stop for now. */
  private async runStep(workflow: Workflow, step: WorkflowStep): Promise<boolean> {
    // The integrity boundary, checked before anything else can influence it.
    if (isProhibited(step.action)) {
      await this.failStep(workflow.id, step.id, `Motion does not perform "${step.action}".`);
      return true;
    }

    const capability = this.capabilities.get(step.action);
    if (!capability) {
      await this.failStep(workflow.id, step.id, `No capability for "${step.action}".`);
      return true;
    }

    if (requiresApproval(step.action)) {
      const gate = await this.checkApproval(workflow, step);
      if (gate === 'halt') return true;
      if (gate === 'denied') return false; // moved on; keep going
    }

    const generation = workflow.lease?.generation ?? 0;
    const attempt = step.attempt + 1;
    const intentKey = `${workflow.id}:${step.id}:${attempt}`;
    const needsIntent = typeof capability.reconcile === 'function';

    // Write the intent BEFORE the effect, so a crash leaves evidence to
    // reconcile against rather than an untracked side effect.
    const started = await this.store.update(workflow.id, (current) => {
      if (current.lease?.generation !== generation) return null;
      return this.patchStep(current, step.id, (s) => ({
        ...s,
        status: 'running',
        attempt,
        startedAt: s.startedAt ?? this.now().toISOString(),
        error: null,
        intent: needsIntent
          ? { key: intentKey, state: 'prepared', evidence: {}, updatedAt: this.now().toISOString() }
          : null,
      }));
    });
    if (!started) return true; // lost the lease

    const context: StepContext = {
      workflow: started,
      step: this.currentStep(started) ?? step,
      intentKey,
      now: this.now(),
      stillCurrent: async () =>
        (await this.store.get(workflow.id))?.lease?.generation === generation,
    };

    let outcome: StepOutcome;
    try {
      // If a previous attempt left an intent prepared, find out what really
      // happened before doing it again.
      const priorIntent = step.intent;
      const reconciled =
        priorIntent?.state === 'prepared' && capability.reconcile
          ? await capability.reconcile({ ...context, intentKey: priorIntent.key })
          : null;
      outcome = reconciled ?? (await capability.execute(context));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.handleFailure(workflow.id, step.id, attempt, generation, message);
    }

    return this.commitOutcome(workflow.id, step.id, generation, intentKey, outcome);
  }

  /** Result, intent state and the advance to the next step commit together. */
  private async commitOutcome(
    workflowId: string,
    stepId: string,
    generation: number,
    intentKey: string,
    outcome: StepOutcome,
  ): Promise<boolean> {
    const now = this.now().toISOString();
    let halted = true;

    const updated = await this.store.update(workflowId, (current) => {
      // A completion is only accepted from the generation that claimed the
      // step; a zombie execution resuming after a restart is ignored.
      if (current.lease?.generation !== generation) return null;

      if (outcome.kind === 'blocked') {
        halted = true;
        const next = this.patchStep(current, stepId, (s) => ({
          ...s,
          status: 'blocked',
          error: outcome.reason,
          finishedAt: now,
        }));
        return {
          ...next,
          status: this.transition(current.status, 'blocked'),
          warnings: [...new Set([...current.warnings, outcome.reason])],
          updatedAt: now,
        };
      }

      const next = this.patchStep(current, stepId, (s) => ({
        ...s,
        status: outcome.kind === 'done' ? 'done' : 'skipped',
        result: outcome.kind === 'done' ? outcome.result : outcome.reason,
        error: null,
        sourcesVisited: outcome.kind === 'done' ? (outcome.sourcesVisited ?? []) : [],
        finishedAt: now,
        intent: s.intent
          ? {
              ...s.intent,
              key: intentKey,
              state: 'applied' as const,
              evidence: outcome.kind === 'done' ? (outcome.evidence ?? {}) : {},
              updatedAt: now,
            }
          : null,
      }));

      const following = this.nextStepId(next, stepId);
      halted = following === null;
      return {
        ...next,
        currentStepId: following,
        status: following === null ? 'completed' : this.transition(current.status, 'running'),
        updatedAt: now,
      };
    });

    if (updated) this.onChange(updated);
    return halted;
  }

  private async handleFailure(
    workflowId: string,
    stepId: string,
    attempt: number,
    generation: number,
    message: string,
  ): Promise<boolean> {
    const now = this.now();
    const exhausted = attempt >= MAX_ATTEMPTS;
    const retryAt = new Date(now.getTime() + retryDelayMs(attempt));

    const updated = await this.store.update(workflowId, (current) => {
      if (current.lease?.generation !== generation) return null;
      const next = this.patchStep(current, stepId, (s) => ({
        ...s,
        status: exhausted ? 'failed' : 'pending',
        error: message,
        finishedAt: exhausted ? now.toISOString() : null,
      }));
      return {
        ...next,
        status: exhausted
          ? this.transition(current.status, 'failed')
          : this.transition(current.status, 'retry-scheduled'),
        retryAt: exhausted ? null : retryAt.toISOString(),
        updatedAt: now.toISOString(),
      };
    });

    if (updated) this.onChange(updated);
    if (!exhausted) this.scheduleRetry(workflowId, retryAt);
    return true;
  }

  private async failStep(workflowId: string, stepId: string, message: string): Promise<void> {
    const now = this.now().toISOString();
    const updated = await this.store.update(workflowId, (current) => {
      const next = this.patchStep(current, stepId, (s) => ({
        ...s,
        status: 'failed',
        error: message,
        finishedAt: now,
      }));
      return { ...next, status: this.transition(current.status, 'failed'), updatedAt: now };
    });
    if (updated) this.onChange(updated);
  }

  private async checkApproval(
    workflow: Workflow,
    step: WorkflowStep,
  ): Promise<'proceed' | 'halt' | 'denied'> {
    const now = this.now();

    if (step.approvalId) {
      const existing = await this.approvals.get(step.approvalId);
      if (existing) {
        const usable = isApprovalUsable(existing, now);
        if (usable.usable) return 'proceed';
        if (existing.status === 'denied') {
          await this.skipStep(workflow.id, step.id, 'Declined.');
          return 'denied';
        }
        if (existing.status === 'pending') {
          await this.park(workflow.id, step.id, 'awaiting-approval');
          return 'halt';
        }
        // Expired: mark it and ask again rather than acting on a stale answer.
        await this.approvals.save({ ...existing, status: 'expired' });
      }
    }

    const approval: ApprovalRequest = {
      id: this.newId(),
      workflowId: workflow.id,
      stepId: step.id,
      action: step.action,
      risk: riskOf(step.action),
      summary: step.title,
      target: String(step.input['target'] ?? workflow.title),
      effect: String(step.input['effect'] ?? 'Motion will carry out this step.'),
      reversible: step.input['reversible'] !== false,
      payload: step.input,
      status: 'pending',
      requestedAt: now.toISOString(),
      decidedAt: null,
      expiresAt: null,
    };
    await this.approvals.save(approval);

    await this.store.update(workflow.id, (current) => {
      const next = this.patchStep(current, step.id, (s) => ({
        ...s,
        status: 'awaiting-approval',
        approvalId: approval.id,
      }));
      return {
        ...next,
        status: this.transition(current.status, 'awaiting-approval'),
        updatedAt: now.toISOString(),
      };
    });
    return 'halt';
  }

  /** Called from the UI once a student decides. */
  async decideApproval(approvalId: string, approved: boolean): Promise<Workflow | null> {
    const approval = await this.approvals.get(approvalId);
    if (!approval || approval.status !== 'pending') return null;

    const now = this.now();
    // The expiry window starts at the moment of confirmation, so it bounds the
    // gap between the student agreeing and Motion acting.
    await this.approvals.save({
      ...approval,
      status: approved ? 'approved' : 'denied',
      decidedAt: now.toISOString(),
      expiresAt:
        approved && approval.risk === 'high'
          ? new Date(now.getTime() + 2 * 60 * 1000).toISOString()
          : null,
    });

    await this.store.update(approval.workflowId, (current) => ({
      ...current,
      status: current.status === 'awaiting-approval' ? 'running' : current.status,
      updatedAt: now.toISOString(),
    }));

    return this.advance(approval.workflowId);
  }

  private async park(workflowId: string, stepId: string, status: WorkflowStatus): Promise<void> {
    const now = this.now().toISOString();
    await this.store.update(workflowId, (current) => {
      const next = this.patchStep(current, stepId, (s) => ({
        ...s,
        status: status === 'awaiting-approval' ? 'awaiting-approval' : 'awaiting-permission',
      }));
      return { ...next, status: this.transition(current.status, status), updatedAt: now };
    });
  }

  private async skipStep(workflowId: string, stepId: string, reason: string): Promise<void> {
    const now = this.now().toISOString();
    const updated = await this.store.update(workflowId, (current) => {
      const next = this.patchStep(current, stepId, (s) => ({
        ...s,
        status: 'skipped',
        result: reason,
        finishedAt: now,
      }));
      const following = this.nextStepId(next, stepId);
      return {
        ...next,
        currentStepId: following,
        status: following === null ? 'completed' : current.status,
        updatedAt: now,
      };
    });
    if (updated) this.onChange(updated);
  }

  async pause(workflowId: string): Promise<Workflow | null> {
    const now = this.now().toISOString();
    return this.store.update(workflowId, (current) =>
      isTerminal(current.status)
        ? null
        : { ...current, status: 'paused', lease: null, retryAt: null, updatedAt: now },
    );
  }

  async resume(workflowId: string): Promise<Workflow | null> {
    const now = this.now().toISOString();
    await this.store.update(workflowId, (current) => {
      if (current.status !== 'paused' && current.status !== 'blocked' && current.status !== 'failed')
        return null;
      const stepId = current.currentStepId;
      const next = stepId
        ? this.patchStep(current, stepId, (s) =>
            s.status === 'blocked' || s.status === 'failed'
              ? { ...s, status: 'pending', error: null }
              : s,
          )
        : current;
      return { ...next, status: 'running', lease: null, updatedAt: now };
    });
    return this.advance(workflowId);
  }

  /** Retry the current step from a clean attempt count. */
  async retry(workflowId: string): Promise<Workflow | null> {
    const now = this.now().toISOString();
    await this.store.update(workflowId, (current) => {
      const stepId = current.currentStepId;
      if (!stepId) return null;
      const next = this.patchStep(current, stepId, (s) => ({
        ...s,
        status: 'pending',
        attempt: 0,
        error: null,
      }));
      return {
        ...next,
        status: 'running',
        lease: null,
        retryAt: null,
        warnings: [],
        updatedAt: now,
      };
    });
    return this.advance(workflowId);
  }

  async cancel(workflowId: string): Promise<Workflow | null> {
    const now = this.now().toISOString();
    return this.store.update(workflowId, (current) =>
      isTerminal(current.status)
        ? null
        : { ...current, status: 'cancelled', lease: null, retryAt: null, updatedAt: now },
    );
  }

  private async finish(workflowId: string, status: WorkflowStatus): Promise<void> {
    const now = this.now().toISOString();
    const updated = await this.store.update(workflowId, (current) => ({
      ...current,
      status,
      lease: null,
      currentStepId: null,
      updatedAt: now,
    }));
    if (updated) this.onChange(updated);
  }

  /**
   * Re-enter workflows that were mid-flight when the worker or browser stopped.
   * Anything genuinely waiting on a person is left alone.
   */
  async recoverInterrupted(): Promise<Workflow[]> {
    const all = await this.store.list();
    const now = this.now();
    const resumed: Workflow[] = [];

    for (const workflow of all) {
      if (isTerminal(workflow.status)) continue;
      if (workflow.status === 'paused') continue;
      if (workflow.status === 'awaiting-approval' || workflow.status === 'awaiting-permission') {
        continue;
      }
      if (
        workflow.status === 'retry-scheduled' &&
        workflow.retryAt &&
        new Date(workflow.retryAt).getTime() > now.getTime()
      ) {
        // Not due yet; make sure an alarm exists to bring it back.
        this.scheduleRetry(workflow.id, new Date(workflow.retryAt));
        continue;
      }

      // Clear a dead lease so the workflow is claimable again.
      await this.store.update(workflow.id, (current) => {
        if (!current.lease) return null;
        if (new Date(current.lease.expiresAt).getTime() > now.getTime()) return null;
        return { ...current, lease: null, updatedAt: now.toISOString() };
      });

      const advanced = await this.advance(workflow.id);
      if (advanced) resumed.push(advanced);
    }
    return resumed;
  }

  private patchStep(
    workflow: Workflow,
    stepId: string,
    patch: (step: WorkflowStep) => WorkflowStep,
  ): Workflow {
    return {
      ...workflow,
      steps: workflow.steps.map((step) => (step.id === stepId ? patch(step) : step)),
    };
  }

  private nextStepId(workflow: Workflow, afterStepId: string): string | null {
    const index = workflow.steps.findIndex((step) => step.id === afterStepId);
    if (index < 0) return null;
    const next = workflow.steps[index + 1];
    return next ? next.id : null;
  }

  /** Reject an illegal move loudly rather than drifting into a bad state. */
  private transition(from: WorkflowStatus, to: WorkflowStatus): WorkflowStatus {
    if (from === to) return to;
    if (!canTransition(from, to)) {
      throw new Error(`Illegal workflow transition: ${from} -> ${to}`);
    }
    return to;
  }
}
