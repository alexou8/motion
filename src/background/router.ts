import type { Message } from '@/core/messaging';
import {
  checklistSchema,
  courseSchema,
  courseTaskSchema,
  noteSchema,
  EXTRACTION_VERSION,
  type CourseTask,
} from '@/core/domain';
import {
  composeDraftPrompt,
  buildPrompt,
  composeChatPrompt,
  CHAT_LABEL,
  deriveRequirements,
  GENERATED_LABEL,
  reviewDraft,
  summarize,
  toRequirements,
  unsupportedClaims,
} from '@/core/assist';
import { explainAvailability, type LanguageModelCapability } from '@/platform/languageModel';
import { approvalRequestSchema } from '@/core/policy';
import { openDatabase } from '@/core/storage/db';
import { Repository } from '@/core/storage/repository';
import { sessionRepository, updateTask, upsertExtractedTask } from '@/core/storage/repositories';
import { STORE } from '@/core/storage/schema';
import { IndexedDbWorkflowStore } from '@/core/storage/workflowStore';
import { EMPTY_PANEL_STATE, popupLauncherStateSchema, type PanelState, type PopupAction, type PopupLauncherState } from '@/core/view';
import { createEngine } from './recovery';
import { adapterById, resolveAdapter } from '@/core/adapters';
import type { Course } from '@/core/domain';
import { isTerminal } from '@/core/workflows';
import { selectWorkspaceSources, workspaceOwnership, workspacePageUrl } from '@/core/workspace';
import { sessionTitle } from '@/core/session';
import { evaluateAssessmentContext } from '@/core/policy';
import { withLock } from '@/platform/locks';
import { ChromeTabs, groupTitle, type LiveTab, type TabsCapability } from '@/platform/tabs';
import { askContentScript, sendToContentScript } from './contentBridge';
import { adoptWorkspaceTab, createOrReuseWorkspaceSession, handleSessionMessage } from './sessions';
import { buildPanelState as buildAgentPanelState } from './panelState';
import { handleAiMessage } from './aiHandlers';
import { resolveSessionProvider } from './providers';
import { discoveryRunResultSchema } from '@/core/adapters/d2lDiscovery';
import { reconcileReminders } from './reminders';

/**
 * Handles an already-authorized message.
 *
 * Everything reaching here has passed sender identity, role and shape checks,
 * so this file is about *what* to do, never about whether the caller was
 * entitled to ask. Each handler opens what it needs and closes over nothing:
 * the worker may not survive to the next message.
 */
export async function handleMessage(message: Message, tabId?: number): Promise<unknown> {
  switch (message.type) {
    case 'page-observed':
      return handlePageObserved(message, tabId);
    case 'extraction-result':
      return handleExtraction(message);
    case 'get-state':
      return buildAgentPanelState();
    case 'popup-context':
      return buildPopupLauncherState(message.tabId);
    case 'popup-command':
      return handlePopupCommand(message);
    case 'session-create':
    case 'session-message':
    case 'session-command':
    case 'session-select':
    case 'session-source':
    case 'session-tab':
      return handleSessionMessage(message);
    case 'ai-status':
    case 'set-provider-key':
    case 'forget-provider-key':
    case 'test-provider':
    case 'set-ai-preferences':
    case 'accept-cloud-disclosure':
    case 'delete-local-data': {
      return handleAiMessage(message);
    }
    case 'decide-approval': {
      const engine = await createEngine();
      const workflow = await engine.decideApproval(message.approvalId, message.approved);
      return { workflow };
    }
    case 'workflow-command': {
      const engine = await createEngine();
      switch (message.command) {
        case 'pause':
          return { workflow: await engine.pause(message.workflowId) };
        case 'resume':
          return { workflow: await engine.resume(message.workflowId) };
        case 'retry':
          return { workflow: await engine.retry(message.workflowId) };
        case 'cancel':
          return { workflow: await engine.cancel(message.workflowId) };
      }
      return {};
    }
    case 'correct-task':
      return handleCorrection(message);
    case 'create-note':
      return handleCreateNote(message);
    case 'build-checklist':
      return handleBuildChecklist(message);
    case 'review-draft':
      return handleReviewDraft(message);
    case 'toggle-requirement':
      return handleToggleRequirement(message);
    case 'compose-draft':
      return handleComposeDraft(message);
    case 'model-status':
      return handleModelStatus();
    case 'get-checklist': {
      const db = await openDatabase();
      const checklists = new Repository(db, STORE.checklists, checklistSchema);
      return checklists.get(message.checklistId);
    }
    case 'request-extraction':
      return requestExtraction(message.tabId ?? tabId);
    case 'scan-all-courses':
      return message.tabId === undefined ? { kind: 'error', message: 'Open Learn before scanning your courses.' } : scanAllCourses(message.tabId);
    case 'set-deadline-discovery-opt-in':
      await chrome.storage.local.set({ [`motion.discovery:${new URL(message.host).origin}`]: { optedIn: message.enabled } });
      return { updated: true };
    case 'prepare-workspace':
      return handlePrepareWorkspace(message.tabId);
    case 'ask-about-page':
      return handleAskAboutPage(message);
    case 'close-workspace':
      return handleCloseWorkspace(message.workflowId);
  }
}

/** A safe, student-readable refusal that crosses the worker UI boundary. */
export class UiCommandError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly recoverable = true,
  ) {
    super(message);
  }
}

async function activeSessionForPage(
  courseId: string | null,
  pageUrl: string | null | undefined,
  browserSessionKey: string,
): Promise<{ id: string; title: string } | null> {
  const target = pageUrl ? workspacePageUrl(pageUrl) : null;
  if (!courseId || !target) return null;
  const db = await openDatabase();
  try {
    const sessions = await sessionRepository(db).all();
    const found = sessions.records
      .filter((session) => session.courseId === courseId
        && session.workspace.sessionKey === browserSessionKey
        && session.status !== 'archived'
        && session.status !== 'completed'
        && session.context.sources.some((source) => workspacePageUrl(source.url) === target))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    return found ? { id: found.id, title: found.title } : null;
  } finally {
    db.close();
  }
}

