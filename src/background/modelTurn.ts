import { ProviderError } from '@/core/ai/types';
import { buildAgentPrompt } from '@/core/agent/prompt';
import { buildStepContext } from '@/core/agent/context';
import { fallbackPlan } from '@/core/agent/fallback';
import { guardToolCall } from '@/core/agent/guard';
import { parseAgentResponse, type AgentPlanStep } from '@/core/agent/plan';
import { buildTrustedRefs, type RefTables, type WorkspaceTab } from '@/core/agent/refs';
import { courseSchema, courseTaskSchema, type CourseTask, noteSchema } from '@/core/domain';
import { type CourseLink } from '@/core/graph';
import { appendActivity, appendMessage, recordBlocker, setPlan, transitionSession, type AgentSession } from '@/core/session';
import { openDatabase } from '@/core/storage/db';
import { Repository } from '@/core/storage/repository';
import { courseLinkRepository, sessionRepository, updateSession } from '@/core/storage/repositories';
import { STORE } from '@/core/storage/schema';
import { type StepPlan } from '@/core/workflows';
import { ChromePreferencesStore } from '@/platform/ai/preferencesStore';
import { ChromeTabs, type TabsCapability } from '@/platform/tabs';
import { supportedHosts } from '@/core/adapters';
import { snapshotResultSchema, type SnapshotResult } from '@/core/actor/contracts';
import { createEngine } from './recovery';
import { providerBlockerFromError, resolveSessionProvider, type ProviderResolution } from './providers';

const STREAMING_KEY = 'motion.streaming';
const SNAPSHOTS_KEY = 'motion.snapshots';
export const MODEL_RETRY_ALARM_PREFIX = 'motion:model-retry:';
const STREAM_WRITE_INTERVAL_MS = 150;
const STREAM_MAX_LENGTH = 40_000;

/** Controllers intentionally only live for an active request in this worker. */
const activeRequests = new Map<string, AbortController>();

export interface ModelTurnDeps {
  resolveProvider?: () => Promise<ProviderResolution>;
  tabs?: TabsCapability;
  now?: () => Date;
  createWorkflowEngine?: typeof createEngine;
}

function timestamp(deps: ModelTurnDeps): string {
  return (deps.now ?? (() => new Date()))().toISOString();
}

async function loadSession(id: string): Promise<AgentSession | null> {
  const db = await openDatabase();
  return sessionRepository(db).get(id);
}

async function saveSession(session: AgentSession): Promise<void> {
  const db = await openDatabase();
  await updateSession(db, session.id, () => session);
}

function blockerId(kind: string): string {
  return `model-${kind}`;
}

async function storeStreaming(sessionId: string, text: string): Promise<void> {
  await chrome.storage.session.set({ [STREAMING_KEY]: { sessionId, text: text.slice(-STREAM_MAX_LENGTH) } });
}

async function clearStreaming(sessionId: string): Promise<void> {
  const current = (await chrome.storage.session.get(STREAMING_KEY))[STREAMING_KEY];
  if (typeof current !== 'object' || current === null || (current as { sessionId?: unknown }).sessionId === sessionId) {
    await chrome.storage.session.remove(STREAMING_KEY);
  }
}

