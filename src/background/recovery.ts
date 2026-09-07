import { WorkflowEngine } from '@/core/workflows';
import { openDatabase } from '@/core/storage/db';
import { IndexedDbWorkflowStore } from '@/core/storage/workflowStore';
import { Repository } from '@/core/storage/repository';
import { STORE } from '@/core/storage/schema';
import { approvalRequestSchema, type ApprovalRequest } from '@/core/policy';
import { buildCapabilities } from './capabilities';
import { WORKFLOW_DEFINITIONS } from './definitions';

export const RETRY_ALARM_PREFIX = 'motion:retry:';

/**
 * Alarms have a one-minute floor in Chrome. A retry due sooner is scheduled at
 * the floor rather than being dropped — late is recoverable, never is not.
 */
export function scheduleRetryAlarm(workflowId: string, at: Date): void {
  const whenMs = Math.max(at.getTime(), Date.now() + 60_000);
  void chrome.alarms.create(`${RETRY_ALARM_PREFIX}${workflowId}`, { when: whenMs });
}

/**
 * Builds the engine fresh on every call.
 *
 * This is deliberate: caching it in module scope would be a lie, because the
 * worker that holds the cache can be killed between any two events. Opening a
 * database handle per wake is cheap next to a stale-state bug.
 */
export async function createEngine(): Promise<WorkflowEngine> {
  const db = await openDatabase();
  const store = new IndexedDbWorkflowStore(db);
  const approvalRepo = new Repository(db, STORE.approvals, approvalRequestSchema);

  return new WorkflowEngine({
    store,
    approvals: {
      save: (approval: ApprovalRequest) => approvalRepo.put(approval),
      get: (id: string) => approvalRepo.get(id),
    },
    capabilities: buildCapabilities(),
    definitions: WORKFLOW_DEFINITIONS,
    // A distinct owner per wake, so a lease held by a dead worker is
    // recognisable as someone else's and expires rather than being reused.
    ownerId: `sw-${crypto.randomUUID().slice(0, 8)}`,
    scheduleRetry: scheduleRetryAlarm,
  });
}

/**
 * Resume interrupted work. Called on startup, on update, when an alarm fires,
 * and when a supported page finishes loading — because persisted state cannot
 * wake a worker by itself.
 */
export async function recoverWorkflows(workflowId?: string): Promise<void> {
  try {
    const engine = await createEngine();
    if (workflowId) {
      await engine.advance(workflowId);
      return;
    }
    await engine.recoverInterrupted();
  } catch (error) {
    // Recovery must never throw into an event handler: a failure here would
    // take down handling of the event that triggered it.
    console.warn('Motion: recovery failed —', error instanceof Error ? error.message : error);
  }
}