/** Minimal worker-derived state for the transient toolbar popup. */
export async function buildPopupLauncherState(tabId: number): Promise<PopupLauncherState> {
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  if (!tab?.url || tab.windowId === undefined)
    throw new UiCommandError('tab-unavailable', 'Motion could not find the page you opened the popup from. Try again.');

  const observation = await readObservation(tabId);
  const course = await courseForUrl(observation?.url);
  const relevant = await activeSessionForPage(
    course?.id ?? null,
    observation?.url,
    await new ChromeTabs().sessionKey(),
  );
  return popupLauncherStateSchema.parse({
    tabId,
    windowId: tab.windowId,
    connection: connectionFor(observation),
    title: observation?.restricted ? '' : observation?.title || tab.title || '',
    courseLabel: course?.code ?? course?.name ?? null,
    relevantSessionId: relevant?.id ?? null,
    relevantSessionTitle: relevant?.title ?? null,
  });
}

function requirePopupAction(
  state: PopupLauncherState,
  action: PopupAction,
  sessionId: string | null,
): void {
  if (action === 'open-motion') return;
  if (state.connection === 'restricted')
    throw new UiCommandError('restricted-page', 'Motion will not act inside this active assessment. Open Motion for help outside the attempt.');
  if (state.connection !== 'supported')
    throw new UiCommandError('unsupported-page', 'This tab is not a supported LMS page. Open Motion without starting a workspace.');
  if (action === 'continue-session' && (!state.relevantSessionId || sessionId !== state.relevantSessionId))
    throw new UiCommandError('stale-session', 'That workspace is no longer available. Reopen the popup and choose a current workspace.');
}

/**
 * Popup commands remain intent-level. The worker owns the page checks, session
 * selection, reading, and grouping; the popup never receives selectors or
 * browser-workspace authority.
 */
export async function handlePopupCommand(
  message: Extract<Message, { type: 'popup-command' }>,
): Promise<{ action: PopupAction; workflowId?: string; sessionId?: string; requested?: boolean }> {
  const state = await buildPopupLauncherState(message.tabId);
  requirePopupAction(state, message.action, message.sessionId);
  switch (message.action) {
    case 'open-motion':
      return { action: message.action };
    case 'continue-session':
      // Continuing a workspace also reconciles the tab the student is viewing
      // into that session's existing group. Selection alone left the page
      // outside the workspace and made ownership/cancel state misleading.
      {
        const adopted = await adoptWorkspaceTab(message.sessionId!, message.tabId);
        if (!adopted.updated)
          throw new UiCommandError('workspace-unavailable', adopted.reason ?? 'Motion could not reopen this workspace.');
      }
      await handleSessionMessage({ type: 'session-select', sessionId: message.sessionId });
      return { action: message.action, sessionId: message.sessionId ?? undefined };
    case 'read-current-page': {
      const result = await requestExtraction(message.tabId);
      if (!result.requested)
        throw new UiCommandError('page-unavailable', 'Motion could not read this page. Wait for it to load, then try again.');
      return { action: message.action, requested: true };
    }
    case 'scan-deadlines': {
      await scanAllCourses(message.tabId);
      return { action: message.action };
    }
    case 'start-workspace': {
      const tabs = new ChromeTabs();
      const observation = await readObservation(message.tabId);
      if (!observation?.url)
        throw new UiCommandError('page-unavailable', 'Motion could not confirm this page. Wait for it to load, then try again.');
      const course = await courseForUrl(observation.url);
      const title = sessionTitle(course?.code, state.title || 'Coursework');
      const session = await createOrReuseWorkspaceSession({
        title,
        goal: `Work on ${state.title || 'this coursework page'}.`,
        courseId: course?.id ?? null,
        pageUrl: observation.url,
        browserSessionKey: await tabs.sessionKey(),
      });
      const workspace = await handlePrepareWorkspace(message.tabId, tabs, session.id);
      if (!workspace.workflowId)
        throw new UiCommandError('workspace-unavailable', workspace.reason ?? 'Motion could not prepare this workspace. Try again.');
      const adopted = await adoptWorkspaceTab(session.id, message.tabId, tabs);
      if (!adopted.updated)
        throw new UiCommandError('workspace-changed', adopted.reason ?? 'Motion could not group this tab because the page changed. Try Start workspace again.');
      return { action: message.action, workflowId: workspace.workflowId, sessionId: session.id };
    }
  }
}

/**
 * A page observation is a signal, not data to keep. Nothing from a page marked
 * restricted is stored — that is the point of restricted mode.
 *
 * Storing nothing is not the same as leaving the previous observation in place:
 * that showed the last course page's workspace over a graded attempt, which is
 * both stale and the wrong thing to offer there. The stored observation is
 * dropped instead, so the panel falls back to its idle state. This writes
 * strictly less than before; nothing about the attempt is recorded.
 */
type StoredObservation = PanelState['page'] & { restricted?: boolean };

/**
 * One session-storage key per tab.
 *
 * Deliberately not a single object holding every tab: that is a
 * read-modify-write, and two tabs reporting at once can lose an update. Losing
 * *this* update matters — the dropped one could be the marker saying a tab is a
 * graded attempt, which would put the workspace back in front of one.
 */
const OBSERVATION_PREFIX = 'observation:';

const observationKey = (tabId: number): string => `${OBSERVATION_PREFIX}${tabId}`;

async function readObservation(tabId: number): Promise<StoredObservation | undefined> {
  const key = observationKey(tabId);
  const session = await chrome.storage.session.get(key);
  const stored = session[key];
  return typeof stored === 'object' && stored !== null ? (stored as StoredObservation) : undefined;
}