async function refsFor(session: AgentSession, tabs: TabsCapability): Promise<{
  refs: RefTables;
  tasks: CourseTask[];
  links: CourseLink[];
  notes: import('@/core/domain').Note[];
  snapshots: Record<number, SnapshotResult>;
}> {
  const db = await openDatabase();
  const taskRepo = new Repository(db, STORE.tasks, courseTaskSchema);
  const noteRepo = new Repository(db, STORE.notes, noteSchema);
  const tasks = session.courseId ? (await taskRepo.byIndex('byCourse', session.courseId)).records : (await taskRepo.all()).records;
  const links = session.courseId ? (await courseLinkRepository(db).byIndex('byCourse', session.courseId)).records : [];
  const notes = (await noteRepo.all()).records.filter((note) => note.courseId === session.courseId);
  const sessionKey = await tabs.sessionKey();
  const workspaceTabs: WorkspaceTab[] = [];
  if (session.workspace.sessionKey === sessionKey) {
    for (const tabId of [...session.workspace.ownedTabIds, ...session.workspace.adoptedTabIds]) {
      if (session.workspace.releasedTabIds.includes(tabId)) continue;
      const tab = await tabs.get(tabId);
      if (tab) workspaceTabs.push({ tabId, url: tab.url });
    }
  }
  const raw = (await chrome.storage.session.get(SNAPSHOTS_KEY))[SNAPSHOTS_KEY];
  const snapshots: Record<number, SnapshotResult> = {};
  if (typeof raw === 'object' && raw !== null) {
    for (const [tabId, value] of Object.entries(raw)) {
      const parsed = snapshotResultSchema.safeParse(value);
      if (parsed.success) snapshots[Number(tabId)] = parsed.data;
    }
  }
  return { refs: buildTrustedRefs(session, { links, tabs: workspaceTabs, snapshots, tasks, notes }), tasks, links, notes, snapshots };
}

function hydrateStep(step: StepPlan, refs: RefTables): StepPlan {
  const input = { ...step.input };
  const tabId = input['tabId'];
  if (typeof tabId === 'number') {
    const tabRef = refs.refByTabId.get(tabId);
    const snapshot = tabRef ? refs.snapshotByTabRef.get(tabRef) : undefined;
    if (snapshot && input['handle']) input['snapshotId'] = snapshot.snapshotId;
    if (step.action === 'submit-assignment' || step.action === 'post-discussion') {
      input['target'] = String(input['target'] ?? step.title);
      input['effect'] = step.action === 'submit-assignment'
        ? 'This will create a final LMS submission.'
        : 'This will post this discussion response.';
    }
  }
  if ((step.action === 'read-page' || step.action === 'create-checklist') && input['tabId'] === undefined) {
    const first = refs.tabByRef.values().next().value as WorkspaceTab | undefined;
    if (first) input['tabId'] = first.tabId;
  }
  return { ...step, input };
}

async function guardPlan(
  plan: AgentPlanStep[],
  refs: RefTables,
  turnSeq: number,
  activeTaskId: string | null,
): Promise<{ steps: StepPlan[]; rejected: string[] }> {
  const preferences = await new ChromePreferencesStore().get();
  const restricted: Record<string, boolean> = {};
  for (const [ref, tab] of refs.tabByRef) {
    const observation = (await chrome.storage.session.get(`observation:${tab.tabId}`))[`observation:${tab.tabId}`];
    restricted[ref] = typeof observation === 'object' && observation !== null && (observation as { restricted?: unknown }).restricted === true;
  }
  const context = {
    assessmentRestrictedByTabRef: restricted,
    allowedConfigurable: new Set(preferences.allowedConfigurableActions),
    lmsOrigins: supportedHosts.map((host) => `https://${host}`),
    turnSeq,
    activeTaskId,
  };
  const steps: StepPlan[] = [];
  const rejected: string[] = [];
  for (const [index, item] of plan.entries()) {
    const result = guardToolCall(item.call, refs, context, index);
    if (result.kind === 'rejected') {
      rejected.push(`${item.title}: ${result.reason}`);
    } else if (result.decision.decision === 'forbid') {
      rejected.push(`${item.title}: ${result.decision.reason}`);
    } else {
      steps.push({ ...hydrateStep(result.step, refs), title: item.title });
    }
  }
  return { steps, rejected };
}

