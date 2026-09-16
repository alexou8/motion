import type { Message } from '@/core/messaging';
import { courseSchema, courseTaskSchema, type PageType } from '@/core/domain';
import { appendMessage, excludeSource, restartFromStep, resolveTaskForGoal, sessionTitle, transitionSession, type AgentSession } from '@/core/session';
import { detectIntent } from '@/core/agent/intents';
import { openDatabase } from '@/core/storage/db';
import { Repository } from '@/core/storage/repository';
import { sessionRepository, updateSession } from '@/core/storage/repositories';
import { STORE } from '@/core/storage/schema';
import { ChromeTabs } from '@/platform/tabs';
import { ChromePreferencesStore } from '@/platform/ai/preferencesStore';
import { createEngine } from './recovery';
import { closeSessionWorkspace } from './workspaceEvents';
import { recoverStaleModelRequests, runFallbackPlan, runModelTurn, stopGeneration } from './modelTurn';

const ACTIVE_SESSION_KEY = 'motion.activeSessionId';

type SessionMessage = Extract<Message, { type: 'session-create' | 'session-message' | 'session-command' | 'session-select' | 'session-source' | 'session-tab' }>;

async function getSession(id: string): Promise<AgentSession | null> {
  const db = await openDatabase();
  try {
    return await sessionRepository(db).get(id);
  } finally {
    db.close();
  }
}

async function updateExistingSession(
  id: string,
  mutator: (session: AgentSession) => AgentSession | null,
): Promise<AgentSession | null> {
  const db = await openDatabase();
  try {
    return await updateSession(db, id, mutator);
  } finally {
    db.close();
  }
}

export type SessionRefusal = {
  kind: 'terminal-session';
  status: 'completed' | 'archived';
  message: string;
};

function terminalRefusal(session: AgentSession): SessionRefusal | null {
  if (session.status !== 'completed' && session.status !== 'archived') return null;
  return {
    kind: 'terminal-session',
    status: session.status,
    message: session.status === 'archived'
      ? 'This session is archived and cannot be resumed or changed.'
      : 'This session is completed and cannot be resumed or changed.',
  };
}

async function activeTabId(tabId: number | null): Promise<number | null> {
  if (tabId !== null) return tabId;
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab?.id ?? null;
}

export function sessionCreateBehavior(
  pageType: PageType | undefined,
  autoOpenRelatedTabs: boolean,
): 'open-related' | 'suggest-related' | 'model-turn' {
  if (pageType !== 'assignment') return 'model-turn';
  return autoOpenRelatedTabs ? 'open-related' : 'suggest-related';
}

