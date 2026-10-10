import {
  courseSchema,
  courseTaskSchema,
  type Course,
} from '@/core/domain';
import { z } from 'zod';
import { deadlineBuckets, EMPTY_PANEL_STATE, type PanelState, type WorkspaceTabSummary } from '@/core/view';
import { approvalRequestSchema } from '@/core/policy';
import { openDatabase } from '@/core/storage/db';
import { Repository } from '@/core/storage/repository';
import { sessionRepository } from '@/core/storage/repositories';
import { STORE } from '@/core/storage/schema';
import { IndexedDbWorkflowStore } from '@/core/storage/workflowStore';
import { resolveAdapter } from '@/core/adapters';
import { ChromePreferencesStore } from '@/platform/ai/preferencesStore';
import { ChromeTabs } from '@/platform/tabs';
import { DEFAULT_AI_PREFERENCES } from '@/core/ai/preferences';
import { providerDisplayNames, resolveSessionProvider } from './providers';
import { recoverWorkflows } from './recovery';

const ACTIVE_SESSION_KEY = 'motion.activeSessionId';
const STREAMING_KEY = 'motion.streaming';
const RECOVERY_CHECKED_KEY = 'motion.panelRecoveryCheckedAt';
/** The panel refreshes every ~150ms while streaming; recovery need not. */
export const PANEL_RECOVERY_INTERVAL_MS = 30_000;
const storedStreamingSchema = z.object({
  sessionId: z.string().min(1),
  requestKey: z.string().min(1),
  text: z.string().max(40_000),
});

type StoredObservation = PanelState['page'] & { restricted?: boolean };

function observationKey(tabId: number): string {
  return `observation:${tabId}`;
}

function connectionFor(observation: StoredObservation | undefined): PanelState['connection'] {
  if (!observation) return 'idle';
  if (observation.restricted) return 'restricted';
  if (observation.pageType === 'signed-out') return 'signed-out';
  if (observation.pageType === 'unsupported' || observation.pageType === null) return 'unsupported';
  return 'supported';
}

/**
 * A scan lease counts only until it expires. A worker that dies mid-scan never
 * clears `busy`, and trusting the flag alone left "Scanning courses…" stuck.
 */
export function discoveryBusy(
  settings: { busy?: unknown; busyUntil?: unknown } | undefined,
  now: Date,
): boolean {
  return settings?.busy === true && typeof settings.busyUntil === 'string' && new Date(settings.busyUntil).getTime() > now.getTime();
}

/**
 * Whether this panel refresh should also run workflow recovery. The last
 * check is kept in session storage because module state dies with the worker.
 * If storage is unavailable, recovery runs rather than being skipped.
 */
async function panelRecoveryDue(now: number): Promise<boolean> {
  try {
    const last = (await chrome.storage.session.get(RECOVERY_CHECKED_KEY))[RECOVERY_CHECKED_KEY];
    if (typeof last === 'number' && now >= last && now - last < PANEL_RECOVERY_INTERVAL_MS) return false;
    await chrome.storage.session.set({ [RECOVERY_CHECKED_KEY]: now });
  } catch {
    // Fall through: an unthrottled recovery is safe, a skipped one may not be.
  }
  return true;
}

function courseForUrl(courses: Course[], url: string | null | undefined) {
  const externalId = url ? resolveAdapter(url)?.courseIdForUrl(url) : null;
  if (!externalId) return null;
  return courses.find((course) => course.externalId === externalId) ?? null;
}

async function workspaceTabsFor(
  session: PanelState['activeSession'],
  activeTabId: number | undefined,
): Promise<WorkspaceTabSummary[]> {
  if (!session) return [];
  const tabs = new ChromeTabs();
  const ids = [
    ...session.workspace.ownedTabIds.map((tabId) => ({ tabId, ownership: 'motion' as const })),
    ...session.workspace.adoptedTabIds.map((tabId) => ({ tabId, ownership: 'student' as const })),
  ].filter(({ tabId }) => !session.workspace.releasedTabIds.includes(tabId));
  return (await Promise.all(ids.map(async ({ tabId, ownership }) => {
    const live = await tabs.get(tabId);
    if (!live) return null;
    let host: string | null = null;
    try { host = new URL(live.url).hostname; } catch { /* title remains useful */ }
    return {
      tabId,
      title: live.title.trim() || host || 'Untitled page',
      host,
      ownership,
      current: tabId === activeTabId,
    };
  }))).flatMap((tab) => tab ? [tab] : []);
}

/** Builds the whole panel view from durable state; no panel-local orchestration. */
export async function buildPanelState(): Promise<PanelState> {
  // Opening or waking the panel is a recovery trigger: a lease may have
  // expired while the service worker was suspended and no alarm was delivered.
  if (await panelRecoveryDue(Date.now())) await recoverWorkflows();
  const db = await openDatabase();
  // One connection per refresh, always closed: an open handle with an
  // `onversionchange` listener is never collected.
  try {
    return await buildPanelStateFrom(db);
  } finally {
    db.close();
  }
}