/**
 * Records what a tab is showing, so the panel can describe the tab the student
 * is actually looking at.
 *
 * One observation per tab, rather than one for the whole browser. A single slot
 * meant a second tab could overwrite or erase the first, and — worse — a graded
 * attempt in the active tab could leave another tab's coursework workspace on
 * screen, offering drafting beside an assessment.
 *
 * A restricted page records that it is restricted and nothing else: no URL, no
 * title, no warnings, no content. That is enough for the panel to say why it is
 * standing back, and it is all the assessment boundary allows.
 */
async function handlePageObserved(
  message: Extract<Message, { type: 'page-observed' }>,
  tabId?: number,
): Promise<{ stored: boolean }> {
  if (tabId === undefined) return { stored: false };
  const observedAt = new Date().toISOString();

  const observation: StoredObservation = message.restricted
    ? {
        url: null,
        pageType: message.pageType,
        title: '',
        restrictionReason: 'This page looks like a graded attempt.',
        warnings: [],
        observedAt,
        restricted: true,
      }
    : {
        url: message.url,
        pageType: message.pageType,
        title: message.title,
        restrictionReason: null,
        warnings: message.warnings,
        observedAt,
      };

  await chrome.storage.session.set({ [observationKey(tabId)]: observation });
  if (!message.restricted) void maybeAutomaticCourseScan(tabId, message.url);
  return { stored: !message.restricted };
}

const AUTOMATIC_SCAN_INTERVAL_MS = 6 * 60 * 60 * 1_000;
const DISCOVERY_BUSY_LEASE_MS = 5 * 60 * 1_000;
type DiscoverySettings = {
  optedIn?: unknown;
  busy?: unknown;
  busyUntil?: unknown;
  busyRunId?: unknown;
  lastAutomaticAt?: unknown;
  blocker?: unknown;
  result?: unknown;
};

export function discoveryBusy(settings: DiscoverySettings | undefined, now: Date): boolean {
  return settings?.busy === true && typeof settings.busyUntil === 'string' && new Date(settings.busyUntil).getTime() > now.getTime();
}
export function automaticDiscoveryDue(lastAutomaticAt: unknown, now: Date): boolean {
  const last = typeof lastAutomaticAt === 'string' ? new Date(lastAutomaticAt).getTime() : 0;
  return !Number.isFinite(last) || now.getTime() - last >= AUTOMATIC_SCAN_INTERVAL_MS;
}
async function maybeAutomaticCourseScan(tabId: number, url: string): Promise<void> {
  if (!chrome.storage.local) return;
  const key = `motion.discovery:${new URL(url).origin}`;
  const stored = await chrome.storage.local.get(key);
  const settings = stored[key] as DiscoverySettings | undefined;
  if (settings?.optedIn !== true || discoveryBusy(settings, new Date()) || !automaticDiscoveryDue(settings?.lastAutomaticAt, new Date())) return;
  await chrome.storage.local.set({ [key]: { ...settings, lastAutomaticAt: new Date().toISOString() } });
  await scanAllCourses(tabId);
}

/**
 * Forgets what a tab was showing: it closed, or it navigated somewhere new.
 *
 * Called at the start of a navigation as well as on close. Until the new page
 * reports itself, the panel must not keep describing the page that was there
 * before — a note taken in that window would otherwise be filed against the
 * previous page's URL.
 */
export async function forgetTab(tabId: number): Promise<void> {
  await chrome.storage.session.remove(observationKey(tabId));
}

async function handleExtraction(
  message: Extract<Message, { type: 'extraction-result' }>,
): Promise<{ courses: number; tasks: number }> {
  return upsertExtractedRecords(message.course ? [message.course] : [], message.tasks);
}

/** Shared W1 upsert path for page extraction and all-course discovery. */
export async function upsertExtractedRecords(incomingCourses: Course[], incomingTasks: CourseTask[]): Promise<{ courses: number; tasks: number }> {
  const db = await openDatabase();
  const courses = new Repository(db, STORE.courses, courseSchema);
  for (const course of incomingCourses) await courses.put(course);

  let written = 0;
  for (const task of incomingTasks) {
    await upsertExtractedTask(db, task, legacyTaskMatches);
    written += 1;
  }

  return { courses: incomingCourses.length, tasks: written };
}

/**
 * Scans in flight in this worker, keyed by LMS origin.
 *
 * The stored `busyRunId` lease is a read-then-write, so an automatic scan
 * firing as the student presses "Scan all courses" can pass the busy check
 * twice before either writes. Both would then hit the LMS, and whichever
 * finished second would find a lease it no longer owns and silently drop the
 * results it had just gathered. Joining the scan already running is both
 * cheaper and what the student meant. The map is in-memory on purpose: a
 * suspended worker has no scan in flight to join, and the stored lease still
 * covers that case.
 */
const scansInFlight = new Map<string, Promise<unknown>>();

async function scanAllCourses(tabId: number): Promise<unknown> {
  const tab = await chrome.tabs.get(tabId);
  if (tab.url && resolveAdapter(tab.url)) {
    const origin = new URL(tab.url).origin;
    const running = scansInFlight.get(origin);
    if (running) return running;
    const scan = runCourseScan(tabId).finally(() => {
      scansInFlight.delete(origin);
    });
    scansInFlight.set(origin, scan);
    return scan;
  }
  return runCourseScan(tabId);
}

