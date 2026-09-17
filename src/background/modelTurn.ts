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
  try {
    return await sessionRepository(db).get(id);
  } finally {
    db.close();
  }
}

/**
 * Complete one claimed turn without writing a stale whole session row.  Error
 * paths are just as concurrent as the happy path: a source exclusion or a
 * later turn must not either lose its own change or leave this request's lock
 * behind because the old revision no longer matches.
 */
async function finishClaimedTurn(
  sessionId: string,
  requestKey: string,
  generation: number,
  message: string,
  now: string,
  blocker?: { id: string; kind: import('@/core/session').SessionBlocker['kind']; message: string; retryAt?: string },
): Promise<AgentSession | null> {
  const db = await openDatabase();
  try {
    return await updateSession(db, sessionId, (current) => {
      const pending = current.pendingModelRequest;
      if (!pending || pending.key !== requestKey || pending.generation !== generation || current.modelTurnGeneration !== generation)
        return null;
      let next = appendMessage({ ...current, pendingModelRequest: null }, {
        id: crypto.randomUUID(), role: 'motion', text: message,
      }, now);
      if (blocker) {
        next = recordBlocker(next, blocker, now);
      } else if (next.status === 'working') {
        next = transitionSession(next, 'waiting', now);
      }
      return next;
    });
  } finally {
    db.close();
  }
}

function blockerId(kind: string): string {
  return `model-${kind}`;
}

function appendStudentTurn(session: AgentSession, text: string, now: string, reuseLastStudentTurn: boolean): AgentSession {
  // Only Retry is allowed to reuse a turn. Two ordinary identical messages
  // are still two intentional student turns and must remain in history.
  const lastStudent = [...session.conversation].reverse().find((entry) => entry.role === 'student');
  return reuseLastStudentTurn && lastStudent?.text === text
    ? session
    : appendMessage(session, { id: crypto.randomUUID(), role: 'student', text }, now);
}

interface ModelReplyResult {
  reply: string;
  activities: (Omit<import('@/core/session').ActivityEntry, 'at'> & { at?: string })[];
  /** `null` means no plan this turn (the fallback/no-steps path): transition to `waiting` instead. */
  planSteps: { id: string; title: string; status: 'pending' }[] | null;
  requestKey: string | null;
  generation: number;
}

/**
 * SOL-2: applies only the fields this model turn owns, re-read against the
 * latest committed session rather than a whole-row CAS against a stale
 * snapshot. A concurrent mutation (a source excluded mid-turn, a pause, a
 * blocker recorded by another path) must never cost the student their reply.
 *
 * The plan (and the transition to `waiting` when there is no plan) is only
 * applied when the session is still in the same turn generation and not
 * paused/archived/completed — those are exactly the conditions under which a
 * plan this turn produced is still this session's business. The reply and
 * this turn's own `pendingModelRequest` are applied unconditionally: a
 * received reply is never discarded, and this turn only ever clears its own
 * claim, never a newer one's.
 */
async function applyModelTurnResult(
  sessionId: string,
  result: ModelReplyResult,
  now: string,
): Promise<{ session: AgentSession; planApplied: boolean } | null> {
  const db = await openDatabase();
  let planApplied = false;
  try {
    const session = await updateSession(db, sessionId, (current) => {
      let next = appendMessage(current, { id: crypto.randomUUID(), role: 'motion', text: result.reply }, now);
      for (const activity of result.activities) next = appendActivity(next, activity, now);
      const stillOwnsTurn = current.modelTurnGeneration === result.generation
        && current.status !== 'paused' && current.status !== 'archived' && current.status !== 'completed';
      if (stillOwnsTurn) {
        next = result.planSteps
          ? setPlan(next, result.planSteps, now)
          : transitionSession(next, 'waiting', now);
        planApplied = true;
      }
      // A plan has a second durable effect: creating its workflow. Keep this
      // claim until that workflow is attached, otherwise a new turn can claim
      // the session in the gap and a delayed workflow projection can replace
      // the newer plan. No-plan replies have no second effect and clear here.
      if (result.requestKey && (result.planSteps === null || !stillOwnsTurn) && next.pendingModelRequest?.key === result.requestKey) {
        next = { ...next, pendingModelRequest: null };
      }
      return next;
    });
    return session ? { session, planApplied } : null;
  } finally {
    db.close();
  }
}

