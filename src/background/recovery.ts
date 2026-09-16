import { WorkflowEngine } from '@/core/workflows';
import { openDatabase } from '@/core/storage/db';
import { IndexedDbWorkflowStore } from '@/core/storage/workflowStore';
import { Repository } from '@/core/storage/repository';
import { STORE } from '@/core/storage/schema';
import { approvalRequestSchema, type ApprovalRequest } from '@/core/policy';
import { evaluateAssessmentContext, type ActionType } from '@/core/policy';
import { pageTypeSchema } from '@/core/domain';
import { ChromePreferencesStore } from '@/platform/ai/preferencesStore';
import { buildCapabilities } from './capabilities';
import type { TabsCapability } from '@/platform/tabs';
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

interface StoredObservation {
  restricted?: unknown;
  url?: unknown;
  pageType?: unknown;
  title?: unknown;
}

/** Re-evaluated for every attempt: an old observation never grants an action. */
async function policyContextForStep(step: { input: Record<string, unknown> }): Promise<{
  assessmentRestricted: boolean;
  allowedConfigurable: ReadonlySet<ActionType>;
}> {
  const tabId = step.input['tabId'];
  let assessmentRestricted = false;
  if (Number.isInteger(tabId) && (tabId as number) >= 0) {
    const key = `observation:${tabId}`;
    const raw = (await chrome.storage.session.get(key))[key] as StoredObservation | undefined;
    if (raw?.restricted === true) {
      assessmentRestricted = true;
    } else if (typeof raw?.url === 'string' && pageTypeSchema.safeParse(raw?.pageType).success) {
      assessmentRestricted = evaluateAssessmentContext({
        url: raw.url,
        pageType: pageTypeSchema.parse(raw.pageType),
        pageTitle: typeof raw.title === 'string' ? raw.title : '',
      }).restricted;
    }
  }
  // A missing storage.local is possible during early browser startup (and in
  // narrow tab-only tests). It must fail closed: configurable actions still
  // require per-step approval rather than making recovery unavailable.
  const preferences = await new ChromePreferencesStore().get().catch(() => ({
    allowedConfigurableActions: [] as ActionType[],
  }));
  return {
    assessmentRestricted,
    allowedConfigurable: new Set<ActionType>(preferences.allowedConfigurableActions),
  };
}

/**
 * Builds the engine fresh on every call.
 *
 * This is deliberate: caching it in module scope would be a lie, because the
 * worker that holds the cache can be killed between any two events. Opening a
 * database handle per wake is cheap next to a stale-state bug.
 */
export async function createEngine(tabs?: TabsCapability): Promise<WorkflowEngine> {
  const db = await openDatabase();
  const store = new IndexedDbWorkflowStore(db);
  const approvalRepo = new Repository(db, STORE.approvals, approvalRequestSchema);

  return new WorkflowEngine({
    store,
    approvals: {
      save: (approval: ApprovalRequest) => approvalRepo.put(approval),
      get: (id: string) => approvalRepo.get(id),
    },
    capabilities: buildCapabilities(tabs),
    definitions: WORKFLOW_DEFINITIONS,
    // A distinct owner per wake, so a lease held by a dead worker is
    // recognisable as someone else's and expires rather than being reused.
    ownerId: `sw-${crypto.randomUUID().slice(0, 8)}`,
    scheduleRetry: scheduleRetryAlarm,
    policyContext: (_workflow, step) => policyContextForStep(step),
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