async function runCourseScan(tabId: number): Promise<unknown> {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url || !resolveAdapter(tab.url)) {
    const message = 'Open Learn before scanning your courses.';
    if (tab.url) {
      const origin = new URL(tab.url).origin;
      const unsupportedKey = `motion.discovery:${origin}`;
      const existing = (await chrome.storage.local.get(unsupportedKey))[unsupportedKey] as DiscoverySettings | undefined;
      await chrome.storage.local.set({
        [unsupportedKey]: { ...(existing ?? { optedIn: false }), busy: false, busyRunId: null, busyUntil: null, blocker: message },
      });
    }
    return { kind: 'error', message };
  }
  const stored = await chrome.storage.local.get(`motion.discovery:${new URL(tab.url).origin}`);
  const key = `motion.discovery:${new URL(tab.url).origin}`;
  const settings = stored[key] as DiscoverySettings | undefined;
  if (settings?.optedIn !== true) return { kind: 'refused', message: 'Enable course scanning first.' };
  const runId = crypto.randomUUID();
  const startedAt = new Date();
  await chrome.storage.local.set({ [key]: { ...settings, busy: true, busyRunId: runId, busyUntil: new Date(startedAt.getTime() + DISCOVERY_BUSY_LEASE_MS).toISOString(), blocker: null } });
  const finish = async (patch: Omit<DiscoverySettings, 'optedIn'>): Promise<boolean> => {
    const current = (await chrome.storage.local.get(key))[key] as DiscoverySettings | undefined;
    // A scan must never revive consent or store material gathered after the
    // student opted out. A stale worker only clears the lease it owns.
    if (current?.optedIn !== true || current.busyRunId !== runId) return false;
    await chrome.storage.local.set({ [key]: { ...current, ...patch, busy: false, busyRunId: null, busyUntil: null } });
    return true;
  };
  try {
    const raw = await sendToContentScript(tabId, { type: 'motion:discover-deadlines' });
    const result = discoveryRunResultSchema.safeParse(raw);
    if (!result.success) throw new Error('Invalid discovery response.');
    if (result.data.kind === 'success') {
      const current = (await chrome.storage.local.get(key))[key] as DiscoverySettings | undefined;
      if (current?.optedIn !== true || current.busyRunId !== runId) {
        // Consent was revoked (or another run took over) while this scan's
        // network calls were in flight. Drop the freshly gathered result
        // instead of storing it, but still release the lease this run owns
        // so the UI doesn't stay stuck on "Scanning courses…" until it expires.
        if (current?.busyRunId === runId) {
          await chrome.storage.local.set({ [key]: { ...current, busy: false, busyRunId: null, busyUntil: null } });
        }
        return { kind: 'refused', message: 'Course scanning was turned off before this scan finished.' };
      }
      await upsertExtractedRecords(result.data.courses, result.data.tasks);
      await reconcileReminders().catch(() => undefined);
      await finish({ result: { deadlines: result.data.tasks.length, courses: result.data.courses.length, updatedAt: result.data.scannedAt }, blocker: null });
    } else await finish({ result: null, blocker: result.data.message });
    return result.data;
  } catch {
    const message = 'Motion could not scan Learn right now. Try again while you are signed in.';
    await finish({ result: null, blocker: message });
    return { kind: 'error', message };
  }
}

function normalizedTaskTitle(title: string): string {
  return title.toLowerCase().replace(/\s+/g, ' ').trim();
}

function legacyTitleMatches(legacy: CourseTask, incoming: CourseTask): boolean {
  const incomingTitle = normalizedTaskTitle(incoming.title);
  if (normalizedTaskTitle(legacy.title) === incomingTitle) return true;
  return legacy.corrections.some(
    (correction) =>
      correction.field === 'title' &&
      typeof correction.originalValue === 'string' &&
      normalizedTaskTitle(correction.originalValue) === incomingTitle,
  );
}

function legacyTaskMatches(
  candidate: CourseTask,
  incoming: CourseTask,
): boolean {
  const adapter = adapterById(candidate.provenance.platformId) ?? resolveAdapter(incoming.provenance.sourceUrl);
  // A tombstone (already folded once) is never a legacy-match candidate: its
  // dependents were re-pointed at the canonical row when it was archived, and
  // matching it again here would only recreate the duplicate D-ID exists to
  // remove. See upsertExtractedTask's own tombstone-redirect for exact-id hits.
  return !candidate.archived && candidate.kind === incoming.kind &&
    adapter?.isLegacyTaskId(candidate.id, incoming.courseId) === true &&
    legacyTitleMatches(candidate, incoming);
}

/**
 * Applies a student's correction additively: the original extracted value and
 * its provenance are kept, so a mistaken correction stays recoverable.
 */
async function handleCorrection(
  message: Extract<Message, { type: 'correct-task' }>,
): Promise<{ updated: boolean }> {
  const db = await openDatabase();
  const now = new Date().toISOString();
  const updated = await updateTask(db, message.taskId, (task) => {
    const next = { ...task, studentEdited: true, updatedAt: now };
    switch (message.field) {
      case 'title':
        if (typeof message.value !== 'string') return null;
        return { ...next, title: message.value, corrections: [...task.corrections, { field: 'title', originalValue: task.title, correctedValue: message.value, correctedAt: now }] };
      case 'dueIso': {
        const value = typeof message.value === 'string' ? message.value : null;
        return { ...next, due: { ...task.due, iso: value, confidence: 'confirmed' as const }, corrections: [...task.corrections, { field: 'due.iso', originalValue: task.due.iso, correctedValue: value, correctedAt: now }] };
      }
      case 'weight': {
        if (typeof message.value !== 'number' && message.value !== null) return null;
        return { ...next, weight: message.value, corrections: [...task.corrections, { field: 'weight', originalValue: task.weight, correctedValue: message.value, correctedAt: now }] };
      }
      case 'status': {
        const parsed = courseTaskSchema.shape.status.safeParse(message.value);
        if (!parsed.success) return null;
        return { ...next, status: parsed.data, corrections: [...task.corrections, { field: 'status', originalValue: task.status, correctedValue: parsed.data, correctedAt: now }] };
      }
    }
  });
  return { updated: updated !== null };
}

