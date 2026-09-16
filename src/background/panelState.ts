import {
  courseSchema,
  courseTaskSchema,
} from '@/core/domain';
import { deadlineBuckets, EMPTY_PANEL_STATE, type PanelState } from '@/core/view';
import { approvalRequestSchema } from '@/core/policy';
import { openDatabase } from '@/core/storage/db';
import { Repository } from '@/core/storage/repository';
import { sessionRepository } from '@/core/storage/repositories';
import { STORE } from '@/core/storage/schema';
import { IndexedDbWorkflowStore } from '@/core/storage/workflowStore';
import { resolveAdapter } from '@/core/adapters';
import { ChromePreferencesStore } from '@/platform/ai/preferencesStore';
import { DEFAULT_AI_PREFERENCES } from '@/core/ai/preferences';
import { providerDisplayNames, resolveSessionProvider } from './providers';

const ACTIVE_SESSION_KEY = 'motion.activeSessionId';
const STREAMING_KEY = 'motion.streaming';

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

async function courseForUrl(url: string | null | undefined) {
  const externalId = url ? resolveAdapter(url)?.courseIdForUrl(url) : null;
  if (!externalId) return null;
  const db = await openDatabase();
  const courses = await new Repository(db, STORE.courses, courseSchema).all();
  return courses.records.find((course) => course.externalId === externalId) ?? null;
}

/** Builds the whole panel view from durable state; no panel-local orchestration. */
export async function buildPanelState(): Promise<PanelState> {
  const db = await openDatabase();
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
  const buckets = deadlineBuckets(tasks.records, new Date(), timeZone);
  const resolution = await resolveSessionProvider().catch(() => null);
  const selected = preferences.providerId;
  const provider = resolution?.kind === 'ready' ? resolution : null;
  const streamingRaw = storedState[STREAMING_KEY];
  const streaming = typeof streamingRaw === 'object' && streamingRaw !== null
    && typeof (streamingRaw as { sessionId?: unknown }).sessionId === 'string'
    && typeof (streamingRaw as { text?: unknown }).text === 'string'
    ? streamingRaw as PanelState['streaming']
    : null;

  return {
    ...EMPTY_PANEL_STATE,
    connection: connectionFor(observation),
    page: observation
      ? (({ restricted: _restricted, ...page }) => page)(observation)
      : EMPTY_PANEL_STATE.page,
    course: await courseForUrl(observation?.url),
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
    streaming: streaming?.sessionId === activeSession?.id ? streaming : null,
  };
}