async function createSession(message: Extract<SessionMessage, { type: 'session-create' }>) {
  const tabId = await activeTabId(message.tabId);
  const observation = tabId === null ? null : (await chrome.storage.session.get(`observation:${tabId}`))[`observation:${tabId}`] as { url?: unknown; pageType?: unknown } | undefined;
  const db = await openDatabase();
  const courses = await new Repository(db, STORE.courses, courseSchema).all();
  const tasks = await new Repository(db, STORE.tasks, courseTaskSchema).all();
  const url = typeof observation?.url === 'string' ? observation.url : null;
  const course = url ? courses.records.find((item) => item.externalId && url.includes(`ou=${item.externalId}`)) ?? null : null;
  const matching = course ? tasks.records.filter((task) => task.courseId === course.id) : tasks.records;
  const resolved = resolveTaskForGoal(message.goal, matching, course ? [course] : courses.records);
  const task = resolved.task;
  const now = new Date().toISOString();
  const session: AgentSession = {
    id: crypto.randomUUID(), revision: 0, title: sessionTitle(course?.code, task?.title ?? message.goal), goal: message.goal,
    courseId: task?.courseId ?? course?.id ?? null, taskId: task?.id ?? null, status: 'active', createdAt: now, updatedAt: now,
    workspace: { groupId: null, groupTitle: `Motion · ${sessionTitle(course?.code, task?.title ?? message.goal)}`, sessionKey: null, ownedTabIds: [], adoptedTabIds: [], releasedTabIds: [] },
    plan: { steps: [], currentStepId: null }, blockers: [], context: { sources: [] }, artifacts: [], agent: { providerId: null, model: null },
    conversation: [{ id: crypto.randomUUID(), role: 'student', text: message.goal, at: now }], activity: [], workflowIds: [], pendingModelRequest: null,
  };
  await sessionRepository(db).put(session);
  db.close();
  await chrome.storage.session.set({ [ACTIVE_SESSION_KEY]: session.id });
  const behavior = sessionCreateBehavior(
    typeof observation?.pageType === 'string' ? observation.pageType as PageType : undefined,
    (await new ChromePreferencesStore().get()).autoOpenRelatedTabs,
  );
  if (behavior === 'open-related')
    return (await runFallbackPlan(session.id, 'Motion is opening the related assignment resources.')) ?? session;
  if (behavior === 'suggest-related') {
    return (await updateExistingSession(session.id, (current) => appendMessage(
      current,
      { id: crypto.randomUUID(), role: 'motion', text: 'I can open the related instructions, rubric, and readings when you ask.' },
      now,
    ))) ?? session;
  }
  return (await runModelTurn(session.id, message.goal)) ?? session;
}

async function applyIntent(session: AgentSession, text: string): Promise<AgentSession> {
  const intent = detectIntent(text);
  if (!intent) return (await runModelTurn(session.id, text)) ?? session;
  const now = new Date().toISOString();
  if (intent.type === 'open-everything') {
    const next = await updateExistingSession(session.id, (current) =>
      appendMessage(current, { id: crypto.randomUUID(), role: 'student', text }, now),
    );
    if (!next) return (await getSession(session.id)) ?? session;
    return (await runFallbackPlan(session.id, 'Motion is opening the resources it already knows about.')) ?? next;
  }
  const engine = await createEngine();
  const current = await getSession(session.id);
  if (!current || terminalRefusal(current)) return current ?? session;
  if (intent.type === 'pause' || intent.type === 'stop') {
    for (const id of current.workflowIds) await (intent.type === 'pause' ? engine.pause(id) : engine.cancel(id));
  }
  if (intent.type === 'resume') {
    for (const id of current.workflowIds) await engine.resume(id);
  }
  return (await updateExistingSession(session.id, (latest) => {
    if (terminalRefusal(latest)) return null;
    let next = appendMessage(latest, { id: crypto.randomUUID(), role: 'student', text }, now);
    if (intent.type === 'pause' || intent.type === 'stop') {
      next = transitionSession(next, 'paused', now);
      return appendMessage(next, { id: crypto.randomUUID(), role: 'motion', text: intent.type === 'pause' ? 'Paused. Say “resume” when you are ready.' : 'Stopped the current work.' }, now);
    }
    if (intent.type === 'resume') {
      next = transitionSession(next, 'working', now);
      return appendMessage(next, { id: crypto.randomUUID(), role: 'motion', text: 'Resumed.' }, now);
    }
    if (intent.type === 'why') {
      const step = next.plan.steps.find((item) => item.id === next.plan.currentStepId);
      return appendMessage(next, { id: crypto.randomUUID(), role: 'motion', text: step ? `The current step is “${step.title}” because it supports your stated goal.` : 'There is no active step yet.' }, now);
    }
    if (intent.type === 'exclude-source') {
      const source = next.context.sources.find((item) => item.url.includes(intent.hint ?? '') || item.title.toLowerCase().includes((intent.hint ?? '').toLowerCase()));
      next = source ? excludeSource(next, source.url, now) : next;
      return appendMessage(next, { id: crypto.randomUUID(), role: 'motion', text: source ? `I will not use “${source.title || source.url}”.` : 'Tell me which source you want to exclude.' }, now);
    }
    if (intent.type === 'restart') {
      const step = next.plan.steps.find((item) => item.title.toLowerCase().includes((intent.hint ?? '').toLowerCase())) ?? next.plan.steps[0];
      if (step) next = restartFromStep(next, step.id, now);
      return appendMessage(next, { id: crypto.randomUUID(), role: 'motion', text: step ? `Restarted from “${step.title}”.` : 'There is no plan step to restart.' }, now);
    }
    return appendMessage(next, { id: crypto.randomUUID(), role: 'motion', text: `I’ll show the ${intent.range === 'all' ? 'known' : intent.range} deadlines in the deadline view.` }, now);
  })) ?? (await getSession(session.id)) ?? session;
}