/**
 * Creates a note that keeps its source.
 *
 * The captured text and the student's own writing are separate blocks, so the
 * distinction between "what the page said" and "what I think" survives in the
 * data rather than depending on a UI convention. Nothing here can produce a
 * `generated` block: there is no model in this release, and a block claiming to
 * be AI-written would be a lie.
 */
async function handleCreateNote(
  message: Extract<Message, { type: 'create-note' }>,
): Promise<{ noteId: string }> {
  const db = await openDatabase();
  const notes = new Repository(db, STORE.notes, noteSchema);
  const now = new Date().toISOString();
  const noteId = crypto.randomUUID();

  await notes.put({
    id: noteId,
    courseId: message.courseId,
    taskId: message.taskId,
    title: message.title,
    tags: [],
    blocks: [
      {
        id: crypto.randomUUID(),
        origin: 'captured',
        text: message.capturedText,
        provenance: {
          sourceUrl: message.sourceUrl,
          pageTitle: message.pageTitle,
          platformId: 'd2l',
          pageType: message.pageType,
          capturedAt: now,
          extractionVersion: EXTRACTION_VERSION,
          strategy: 'student-selection',
        },
        createdAt: now,
      },
    ],
    createdAt: now,
    updatedAt: now,
  });

  return { noteId };
}

/**
 * Builds a source-linked checklist from the assignment's own instructions.
 *
 * The instruction text comes from the content script, not from the panel, so a
 * compromised panel cannot inject requirements the instructor never set. Every
 * item keeps the sentence and page it came from, because a checklist a student
 * cannot verify is worse than none.
 */
async function handleBuildChecklist(
  message: Extract<Message, { type: 'build-checklist' }>,
): Promise<{ checklistId: string | null; items: number; reason?: string }> {
  const content = await askContentScript(message.tabId);
  if (!content) {
    return { checklistId: null, items: 0, reason: 'Motion could not read that page.' };
  }
  if (content.instructionBlocks.length === 0) {
    return {
      checklistId: null,
      items: 0,
      reason: 'This page does not look like it has assignment instructions on it.',
    };
  }

  const derived = deriveRequirements(content.instructionBlocks);
  if (derived.length === 0) {
    return {
      checklistId: null,
      items: 0,
      // Better to say nothing was found than to invent a plausible checklist.
      reason: 'Motion could not find anything stated as a requirement on this page.',
    };
  }

  const now = new Date().toISOString();
  const checklistId = crypto.randomUUID();
  const db = await openDatabase();
  const checklists = new Repository(db, STORE.checklists, checklistSchema);

  await checklists.put({
    id: checklistId,
    courseId: (await courseForUrl(content.url))?.id ?? 'unassigned',
    taskId: message.taskId,
    title: content.title || 'Assignment requirements',
    items: toRequirements(
      derived,
      {
        url: content.url,
        pageTitle: content.title,
        pageType: content.pageType,
        capturedAt: content.capturedAt,
      },
      () => crypto.randomUUID(),
    ),
    createdAt: now,
    updatedAt: now,
  });

  return { checklistId, items: derived.length };
}

/**
 * Compares the student's own draft against a checklist.
 *
 * The draft is supplied by the student and is never stored: it is their work in
 * progress, and Motion has no reason to keep a copy.
 */
async function handleReviewDraft(
  message: Extract<Message, { type: 'review-draft' }>,
): Promise<{ review: ReturnType<typeof reviewDraft> | null; summary: string }> {
  const db = await openDatabase();
  const checklists = new Repository(db, STORE.checklists, checklistSchema);
  const checklist = await checklists.get(message.checklistId);
  if (!checklist) return { review: null, summary: 'That checklist is no longer available.' };

  const review = reviewDraft(message.draft, checklist.items);
  return { review, summary: summarize(review) };
}

async function handleToggleRequirement(
  message: Extract<Message, { type: 'toggle-requirement' }>,
): Promise<{ updated: boolean }> {
  const db = await openDatabase();
  const checklists = new Repository(db, STORE.checklists, checklistSchema);
  const checklist = await checklists.get(message.checklistId);
  if (!checklist) return { updated: false };

  await checklists.put({
    ...checklist,
    items: checklist.items.map((item) =>
      item.id === message.requirementId ? { ...item, done: message.done } : item,
    ),
    updatedAt: new Date().toISOString(),
  });
  return { updated: true };
}

/**
 * Drafts coursework for the student to read, check and rewrite.
 *
 * The result is stored as a note block with `origin: 'generated'` and its
 * label, so the fact that Motion wrote it travels with the text rather than
 * living in whichever screen happens to be rendering it. Nothing here posts,
 * submits, or fills anything in — the draft lands in the student's workspace
 * and stops.
 */
async function handleComposeDraft(message: Extract<Message, { type: 'compose-draft' }>): Promise<{
  noteId: string | null;
  draft: string;
  label: string;
  unsupported: string[];
  reason?: string;
}> {
  const resolved = await resolveSessionProvider();
  if (resolved.kind === 'blocked') {
    return {
      noteId: null,
      draft: '',
      label: '',
      unsupported: [],
      reason: resolved.blocker.message,
    };
  }

  const db = await openDatabase();
  const checklists = new Repository(db, STORE.checklists, checklistSchema);
  const noteRepo = new Repository(db, STORE.notes, noteSchema);

  const checklist = message.checklistId ? await checklists.get(message.checklistId) : null;
  const courseId = checklist?.courseId ?? (await currentCourseId());
  const allNotes = await noteRepo.all();
  const relevantNotes = allNotes.records.filter((note) => note.courseId === courseId);

  const composed = composeDraftPrompt({
    kind: message.kind,
    title: message.title,
    requirements: checklist?.items ?? [],
    notes: relevantNotes,
    ...(message.existingDraft ? { existingDraft: message.existingDraft } : {}),
    ...(message.studentDirection ? { studentDirection: message.studentDirection } : {}),
    ...(message.targetWords ? { targetWords: message.targetWords } : {}),
  });

  let draft: string;
  try {
    draft = await resolved.provider.generate({
      system: composed.instruction,
      messages: [{ role: 'user', content: buildPrompt(composed) }],
      model: resolved.model,
      ...(composed.targetWords ? { maxOutputTokens: composed.targetWords } : {}),
    });
  } catch (error) {
    return {
      noteId: null,
      draft: '',
      label: '',
      unsupported: [],
      reason: error instanceof Error ? error.message : 'Drafting failed.',
    };
  }

  const now = new Date().toISOString();
  const noteId = crypto.randomUUID();
  await noteRepo.put({
    id: noteId,
    courseId: courseId ?? null,
    taskId: checklist?.taskId ?? null,
    title: `Draft — ${message.title}`.slice(0, 200),
    tags: ['draft'],
    blocks: [
      {
        id: crypto.randomUUID(),
        origin: 'generated',
        text: draft,
        generatedBy: resolved.providerId,
        createdAt: now,
      },
    ],
    createdAt: now,
    updatedAt: now,
  });

  return {
    noteId,
    draft,
    label: GENERATED_LABEL,
    unsupported: unsupportedClaims(draft),
  };
}