async function persistPlan(
  session: AgentSession,
  reply: string,
  plan: AgentPlanStep[],
  deps: ModelTurnDeps,
): Promise<AgentSession> {
  const { refs } = await refsFor(session, deps.tabs ?? new ChromeTabs());
  const guarded = await guardPlan(plan, refs, session.conversation.length, session.taskId);
  const now = timestamp(deps);
  let next = setPlan(session, guarded.steps.map((step) => ({ id: step.id, title: step.title, status: 'pending' })), now);
  next = appendMessage(next, { id: crypto.randomUUID(), role: 'motion', text: reply }, now);
  for (const reason of guarded.rejected) {
    next = appendActivity(next, { id: crypto.randomUUID(), kind: 'tool', summary: `Rejected tool request: ${reason}` }, now);
  }
  if (guarded.steps.length > 0) {
    const engine = await (deps.createWorkflowEngine ?? createEngine)(deps.tabs);
    const workflow = await engine.create('agent-turn', {
      sessionId: next.id,
      turnSeq: next.conversation.length,
      steps: guarded.steps,
    }, { courseId: next.courseId, title: next.title });
    next = { ...next, workflowIds: [...new Set([...next.workflowIds, workflow.id])], status: 'working', updatedAt: now };
    await saveSession(next);
    await engine.advance(workflow.id);
    return (await loadSession(next.id)) ?? next;
  }
  next = transitionSession(next, 'waiting', now);
  await saveSession(next);
  return next;
}

async function fallback(session: AgentSession, reason: string, deps: ModelTurnDeps): Promise<AgentSession> {
  const { refs, tasks, links } = await refsFor(session, deps.tabs ?? new ChromeTabs());
  const db = await openDatabase();
  const courses = (await new Repository(db, STORE.courses, courseSchema).all()).records;
  const result = fallbackPlan(session.goal, { tasks, courses, links });
  const normalized = result.plan.map((step) => step.call.tool === 'read_rubric' && step.call.linkRef
    ? { ...step, call: { ...step.call, linkRef: refs.refByLinkId.get(step.call.linkRef) ?? step.call.linkRef } }
    : step);
  return persistPlan(session, `${reason} ${result.reply}`, normalized, deps);
}

/** Runs the deterministic, no-provider plan for an explicit student command. */
export async function runFallbackPlan(
  sessionId: string,
  reason = 'Motion is using its known course context.',
  deps: ModelTurnDeps = {},
): Promise<AgentSession | null> {
  const session = await loadSession(sessionId);
  return session ? fallback(session, reason, deps) : null;
}