async function buildPanelStateFrom(db: IDBDatabase): Promise<PanelState> {
  const taskRepo = new Repository(db, STORE.tasks, courseTaskSchema);
  const approvalRepo = new Repository(db, STORE.approvals, approvalRequestSchema);
  const courses = new Repository(db, STORE.courses, courseSchema);
  const sessions = sessionRepository(db);
  const workflowStore = new IndexedDbWorkflowStore(db);
  const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const observationRaw = activeTab?.id === undefined
    ? undefined
    : (await chrome.storage.session.get(observationKey(activeTab.id)))[observationKey(activeTab.id)];
  const observation = typeof observationRaw === 'object' && observationRaw !== null
    ? observationRaw as StoredObservation
    : undefined;
  const [tasks, approvals, allCourses, allSessions, storedState, preferences] = await Promise.all([
    taskRepo.all(),
    approvalRepo.all(),
    courses.all(),
    sessions.all(),
    chrome.storage.session.get([ACTIVE_SESSION_KEY, STREAMING_KEY]),
    new ChromePreferencesStore().get().catch(() => DEFAULT_AI_PREFERENCES),
  ]);
  const activeId = typeof storedState[ACTIVE_SESSION_KEY] === 'string'
    ? storedState[ACTIVE_SESSION_KEY]
    : null;
  const activeSession = activeId ? allSessions.records.find((session) => session.id === activeId) ?? null : null;
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const origin = observation?.url ? new URL(observation.url).origin : null;
  const discoveryKey = origin ? `motion.discovery:${origin}` : null;
  const discoveryStored = discoveryKey ? (await chrome.storage.local.get(discoveryKey))[discoveryKey] : null;
  const discovery = typeof discoveryStored === 'object' && discoveryStored !== null ? discoveryStored as { optedIn?: unknown; busy?: unknown; busyUntil?: unknown; result?: unknown; blocker?: unknown } : {};
  const buckets = deadlineBuckets(tasks.records, new Date(), timeZone);
  // This path runs for every panel state refresh, including each streaming
  // preview update. Readiness needs no model catalogue request; model turns
  // and the explicit settings refresh verify account model availability.
  const resolution = await resolveSessionProvider({ resolveModelListing: false }).catch(() => null);
  const selected = preferences.providerId;
  const provider = resolution?.kind === 'ready' ? resolution : null;
  const storedStreaming = storedStreamingSchema.safeParse(storedState[STREAMING_KEY]);
  const streaming = storedStreaming.success
    && storedStreaming.data.sessionId === activeSession?.id
    && storedStreaming.data.requestKey === activeSession?.pendingModelRequest?.key
    && activeSession.pendingModelRequest?.generation === activeSession.modelTurnGeneration
    ? {
        sessionId: storedStreaming.data.sessionId,
        text: storedStreaming.data.text,
      }
    : null;

  return {
    ...EMPTY_PANEL_STATE,
    connection: connectionFor(observation),
    page: observation
      ? (({ restricted: _restricted, ...page }) => page)(observation)
      : EMPTY_PANEL_STATE.page,
    course: courseForUrl(allCourses.records, observation?.url),
    courses: allCourses.records.filter((course) => !course.archived),
    tasks: tasks.records.filter((task) => !task.archived).sort((a, b) => {
      if (a.due.iso && b.due.iso) return a.due.iso.localeCompare(b.due.iso);
      if (a.due.iso) return -1;
      if (b.due.iso) return 1;
      return a.title.localeCompare(b.title);
    }),
    workflows: await workflowStore.list(),
    approvals: approvals.records.filter((approval) => approval.status === 'pending').sort((a, b) => b.requestedAt.localeCompare(a.requestedAt)),
    corruptedRecords: tasks.corrupted.length + approvals.corrupted.length + allCourses.corrupted.length + allSessions.corrupted.length,
    sessions: allSessions.records
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((session) => ({
        id: session.id,
        title: session.title,
        status: session.status,
        courseId: session.courseId,
        taskId: session.taskId,
        updatedAt: session.updatedAt,
        needsYou: session.blockers.length,
        currentStepTitle: session.plan.steps.find((step) => step.id === session.plan.currentStepId)?.title ?? null,
      })),
    activeSession,
    workspaceTabs: await workspaceTabsFor(activeSession, activeTab?.id),
    deadlines: {
      today: buckets.today.map((task) => task.id),
      upcoming: buckets.upcoming.map((task) => task.id),
      overdue: buckets.overdue.map((task) => task.id),
      needsReview: buckets.needsReview.map((task) => task.id),
    },
    ai: {
      providerId: selected,
      displayName: provider?.displayName ?? providerDisplayNames[selected],
      cloud: selected !== 'chrome-local',
      status: provider ? 'available' : resolution?.kind === 'blocked' ? resolution.blocker.kind : 'unavailable',
      message: provider ? `${provider.displayName} is ready.` : resolution?.kind === 'blocked' ? resolution.blocker.message : '',
    },
    streaming,
    discovery: { host: origin, optedIn: typeof discovery.optedIn === 'boolean' ? discovery.optedIn : null, busy: discoveryBusy(discovery, new Date()), result: discovery.result as PanelState['discovery']['result'], blocker: typeof discovery.blocker === 'string' ? discovery.blocker : null },
  };
}