async function handleModelStatus(): Promise<{ availability: string; explanation: string }> {
  const resolved = await resolveSessionProvider();
  return resolved.kind === 'ready'
    ? { availability: 'available', explanation: `${resolved.displayName} is ready.` }
    : { availability: resolved.blocker.kind, explanation: resolved.blocker.message };
}

const PREPARE_WORKSPACE = 'prepare-workspace';

export interface AskAboutPageResult {
  answer: string | null;
  reason?: string;
  label?: string;
}

/**
 * The chat about the current page, on Chrome's on-device model.
 *
 * The order of the checks is the point. A graded attempt is refused before
 * anything else happens: the content script is not asked, the model is not
 * asked, and the earlier conversation is not sent anywhere — a restricted page
 * gives the chat nothing. Unreadable pages and a missing model are refused
 * before the page is read, and the page must still be the one that was checked
 * once it has been. Nothing about the conversation is stored, and a model
 * failure is logged without its message, which could quote the prompt.
 */
export async function handleAskAboutPage(
  message: Extract<Message, { type: 'ask-about-page' }>,
  model?: LanguageModelCapability,
): Promise<AskAboutPageResult> {
  const observation = await readObservation(message.tabId);
  if (observation?.restricted) {
    return {
      answer: null,
      reason:
        'Motion does not read or answer questions about a graded attempt. Nothing on this page was read.',
    };
  }
  if (connectionFor(observation) !== 'supported') {
    return {
      answer: null,
      reason: 'Motion can only answer questions about a course page it can read.',
    };
  }
  const resolution = model ? null : await resolveSessionProvider();
  const provider = resolution?.kind === 'ready' ? resolution : null;
  if (model) {
    const availability = await model.availability();
    if (availability !== 'available') return { answer: null, reason: explainAvailability(availability) };
  } else if (resolution?.kind === 'blocked') {
    return { answer: null, reason: resolution.blocker.message };
  }
  const content = await askContentScript(message.tabId);
  if (!content) return { answer: null, reason: 'Motion could not read that page.' };
  if (!sameWorkspacePage(observation, content.url)) {
    return {
      answer: null,
      reason: 'The page changed while Motion was reading it. Ask again once it has loaded.',
    };
  }
  try {
    const prompt = composeChatPrompt({
      pageTitle: content.title,
      pageText: content.text,
      headings: content.headings,
      question: message.question,
      history: message.history,
    });
    const answer = model
      ? await model.generate({ ...prompt, targetWords: 250 })
      : await provider!.provider.generate({
          system: prompt.instruction,
          messages: [{ role: 'user', content: buildPrompt(prompt) }],
          model: provider!.model,
          maxOutputTokens: 250,
        });
    return {
      answer: answer.trim(),
      label: model ? CHAT_LABEL : 'Answered by Motion from this page. Check it against the page before relying on it.',
    };
  } catch {
    console.warn('Motion on-device model generation failed.');
    return { answer: null, reason: 'The on-device model could not answer. Try again.' };
  }
}

function sameWorkspacePage(
  observation: StoredObservation | null | undefined,
  contentUrl: string,
): boolean {
  const observedUrl = observation?.url;
  return observedUrl ? workspacePageUrl(observedUrl) === workspacePageUrl(contentUrl) : false;
}

export interface PrepareWorkspaceResult {
  workflowId: string | null;
  /** True when an existing workspace for this page was returned instead. */
  reused?: boolean;
  /** Plain-language reason Motion declined, for the panel to show. */
  reason?: string;
}

/**
 * "Prepare workspace": the assignment and its readable links, opened in a tab
 * group Motion owns.
 *
 * Refused before anything is read on a page that is restricted, signed out, or
 * not one Motion understands — a graded attempt never reaches the content
 * script from here, let alone yields links to open. Pressing it again for the
 * same page returns the workspace already there rather than a second set of
 * tabs.
 */