/** Runs one model-backed turn, with durable pre-request state and no replay path. */
export async function runModelTurn(sessionId: string, studentText: string, deps: ModelTurnDeps = {}): Promise<AgentSession | null> {
  let session = await loadSession(sessionId);
  if (!session) return null;
  if (session.pendingModelRequest || session.status === 'archived' || session.status === 'completed') {
    const now = timestamp(deps);
    const db = await openDatabase();
    return updateSession(db, sessionId, (current) => current
      ? appendMessage(current, { id: crypto.randomUUID(), role: 'motion', text: 'Motion is still working on your last message.' }, now)
      : null);
  }
  const resolution = await (deps.resolveProvider ?? resolveSessionProvider)();
  if (resolution.kind === 'blocked') {
    const now = timestamp(deps);
    let recorded = false;
    const db = await openDatabase();
    const blocked = await updateSession(db, sessionId, (current) => {
      if (current.pendingModelRequest || current.status === 'archived' || current.status === 'completed') {
        return appendMessage(current, { id: crypto.randomUUID(), role: 'motion', text: 'Motion is still working on your last message.' }, now);
      }
      recorded = true;
      return recordBlocker(current, {
        id: blockerId(resolution.blocker.kind), kind: resolution.blocker.kind,
        message: resolution.blocker.message,
        ...(resolution.blocker.retryAt ? { retryAt: new Date(resolution.blocker.retryAt).toISOString() } : {}),
      }, now);
    });
    if (!blocked || !recorded) return blocked;
    if (resolution.blocker.retryAt) scheduleModelRetry(sessionId, new Date(resolution.blocker.retryAt));
    return fallback(blocked, 'Motion could not use the selected AI provider.', deps);
  }
  const now = timestamp(deps);
  const requestKey = crypto.randomUUID();
  let started = false;
  const db = await openDatabase();
  session = await updateSession(db, sessionId, (current) => {
    if (!current) return null;
    if (current.pendingModelRequest || current.status === 'archived' || current.status === 'completed') {
      return appendMessage(current, { id: crypto.randomUUID(), role: 'motion', text: 'Motion is still working on your last message.' }, now);
    }
    started = true;
    return {
      ...current,
      status: 'working',
      agent: { providerId: resolution.providerId, model: resolution.model },
      pendingModelRequest: { key: requestKey, providerId: resolution.providerId, startedAt: now },
      updatedAt: now,
    };
  });
  if (!session || !started) return session;
  const { refs, notes } = await refsFor(session, deps.tabs ?? new ChromeTabs());
  const prompt = buildAgentPrompt({
    session,
    goalText: studentText,
    refs,
    stepContext: buildStepContext(session, notes),
  });
  const controller = new AbortController();
  activeRequests.set(sessionId, controller);
  let output = '';
  let lastWrite = 0;
  try {
    for await (const delta of resolution.provider.stream({
      system: prompt,
      messages: [{ role: 'user', content: studentText }],
      model: resolution.model,
      json: true,
      signal: controller.signal,
      maxOutputTokens: 2_000,
    })) {
      output = `${output}${delta}`.slice(-STREAM_MAX_LENGTH);
      const nowMs = Date.now();
      if (nowMs - lastWrite >= STREAM_WRITE_INTERVAL_MS) {
        lastWrite = nowMs;
        await storeStreaming(sessionId, output);
      }
    }
    await storeStreaming(sessionId, output);
    session = await loadSession(sessionId);
    if (!session || session.pendingModelRequest?.key !== requestKey) return session;
    const cleared = { ...session, pendingModelRequest: null, updatedAt: timestamp(deps) };
    const parsed = parseAgentResponse(output);
    if (!parsed.ok) {
      const next = appendMessage(cleared, { id: crypto.randomUUID(), role: 'motion', text: 'I received an unusable response from the selected AI provider. Please try again.' }, timestamp(deps));
      await saveSession(next);
      return next;
    }
    return persistPlan(cleared, parsed.response.reply.trim() || 'I prepared the next steps.', parsed.response.plan, deps);
  } catch (error) {
    session = await loadSession(sessionId);
    if (!session || session.pendingModelRequest?.key !== requestKey) return session;
    const nowError = timestamp(deps);
    if (error instanceof ProviderError && error.kind === 'cancelled') {
      const next = appendMessage({ ...session, pendingModelRequest: null }, { id: crypto.randomUUID(), role: 'motion', text: 'Generation stopped.' }, nowError);
      await saveSession(next);
      return next;
    }
    const blocker = providerBlockerFromError(error, resolution.displayName);
    const next = recordBlocker({ ...session, pendingModelRequest: null }, {
      id: blockerId(blocker.kind), kind: blocker.kind, message: blocker.message,
      ...(blocker.retryAt ? { retryAt: new Date(blocker.retryAt).toISOString() } : {}),
    }, nowError);
    await saveSession(next);
    if (blocker.retryAt) scheduleModelRetry(sessionId, new Date(blocker.retryAt));
    return next;
  } finally {
    activeRequests.delete(sessionId);
    await clearStreaming(sessionId);
  }
}

export async function stopGeneration(sessionId: string): Promise<void> {
  activeRequests.get(sessionId)?.abort();
  await clearStreaming(sessionId);
}

export function scheduleModelRetry(sessionId: string, at: Date): void {
  void chrome.alarms.create(`${MODEL_RETRY_ALARM_PREFIX}${sessionId}`, { when: Math.max(at.getTime(), Date.now() + 60_000) });
}

/** Marks abandoned paid requests as retryable; it never calls a provider. */
export async function recoverStaleModelRequests(now = Date.now()): Promise<void> {
  const db = await openDatabase();
  const repo = sessionRepository(db);
  const all = await repo.all();
  for (const session of all.records) {
    const pending = session.pendingModelRequest;
    if (!pending || now - Date.parse(pending.startedAt) <= 120_000) continue;
    const at = new Date(now).toISOString();
    await updateSession(db, session.id, (current) => {
      const active = current.pendingModelRequest;
      if (!active || active.key !== pending.key) return null;
      return recordBlocker({ ...current, pendingModelRequest: null }, {
        id: blockerId('interrupted'), kind: 'provider',
        message: `Motion was interrupted while waiting for ${active.providerId}. Retry?`,
      }, at);
    });
  }
}
