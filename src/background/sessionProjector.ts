import { appendActivity, canTransitionSession, transitionSession, type AgentSession, type ActivityEntry, type SessionBlocker } from '@/core/session';
import { openDatabase } from '@/core/storage/db';
import { Repository } from '@/core/storage/repository';
import { updateSession } from '@/core/storage/repositories';
import { STORE } from '@/core/storage/schema';
import { approvalRequestSchema } from '@/core/policy';
import type { Workflow, WorkflowStep } from '@/core/workflows';
import { IndexedDbWorkflowStore } from '@/core/storage/workflowStore';

const PROJECTED_BLOCKER_PREFIX = 'workflow:';

function projectedStepStatus(step: WorkflowStep): AgentSession['plan']['steps'][number]['status'] {
  switch (step.status) {
    case 'running': return 'active';
    case 'awaiting-permission':
    case 'awaiting-approval':
    case 'blocked': return 'blocked';
    case 'done': return 'done';
    case 'skipped': return 'skipped';
    case 'failed': return 'failed';
    case 'pending': return 'pending';
  }
}

function sessionStatusFor(workflow: Workflow): AgentSession['status'] {
  switch (workflow.status) {
    case 'completed': return 'completed';
    case 'failed':
    case 'blocked':
    case 'awaiting-approval':
    case 'awaiting-permission':
    case 'retry-scheduled': return 'waiting';
    case 'paused': return 'paused';
    case 'cancelled': return 'active';
    case 'queued': return 'active';
    case 'running': return 'working';
  }
}

function sourceUrl(step: WorkflowStep): string | undefined {
  const url = step.input['url'];
  if (typeof url !== 'string') return undefined;
  try {
    new URL(url);
    return url;
  } catch {
    return undefined;
  }
}

function stepActivity(workflow: Workflow, step: WorkflowStep): Omit<ActivityEntry, 'at'> & { at?: string } | null {
  if (step.status === 'pending') return null;
  const id = `workflow:${workflow.id}:step:${step.id}:attempt:${step.attempt}:status:${step.status}`;
  if (step.status === 'running') {
    return { id, kind: 'tool', summary: `Started “${step.title}”.`, sourceUrl: sourceUrl(step) };
  }
  const result = step.result ?? step.error;
  const summary = step.status === 'done'
    ? `Completed “${step.title}”.${result ? ` ${result}` : ''}`
    : step.status === 'skipped'
      ? `Skipped “${step.title}”.${result ? ` ${result}` : ''}`
      : step.status === 'awaiting-approval'
        ? `Waiting for approval for “${step.title}”.`
        : step.status === 'awaiting-permission'
          ? `Waiting for permission for “${step.title}”.`
          : `${step.status === 'failed' ? 'Failed' : 'Blocked'} “${step.title}”.${result ? ` ${result}` : ''}`;
  return {
    id,
    kind: step.status === 'awaiting-approval' ? 'approval' : step.status === 'awaiting-permission' || step.status === 'blocked' || step.status === 'failed' ? 'blocker' : 'result',
    summary,
    sourceUrl: sourceUrl(step),
  };
}

function blockerForStep(
  workflow: Workflow,
  step: WorkflowStep,
  approvalEffect: string | undefined,
  approvalId: string | undefined,
): SessionBlocker | null {
  const id = `workflow:${workflow.id}:step:${step.id}`;
  if (step.status === 'awaiting-approval') {
    return {
      id,
      kind: 'approval',
      message: approvalEffect ?? `Motion needs your approval before it can continue “${step.title}”.`,
      ...(approvalId ? { approvalId } : {}),
    };
  }
  if (step.status === 'awaiting-permission') {
    return { id, kind: 'permission', message: `Motion needs permission to continue “${step.title}”.` };
  }
  if (step.status === 'blocked' || step.status === 'failed') {
    return {
      id,
      kind: 'error',
      message: step.status === 'failed'
        ? `Motion could not complete “${step.title}”: ${step.error ?? 'the step failed.'}`
        : `Motion is blocked on “${step.title}”: ${step.error ?? 'the step cannot continue yet.'}`,
    };
  }
  return null;
}