export async function handlePrepareWorkspace(
  tabId: number,
  tabs: TabsCapability = new ChromeTabs(),
  sessionId?: string,
): Promise<PrepareWorkspaceResult> {
  const observation = await readObservation(tabId);
  if (observation?.restricted) {
    return { workflowId: null, reason: 'Motion cannot prepare a workspace on a graded attempt.' };
  }
  if (connectionFor(observation) !== 'supported') {
    return {
      workflowId: null,
      reason: 'Motion can only prepare a workspace from a course page it can read.',
    };
  }

  const content = await askContentScript(tabId);
  if (!content) return { workflowId: null, reason: 'Motion could not read that page.' };

  // The observation was checked before the read; the page must still be the
  // one that was checked. A tab can navigate in between, and what it navigated
  // to has not been through the restricted-mode check above.
  if (!sameWorkspacePage(observation, content.url)) {
    return {
      workflowId: null,
      reason: 'The page changed while Motion was reading it. Try again once it has loaded.',
    };
  }

  const adapter = resolveAdapter(content.url);
  const sources = adapter ? selectWorkspaceSources(content, (url) => adapter.classifyUrl(url)) : [];
  const page = sources[0];
  if (!page) {
    return {
      workflowId: null,
      reason: 'Motion can only prepare a workspace from a course page it can read.',
    };
  }

  const sessionKey = await tabs.sessionKey();
  const course = await courseForUrl(content.url);
  const label = content.title || 'Assignment';
  const engine = await createEngine(tabs);

  // Finding an existing workspace and creating a new one must be one step, or
  // two quick presses both find nothing and both open a set of tabs.
  const claimed = await withLock(`motion:${PREPARE_WORKSPACE}:${sessionId ?? 'legacy'}:${page}`, async () => {
    const db = await openDatabase();
    const workflows = (await new IndexedDbWorkflowStore(db).list()).filter(
      (workflow) => workflow.definitionId === PREPARE_WORKSPACE
        && workflow.params['url'] === page
        && workflow.params['sessionId'] === sessionId,
    );

    const inFlight = workflows.find((workflow) => !isTerminal(workflow.status));
    if (inFlight) return { workflowId: inFlight.id, reused: true };

    // A finished workspace still counts while any tab Motion opened for it is
    // still in its group; once the student has closed them all, it is gone.
    for (const workflow of workflows.filter((candidate) => candidate.status === 'completed')) {
      const { groupId, tabIds } = workspaceOwnership(workflow, sessionKey);
      if (groupId !== null && (await tabs.ownedTabsInGroup(groupId, tabIds)).length > 0) {
        return { workflowId: workflow.id, reused: true };
      }
    }

    const created = await engine.create(
      PREPARE_WORKSPACE,
      { url: page, sources, courseCode: course?.code ?? null, label, ...(sessionId ? { sessionId } : {}) },
      { courseId: course?.id ?? null, title: workspaceGroupTitle(course?.code, label) },
    );
    return { workflowId: created.id };
  });

  if (!claimed.reused) await engine.advance(claimed.workflowId);
  return claimed;
}

/**
 * Closing a workspace is a full stop.
 *
 * The workflow is cancelled first, so a step still queued cannot open another
 * tab after the student asked for this. Then only tabs that Motion opened *and*
 * that are still in its group are closed: a tab the student dragged in is
 * theirs, and a Motion tab they dragged out is where they chose to keep it
 * (docs/THREAT_MODEL.md T14).
 */
export async function handleCloseWorkspace(
  workflowId: string,
  tabs: TabsCapability = new ChromeTabs(),
): Promise<{ closed: number; ungrouped: number }> {
  const engine = await createEngine(tabs);
  // `cancel` declines a workflow that already finished — the usual case for a
  // workspace — so fall back to reading it as it stands.
  const workflow =
    (await engine.cancel(workflowId)) ??
    (await new IndexedDbWorkflowStore(await openDatabase()).get(workflowId));
  if (!workflow || workflow.definitionId !== PREPARE_WORKSPACE) return { closed: 0, ungrouped: 0 };

  const sessionKey = await tabs.sessionKey();
  const { groupId, tabIds } = workspaceOwnership(workflow, sessionKey);
  const kept = groupId === null ? [] : await tabs.ownedTabsInGroup(groupId, tabIds);

  // A step stopped mid-way, or a failed attempt, can leave tabs Motion opened
  // but never recorded as the workspace. They were never handed to the student
  // as part of it, so they close with it. Recorded tabs are excluded here: if
  // one is outside the group, the student moved it there.
  const recorded = new Set(tabIds);
  const unrecorded = (await tabs.tabsOpenedBy(`${workflow.id}:`)).filter((id) => !recorded.has(id));

  const closing = [...new Set([...kept, ...unrecorded])];
  await tabs.close(closing);
  const adopted = groupId === null ? [] : await tabs.adoptedTabsInGroup(groupId, workflow.title);
  const ungrouped = adopted.filter((id) => !closing.includes(id));
  await tabs.ungroup(ungrouped);
  return { closed: closing.length, ungrouped: ungrouped.length };
}

/**
 * The one title for a workspace's group. The toolbar icon and Prepare workspace
 * both use it, so the readings join the group the icon started rather than a
 * second one. Both page titles come from `document.title`.
 */
export function workspaceGroupTitle(
  courseCode: string | null | undefined,
  pageTitle: string,
): string {
  return groupTitle([courseCode, pageTitle || 'Assignment']);
}

/**
 * The toolbar icon: put the tab the student is on into Motion's group.
 *
 * The tab is the student's. It is recorded as adopted, never as owned, so
 * closing the workspace ungroups it and cannot close it (docs/THREAT_MODEL.md
 * T14). Anything short of a supported, unrestricted page that has already
 * reported itself — checked on the stored observation *and* on the live URL —
 * is left alone: a graded attempt gets no tab operation, not even grouping. A
 * tab already in a group stays where the student put it.
 *
 * The pending intent is written before the live checks so a worker death after
 * grouping leaves evidence to ungroup. The checks are synchronous and the
 * grouping call follows them without an await, so navigation or a drag cannot
 * slip between authorization and `tabs.group`.
 */