export async function handleSessionMessage(message: SessionMessage): Promise<unknown> {
  switch (message.type) {
    case 'session-create': return { session: await createSession(message) };
    case 'session-select':
      if (message.sessionId) {
        const session = await getSession(message.sessionId);
        const refusal = session ? terminalRefusal(session) : null;
        if (session && refusal) return { selected: null, session, refusal };
      }
      await chrome.storage.session.set({ [ACTIVE_SESSION_KEY]: message.sessionId });
      return { selected: message.sessionId };
    case 'session-message': {
      const session = await getSession(message.sessionId);
      if (!session) return { session: null };
      const refusal = terminalRefusal(session);
      return refusal ? { session, refusal } : { session: await applyIntent(session, message.text) };
    }
    case 'session-source': {
      const session = await getSession(message.sessionId);
      if (!session) return { updated: false };
      const now = new Date().toISOString();
      const refusal = terminalRefusal(session);
      if (refusal) return { updated: false, session, refusal };
      const next = await updateExistingSession(session.id, (current) => terminalRefusal(current)
        ? null
        : { ...current, context: { ...current.context, sources: current.context.sources.map((source) => source.url === message.url ? { ...source, excluded: message.excluded } : source) }, updatedAt: now });
      return { updated: next !== null, session: next };
    }
    case 'session-tab': {
      const session = await getSession(message.sessionId);
      if (!session) return { updated: false };
      const refusal = terminalRefusal(session);
      if (refusal) return { updated: false, session, refusal };
      const now = new Date().toISOString();
      const next = await updateExistingSession(session.id, (current) => {
        if (terminalRefusal(current)) return null;
        const owned = current.workspace.ownedTabIds.filter((id) => id !== message.tabId);
        const adopted = message.op === 'adopt' ? [...new Set([...current.workspace.adoptedTabIds, message.tabId])] : current.workspace.adoptedTabIds.filter((id) => id !== message.tabId);
        return { ...current, workspace: { ...current.workspace, ownedTabIds: owned, adoptedTabIds: adopted, releasedTabIds: message.op === 'release' ? [...new Set([...current.workspace.releasedTabIds, message.tabId])] : current.workspace.releasedTabIds }, updatedAt: now };
      });
      return { updated: next !== null, session: next };
    }
    case 'session-command': {
      const session = await getSession(message.sessionId);
      if (!session) return { updated: false };
      const refusal = terminalRefusal(session);
      if (refusal) return { session, refusal };
      if (message.command === 'stop-generation') { await stopGeneration(session.id); return { stopped: true }; }
      if (message.command === 'retry-model') return { session: await runModelTurn(session.id, session.goal) };
      const engine = await createEngine();
      for (const id of session.workflowIds) await (message.command === 'pause' ? engine.pause(id) : message.command === 'resume' ? engine.resume(id) : engine.cancel(id));
      if (message.command === 'archive') await closeSessionWorkspace(session, new ChromeTabs());
      const status = message.command === 'pause' ? 'paused' : message.command === 'archive' ? 'archived' : 'active';
      const next = await updateExistingSession(session.id, (current) => terminalRefusal(current)
        ? null
        : transitionSession(current, status, new Date().toISOString()));
      return { session: next };
    }
  }
}

export { recoverStaleModelRequests };