async function storeStreaming(sessionId: string, requestKey: string, text: string): Promise<void> {
  await chrome.storage.session.set({ [STREAMING_KEY]: { sessionId, requestKey, text: text.slice(-STREAM_MAX_LENGTH) } });
}

async function clearStreaming(sessionId: string, requestKey?: string): Promise<void> {
  const current = (await chrome.storage.session.get(STREAMING_KEY))[STREAMING_KEY];
  if (
    typeof current !== 'object' || current === null ||
    ((current as { sessionId?: unknown }).sessionId === sessionId &&
      (requestKey === undefined || (current as { requestKey?: unknown }).requestKey === requestKey))
  ) {
    await chrome.storage.session.remove(STREAMING_KEY);
  }
}

const HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * N5: keeps `pendingModelRequest.heartbeatAt` fresh while a request is
 * genuinely alive, so recovery can tell a slow-but-live request (still
 * streaming) from one that has actually been abandoned. Only refreshes this
 * turn's own claim — never a newer turn's, and never a claim this worker no
 * longer holds.
 */
async function refreshHeartbeat(sessionId: string, requestKey: string, at: string): Promise<void> {
  const db = await openDatabase();
  try {
    await updateSession(db, sessionId, (current) =>
      current.pendingModelRequest?.key === requestKey
        ? { ...current, pendingModelRequest: { ...current.pendingModelRequest, heartbeatAt: at } }
        : null,
    );
  } finally {
    db.close();
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
  try {
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
  } finally {
    db.close();
  }
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
  const activities = guarded.rejected.map((reason) => ({
    id: crypto.randomUUID(),
    kind: 'tool' as const,
    summary: `Rejected tool request: ${reason}`,
  }));
  const planSteps = guarded.steps.length > 0
    ? guarded.steps.map((step) => ({ id: step.id, title: step.title, status: 'pending' as const }))
    : null;

  const applied = await applyModelTurnResult(session.id, {
    reply,
    activities,
    planSteps,
    requestKey: session.pendingModelRequest?.key ?? null,
    generation: session.modelTurnGeneration,
  }, now);
  if (!applied) return (await loadSession(session.id)) ?? session;
  if (guarded.steps.length === 0 || !applied.planApplied) return applied.session;

  // SOL-4: the workflow (and the `onChange` projection it triggers on
  // creation) is only created after the plan CAS above has actually landed
  // and confirmed the session is still in this turn generation and not
  // paused/archived/completed. Creating it earlier let a workflow the
  // student had already paused/cancelled out from under itself force the
  // session back to `active` via `engine.create`'s own projection.
  const engine = await (deps.createWorkflowEngine ?? createEngine)(deps.tabs);
  const workflow = await engine.create('agent-turn', {
    sessionId: applied.session.id,
    turnSeq: applied.session.conversation.length,
    modelTurnGeneration: session.modelTurnGeneration,
    steps: guarded.steps,
  }, { courseId: applied.session.courseId, title: applied.session.title });

  const db = await openDatabase();
  let attached: AgentSession | null;
  try {
    attached = await updateSession(db, applied.session.id, (current) => {
      const expectedRequestKey = session.pendingModelRequest?.key;
      if (
        (expectedRequestKey !== undefined && (
          current.pendingModelRequest?.key !== expectedRequestKey
          || current.pendingModelRequest?.generation !== session.modelTurnGeneration
        ))
        || current.modelTurnGeneration !== session.modelTurnGeneration
        || current.status === 'paused' || current.status === 'archived' || current.status === 'completed'
      ) {
        return null;
      }
      return {
        ...current,
        workflowIds: [...new Set([...current.workflowIds, workflow.id])],
        pendingModelRequest: null,
        status: 'working',
        updatedAt: now,
      };
    });
  } finally {
    db.close();
  }
  if (!attached) {
    await engine.cancel(workflow.id);
    return (await loadSession(session.id)) ?? applied.session;
  }
  await engine.advance(workflow.id);
  return (await loadSession(attached.id)) ?? attached;
}

async function fallback(session: AgentSession, reason: string, deps: ModelTurnDeps): Promise<AgentSession> {
  const { refs, tasks, links } = await refsFor(session, deps.tabs ?? new ChromeTabs());
  const db = await openDatabase();
  try {
    const courses = (await new Repository(db, STORE.courses, courseSchema).all()).records;
    const result = fallbackPlan(session.goal, { tasks, courses, links });
    const normalized = result.plan.map((step) => step.call.tool === 'read_rubric' && step.call.linkRef
      ? { ...step, call: { ...step.call, linkRef: refs.refByLinkId.get(step.call.linkRef) ?? step.call.linkRef } }
      : step);
    return persistPlan(session, `${reason} ${result.reply}`, normalized, deps);
  } finally {
    db.close();
  }
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
export async function runModelTurn(
  sessionId: string,
  studentText: string,
  deps: ModelTurnDeps = {},
  reuseLastStudentTurn = false,
): Promise<AgentSession | null> {
  let session = await loadSession(sessionId);
  if (!session) return null;
  if (session.pendingModelRequest || session.status === 'archived' || session.status === 'completed' || session.status === 'paused') {
    const now = timestamp(deps);
    const db = await openDatabase();
    try {
      return await updateSession(db, sessionId, (current) => current
        ? appendMessage(current, { id: crypto.randomUUID(), role: 'motion', text: 'Motion is still working on your last message.' }, now)
        : null);
    } finally {
      db.close();
    }
  }
  const resolution = await (deps.resolveProvider ?? resolveSessionProvider)();
  if (resolution.kind === 'blocked') {
    const now = timestamp(deps);
    let recorded = false;
    const db = await openDatabase();
    let blocked: AgentSession | null;
    try {
      blocked = await updateSession(db, sessionId, (current) => {
        if (current.pendingModelRequest || current.status === 'archived' || current.status === 'completed' || current.status === 'paused') {
          return appendMessage(current, { id: crypto.randomUUID(), role: 'motion', text: 'Motion is still working on your last message.' }, now);
        }
        recorded = true;
        const withStudentTurn = appendStudentTurn(current, studentText, now, reuseLastStudentTurn);
        return recordBlocker(withStudentTurn, {
          id: blockerId(resolution.blocker.kind), kind: resolution.blocker.kind,
          message: resolution.blocker.message,
          ...(resolution.blocker.retryAt ? { retryAt: new Date(resolution.blocker.retryAt).toISOString() } : {}),
        }, now);
      });
    } finally {
      db.close();
    }
    if (!blocked || !recorded) return blocked;
    if (resolution.blocker.retryAt) scheduleModelRetry(sessionId, new Date(resolution.blocker.retryAt));
    return fallback(blocked, 'Motion could not use the selected AI provider.', deps);
  }
  const now = timestamp(deps);
  const requestKey = crypto.randomUUID();
  let started = false;
  const db = await openDatabase();
  try {
    session = await updateSession(db, sessionId, (current) => {
      if (!current) return null;
      if (current.pendingModelRequest || current.status === 'archived' || current.status === 'completed' || current.status === 'paused') {
        return appendMessage(current, { id: crypto.randomUUID(), role: 'motion', text: 'Motion is still working on your last message.' }, now);
      }
      started = true;
      const generation = current.modelTurnGeneration + 1;
      const withStudentTurn = appendStudentTurn(current, studentText, now, reuseLastStudentTurn);
      return {
        ...withStudentTurn,
        status: 'working',
        agent: { providerId: resolution.providerId, model: resolution.model },
        modelTurnGeneration: generation,
        pendingModelRequest: { key: requestKey, providerId: resolution.providerId, startedAt: now, generation, heartbeatAt: now },
        updatedAt: now,
      };
    });
  } finally {
    db.close();
  }
  if (!session || !started) return session;
  // SOL-3: registered synchronously, in the same tick as the claim above,
  // before any `await` for refs/prompt-building runs. A Stop that lands in
  // that window must abort before the provider is ever called — not merely
  // before the stream is awaited — so no chargeable request goes out after
  // the student pressed Stop.
  const controller = new AbortController();
  activeRequests.set(sessionId, controller);
  // A worker that dies while streaming or backing off never runs the
  // in-memory catch block below, and nothing else wakes a suspended worker
  // to notice — until this alarm fires. Schedule it the moment the request
  // is claimed, not only when a provider-reported blocker gives a retryAt.
  scheduleModelRecovery(sessionId);
  let output = '';
  let lastWrite = 0;
  let lastHeartbeat = 0;
  try {
    // Setup does I/O too. Keep it inside the ownership/finally envelope so a
    // failed tab lookup or prompt build cannot strand a durable claim and its
    // in-memory abort controller forever.
    const { refs, notes } = await refsFor(session, deps.tabs ?? new ChromeTabs());
    const prompt = buildAgentPrompt({
      session,
      goalText: studentText,
      refs,
      stepContext: buildStepContext(session, notes),
    });
    // `updateSession()` resolves asynchronously. Stop can commit after its
    // claim transaction commits but before this worker receives the result
    // and installs the controller. Re-read at the final async boundary; once
    // this await resolves, opening the stream below is synchronous, so no
    // Stop can slip a paid request between this check and `provider.stream`.
    const beforeStream = await loadSession(sessionId);
    if (
      !beforeStream || beforeStream.pendingModelRequest?.key !== requestKey ||
      beforeStream.pendingModelRequest.generation !== beforeStream.modelTurnGeneration
    ) {
      controller.abort();
      return beforeStream;
    }
    if (controller.signal.aborted) {
      // Stop already fired between the claim and here. Never call the
      // provider: raise the same cancellation path the mid-stream abort
      // uses, so this is indistinguishable from any other stopped turn.
      throw new ProviderError('cancelled', 'Generation stopped.');
    }
    const messages = session.conversation.slice(-12).map((entry) => ({
      role: entry.role === 'student' ? 'user' as const : 'assistant' as const,
      content: entry.text.slice(0, 4_000),
    }));
    for await (const delta of resolution.provider.stream({
      system: prompt,
      messages,
      model: resolution.model,
      json: true,
      signal: controller.signal,
      maxOutputTokens: 2_000,
    })) {
      output = `${output}${delta}`.slice(-STREAM_MAX_LENGTH);
      const nowMs = Date.now();
      if (nowMs - lastWrite >= STREAM_WRITE_INTERVAL_MS) {
        lastWrite = nowMs;
        await storeStreaming(sessionId, requestKey, output);
      }
      if (nowMs - lastHeartbeat >= HEARTBEAT_INTERVAL_MS) {
        lastHeartbeat = nowMs;
        await refreshHeartbeat(sessionId, requestKey, new Date(nowMs).toISOString());
      }
    }
    await storeStreaming(sessionId, requestKey, output);
    session = await loadSession(sessionId);
    if (!session || session.pendingModelRequest?.key !== requestKey || session.pendingModelRequest.generation !== session.modelTurnGeneration) return session;
    const parsed = parseAgentResponse(output);
    if (!parsed.ok) {
      return (await finishClaimedTurn(
        sessionId, requestKey, session.modelTurnGeneration,
        'I received an unusable response from the selected AI provider. Please try again.', timestamp(deps),
      )) ?? (await loadSession(sessionId));
    }
    // `session` (not a pre-cleared copy) is passed on so `persistPlan` can
    // read this turn's own `pendingModelRequest.key` and clear exactly that
    // claim through its own CAS-safe merge (SOL-2) — clearing it here first
    // would erase the key persistPlan needs to safely clear it later.
    // Keep guard/workflow creation inside this request's catch/finally. A bare
    // returned promise would bypass the failure path, leaving the durable
    // claim behind after an engine or guard error.
    return await persistPlan(session, parsed.response.reply.trim() || 'I prepared the next steps.', parsed.response.plan, deps);
  } catch (error) {
    session = await loadSession(sessionId);
    if (!session || session.pendingModelRequest?.key !== requestKey || session.pendingModelRequest.generation !== session.modelTurnGeneration) return session;
    const nowError = timestamp(deps);
    if (error instanceof ProviderError && error.kind === 'cancelled') {
      return (await finishClaimedTurn(
        sessionId, requestKey, session.modelTurnGeneration, 'Generation stopped.', nowError,
      )) ?? (await loadSession(sessionId));
    }
    const blocker = providerBlockerFromError(error, resolution.displayName);
    const next = await finishClaimedTurn(sessionId, requestKey, session.modelTurnGeneration, blocker.message, nowError, {
      id: blockerId(blocker.kind), kind: blocker.kind, message: blocker.message,
      ...(blocker.retryAt ? { retryAt: new Date(blocker.retryAt).toISOString() } : {}),
    });
    if (next && blocker.retryAt) scheduleModelRetry(sessionId, new Date(blocker.retryAt));
    return next ?? (await loadSession(sessionId));
  } finally {
    // SOL-3: only remove the controller this turn created. An old turn that
    // is still unwinding (e.g. a stale stream finally resolving after a
    // newer turn already started) must never clear the newer turn's
    // controller out from under it — that would silently strand the newer
    // request without any way to abort it.
    if (activeRequests.get(sessionId) === controller) activeRequests.delete(sessionId);
    await clearStreaming(sessionId, requestKey);
  }
}

export async function stopGeneration(sessionId: string): Promise<void> {
  activeRequests.get(sessionId)?.abort();
  const db = await openDatabase();
  try {
    await updateSession(db, sessionId, (current) => current.pendingModelRequest
      ? {
          ...current,
          pendingModelRequest: null,
          modelTurnGeneration: current.modelTurnGeneration + 1,
          status: current.status === 'working' ? 'waiting' : current.status,
          updatedAt: new Date().toISOString(),
        }
      : null);
  } finally {
    db.close();
  }
  await clearStreaming(sessionId);
}

export function scheduleModelRetry(sessionId: string, at: Date): void {
  void chrome.alarms.create(`${MODEL_RETRY_ALARM_PREFIX}${sessionId}`, { when: Math.max(at.getTime(), Date.now() + 60_000) });
}

export const MODEL_RECOVERY_ALARM_PREFIX = 'motion:model-recovery:';
/** Matches the staleness window `recoverStaleModelRequests` uses below. */
const MODEL_RECOVERY_DELAY_MS = 125_000;

/**
 * SOL-19 (interim): a claimed request has no other durable timer until a
 * provider blocker sets one via `scheduleModelRetry`. If the worker dies
 * mid-stream, or dies during a provider's own retry backoff before it ever
 * records a blocker, the session would otherwise stay `working` forever —
 * nothing wakes a suspended worker to run `recoverStaleModelRequests`. This
 * alarm guarantees a wake-up shortly after the staleness threshold; the
 * recovery pass itself is a no-op if the request already completed.
 */
export function scheduleModelRecovery(sessionId: string): void {
  void chrome.alarms.create(`${MODEL_RECOVERY_ALARM_PREFIX}${sessionId}`, {
    when: Date.now() + MODEL_RECOVERY_DELAY_MS,
  });
}

/**
 * N5: a live request (still streaming, or still in a provider retry wait)
 * refreshes its own heartbeat; this is the freshness window recovery treats
 * as "still genuinely alive" even though `startedAt` may be well past the
 * overall staleness threshold.
 */
const HEARTBEAT_STALE_MS = 90_000;

/**
 * Marks abandoned paid requests as retryable; it never calls a provider.
 *
 * N5: a request this worker still holds a live controller for, or whose
 * heartbeat is still fresh, is never declared interrupted — doing so would
 * discard the eventual (paid) reply and invite a second, concurrent request
 * that the first controller can no longer be used to stop. Such a request is
 * instead left alone and its recovery alarm is re-armed, so a later pass
 * checks again rather than this one guessing.
 */
export async function recoverStaleModelRequests(now = Date.now()): Promise<void> {
  const db = await openDatabase();
  try {
    const repo = sessionRepository(db);
    const all = await repo.all();
    for (const session of all.records) {
    const pending = session.pendingModelRequest;
    if (!pending) continue;
    const heartbeatMs = Date.parse(pending.heartbeatAt ?? pending.startedAt);
    const isFresh = now - heartbeatMs <= HEARTBEAT_STALE_MS;
    if (activeRequests.has(session.id) || isFresh) {
      scheduleModelRecovery(session.id);
      continue;
    }
    const at = new Date(now).toISOString();
      const recovered = await updateSession(db, session.id, (current) => {
        const active = current.pendingModelRequest;
        if (!active || active.key !== pending.key) return null;
        let next = recordBlocker({ ...current, pendingModelRequest: null }, {
          id: blockerId('interrupted'), kind: 'provider',
          message: `Motion was interrupted while waiting for ${active.providerId}. Retry?`,
        }, at);
        if (next.status === 'working') next = transitionSession(next, 'waiting', at);
        return next;
      });
      if (recovered) await clearStreaming(session.id, pending.key);
    }
  } finally {
    db.close();
  }
}