export async function handleActionClick(
  tab: Pick<chrome.tabs.Tab, 'id' | 'url'>,
  tabs: TabsCapability = new ChromeTabs(),
): Promise<{ grouped: boolean }> {
  const tabId = tab.id;
  const declined = { grouped: false };
  if (tabId === undefined) return declined;

  const named = await readObservation(tabId);
  if (connectionFor(named) !== 'supported' || typeof named?.url !== 'string') return declined;
  const namedUrl = named.url;
  const course = await courseForUrl(namedUrl);
  const title = workspaceGroupTitle(course?.code, named.title);
  const live0 = await tabs.get(tabId);
  if (!live0) return declined;
  const plan = {
    title,
    color: 'blue' as const,
    ...(live0.windowId === undefined ? {} : { windowId: live0.windowId }),
  };
  await tabs.findGroup(plan);

  // The intent is first under the lock. Refresh the earlier lookup while
  // holding it: two clicks can otherwise both retain a stale "no group".
  return withLock('motion:workspace-group', async () => {
    await tabs.recordAdopted(tabId, { state: 'pending', title });

    const existing = await tabs.findGroup(plan);
    const live = await tabs.get(tabId);
    const observation = await readObservation(tabId);
    const liveMayAdopt = live !== null && mayAdopt(live, observation);
    const samePage =
      liveMayAdopt &&
      typeof observation?.url === 'string' &&
      workspacePageUrl(observation.url) === workspacePageUrl(namedUrl);
    if (!liveMayAdopt || !samePage) {
      await tabs.forgetAdopted(tabId);
      return declined;
    }

    let groupId: number;
    try {
      groupId = await tabs.groupInto(existing, [tabId], plan);
    } catch (error) {
      await tabs.forgetAdopted(tabId);
      throw error;
    }
    await tabs.recordAdopted(tabId, { state: 'adopted', groupId });
    return { grouped: true };
  });
}

/** Synchronous on purpose: nothing may change between these checks and the grouping. */
function mayAdopt(live: LiveTab, observation: StoredObservation | undefined): boolean {
  if (live.groupId !== null) return false;
  const adapter = resolveAdapter(live.url);
  if (!adapter) return false;
  if (connectionFor(observation) !== 'supported' || !observation?.url) return false;
  if (workspacePageUrl(observation.url) !== workspacePageUrl(live.url)) return false;
  return !evaluateAssessmentContext({
    pageType: adapter.classifyUrl(live.url) ?? 'unsupported',
    url: live.url,
    pageTitle: live.title,
  }).restricted;
}

async function courseForUrl(url: string | null | undefined): Promise<Course | null> {
  const db = await openDatabase();
  const courses = await new Repository(db, STORE.courses, courseSchema).all();
  // No id on the page means no course: a dashboard must never match a stored
  // course that happens to lack an id of its own.
  const externalId = url ? resolveAdapter(url)?.courseIdForUrl(url) : null;
  if (!externalId) return null;
  return courses.records.find((candidate) => candidate.externalId === externalId) ?? null;
}

async function currentCourseId(tabId?: number): Promise<string | null> {
  const activeTabId =
    tabId ?? (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id;
  if (activeTabId === undefined) return null;
  const observation = await readObservation(activeTabId);
  return (await courseForUrl(observation?.url))?.id ?? null;
}

async function requestExtraction(tabId: number | undefined): Promise<{ requested: boolean }> {
  if (tabId === undefined) return { requested: false };
  try {
    // The content script does the reading; the worker never scrapes a page.
    await sendToContentScript(tabId, { type: 'motion:extract' });
    return { requested: true };
  } catch {
    // No content script in the tab: the page loaded before the extension, or it
    // is not a page Motion is injected into. Reporting success here left the
    // panel waiting for a result that was never coming.
    return { requested: false };
  }
}

/**
 * What the panel should show, from what was actually observed.
 *
 * This used to be `observation ? 'supported' : 'idle'`, so an unsupported page
 * rendered the coursework workspace: the panel claimed a page Motion could not
 * read. The page type is the fact that decides it.
 */
function connectionFor(
  observation: StoredObservation | null | undefined,
): PanelState['connection'] {
  if (!observation) return 'idle';
  if (observation.restricted) return 'restricted';
  if (observation.pageType === 'signed-out') return 'signed-out';
  if (observation.pageType === 'unsupported' || observation.pageType === null) return 'unsupported';
  return 'supported';
}

/** The panel is shown the observation, never the internal restricted flag. */
function toPageContext(observation: StoredObservation): PanelState['page'] {
  const { restricted: _restricted, ...page } = observation;
  return page;
}

/** Assembles everything the panel renders. */
export async function buildPanelState(): Promise<PanelState> {
  const db = await openDatabase();
  const courses = new Repository(db, STORE.courses, courseSchema);
  const taskRepo = new Repository(db, STORE.tasks, courseTaskSchema);
  const approvals = new Repository(db, STORE.approvals, approvalRequestSchema);
  const workflowStore = new IndexedDbWorkflowStore(db);

  // The panel describes the tab the student is looking at, not the last tab to
  // report. Anything else lets one tab's workspace stand in front of another's.
  const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const observation = activeTab?.id === undefined ? undefined : await readObservation(activeTab.id);

  const allTasks = await taskRepo.all();
  const allApprovals = await approvals.all();
  const allCourses = await courses.all();

  const pending = allApprovals.records
    .filter((approval) => approval.status === 'pending')
    .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));

  const upcoming = allTasks.records
    .filter((task) => !task.archived)
    .sort((a, b) => {
      // Undated work sinks below dated work rather than sorting as "epoch".
      if (a.due.iso && b.due.iso) return a.due.iso.localeCompare(b.due.iso);
      if (a.due.iso) return -1;
      if (b.due.iso) return 1;
      return a.title.localeCompare(b.title);
    });

  const course = await courseForUrl(observation?.url);

  return {
    ...EMPTY_PANEL_STATE,
    connection: connectionFor(observation),
    page: observation ? toPageContext(observation) : EMPTY_PANEL_STATE.page,
    course,
    tasks: upcoming,
    workflows: await workflowStore.list(),
    approvals: pending,
    corruptedRecords:
      allTasks.corrupted.length + allApprovals.corrupted.length + allCourses.corrupted.length,
  };
}