function workflowBlocker(workflow: Workflow): SessionBlocker | null {
  if (workflow.status !== 'failed' && workflow.status !== 'blocked') return null;
  if (workflow.steps.some((step) => step.status === 'failed' || step.status === 'blocked')) return null;
  return {
    id: `workflow:${workflow.id}:workflow`,
    kind: 'error',
    message: `Motion could not finish “${workflow.title}”: ${workflow.warnings[0] ?? 'the workflow is blocked.'}`,
  };
}

/**
 * Projects durable workflow state into its owning AgentSession. The update is
 * intentionally idempotent: engine callbacks can be repeated by recovery and
 * concurrent callbacks serialize through the session repository transaction.
 */
export async function projectWorkflow(workflow: Workflow): Promise<AgentSession | null> {
  const sessionId = workflow.params['sessionId'];
  if (typeof sessionId !== 'string' || sessionId.length === 0) return null;

  const db = await openDatabase();
  try {
    // An async callback can arrive after a newer workflow callback. Read the
    // durable workflow first so an out-of-order callback cannot roll a session
    // projection backwards.
    const latestWorkflow = await new IndexedDbWorkflowStore(db).get(workflow.id) ?? workflow;
    const approvals = new Repository(db, STORE.approvals, approvalRequestSchema);
    const approvalEffects = new Map<string, { effect: string; id: string }>();
    for (const step of latestWorkflow.steps) {
      if (step.status !== 'awaiting-approval' || !step.approvalId) continue;
      const approval = await approvals.get(step.approvalId);
      if (approval) approvalEffects.set(step.id, { effect: approval.effect, id: approval.id });
    }

    return await updateSession(db, sessionId, (current) => {
      const previousById = new Map(current.plan.steps.map((step) => [step.id, step]));
      const plan = {
        steps: latestWorkflow.steps.map((step) => {
          const previous = previousById.get(step.id);
          return {
            id: step.id,
            title: step.title,
            status: projectedStepStatus(step),
            ...(previous?.rationale ? { rationale: previous.rationale } : {}),
          };
        }),
        currentStepId: workflow.currentStepId,
      };

      const projectedBlockers = latestWorkflow.steps
        .map((step) => {
          const approval = approvalEffects.get(step.id);
          return blockerForStep(latestWorkflow, step, approval?.effect, approval?.id);
        })
        .filter((blocker): blocker is SessionBlocker => blocker !== null);
      const workflowLevelBlocker = workflowBlocker(latestWorkflow);
      if (workflowLevelBlocker) projectedBlockers.push(workflowLevelBlocker);
      const retainedBlockers = current.blockers.filter((blocker) => !blocker.id.startsWith(`${PROJECTED_BLOCKER_PREFIX}${workflow.id}:`));

      let next: AgentSession = {
        ...current,
        workflowIds: current.workflowIds.includes(workflow.id) ? current.workflowIds : [...current.workflowIds, workflow.id],
        plan,
        blockers: [...retainedBlockers, ...projectedBlockers],
      };
      const at = latestWorkflow.updatedAt > current.updatedAt ? latestWorkflow.updatedAt : current.updatedAt;
      const targetStatus = sessionStatusFor(latestWorkflow);
      if (current.status !== 'completed' && current.status !== 'archived' && canTransitionSession(current.status, targetStatus)) {
        next = transitionSession(next, targetStatus, at);
      }

      for (const step of latestWorkflow.steps) {
        const activity = stepActivity(latestWorkflow, step);
        if (!activity || next.activity.some((entry) => entry.id === activity.id)) continue;
        next = appendActivity(next, activity, at);
      }
      return next;
    });
  } finally {
    db.close();
  }
}

export const sessionProjector = (workflow: Workflow): void => {
  void projectWorkflow(workflow).catch((error: unknown) => {
    console.warn('Motion: session projection failed —', error instanceof Error ? error.message : error);
  });
};
