import type { Message } from '@/core/messaging';
import { courseSchema, courseTaskSchema } from '@/core/domain';
import { appendMessage, excludeSource, restartFromStep, resolveTaskForGoal, sessionTitle, transitionSession, type AgentSession } from '@/core/session';
import { detectIntent } from '@/core/agent/intents';
import { openDatabase } from '@/core/storage/db';
import { Repository } from '@/core/storage/repository';
import { sessionRepository } from '@/core/storage/repositories';
import { STORE } from '@/core/storage/schema';
import { ChromeTabs } from '@/platform/tabs';
import { createEngine } from './recovery';
import { closeSessionWorkspace } from './workspaceEvents';
import { recoverStaleModelRequests, runFallbackPlan, runModelTurn, stopGeneration } from './modelTurn';

const ACTIVE_SESSION_KEY = 'motion.activeSessionId';

type SessionMessage = Extract<Message, { type: 'session-create' | 'session-message' | 'session-command' | 'session-select' | 'session-source' | 'session-tab' }>;

async function getSession(id: string): Promise<AgentSession | null> {
  const db = await openDatabase();
  return sessionRepository(db).get(id);
}

async function save(session: AgentSession): Promise<void> {
  const db = await openDatabase();
  await sessionRepository(db).put(session);
}

async function activeTabId(tabId: number | null): Promise<number | null> {
  if (tabId !== null) return tabId;
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab?.id ?? null;
}

async function createSession(message: Extract<SessionMessage, { type: 'session-create' }>) {
  const tabId = await activeTabId(message.tabId);
  const observation = tabId === null ? null : (await chrome.storage.session.get(`observation:${tabId}`))[`observation:${tabId}`] as { url?: unknown } | undefined;
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
    id: crypto.randomUUID(), title: sessionTitle(course?.code, task?.title ?? message.goal), goal: message.goal,
    courseId: task?.courseId ?? course?.id ?? null, taskId: task?.id ?? null, status: 'active', createdAt: now, updatedAt: now,
    workspace: { groupId: null, groupTitle: `Motion · ${sessionTitle(course?.code, task?.title ?? message.goal)}`, sessionKey: null, ownedTabIds: [], adoptedTabIds: [], releasedTabIds: [] },
    plan: { steps: [], currentStepId: null }, blockers: [], context: { sources: [] }, artifacts: [], agent: { providerId: null, model: null },
    conversation: [{ id: crypto.randomUUID(), role: 'student', text: message.goal, at: now }], activity: [], workflowIds: [], pendingModelRequest: null,
  };
  await sessionRepository(db).put(session);
  await chrome.storage.session.set({ [ACTIVE_SESSION_KEY]: session.id });
  return (await runModelTurn(session.id, message.goal)) ?? session;
}

async function applyIntent(session: AgentSession, text: string): Promise<AgentSession> {
  const intent = detectIntent(text);
  if (!intent) return (await runModelTurn(session.id, text)) ?? session;
  const now = new Date().toISOString();
  let next = appendMessage(session, { id: crypto.randomUUID(), role: 'student', text }, now);
  if (intent.type === 'open-everything') {
    await save(next);
    return (await runFallbackPlan(next.id, 'Motion is opening the resources it already knows about.')) ?? next;
  }
  const engine = await createEngine();
  if (intent.type === 'pause' || intent.type === 'stop') {
    for (const id of next.workflowIds) await (intent.type === 'pause' ? engine.pause(id) : engine.cancel(id));
    next = transitionSession(next, 'paused', now);
    next = appendMessage(next, { id: crypto.randomUUID(), role: 'motion', text: intent.type === 'pause' ? 'Paused. Say “resume” when you are ready.' : 'Stopped the current work.' }, now);
  } else if (intent.type === 'resume') {
    for (const id of next.workflowIds) await engine.resume(id);
    next = transitionSession(next, 'working', now);
    next = appendMessage(next, { id: crypto.randomUUID(), role: 'motion', text: 'Resumed.' }, now);
  } else if (intent.type === 'why') {
    const step = next.plan.steps.find((item) => item.id === next.plan.currentStepId);
    next = appendMessage(next, { id: crypto.randomUUID(), role: 'motion', text: step ? `The current step is “${step.title}” because it supports your stated goal.` : 'There is no active step yet.' }, now);
  } else if (intent.type === 'exclude-source') {
    const source = next.context.sources.find((item) => item.url.includes(intent.hint ?? '') || item.title.toLowerCase().includes((intent.hint ?? '').toLowerCase()));
    next = source ? excludeSource(next, source.url, now) : next;
    next = appendMessage(next, { id: crypto.randomUUID(), role: 'motion', text: source ? `I will not use “${source.title || source.url}”.` : 'Tell me which source you want to exclude.' }, now);
  } else if (intent.type === 'restart') {
    const step = next.plan.steps.find((item) => item.title.toLowerCase().includes((intent.hint ?? '').toLowerCase())) ?? next.plan.steps[0];
    if (step) next = restartFromStep(next, step.id, now);
    next = appendMessage(next, { id: crypto.randomUUID(), role: 'motion', text: step ? `Restarted from “${step.title}”.` : 'There is no plan step to restart.' }, now);
  } else if (intent.type === 'deadlines') {
    next = appendMessage(next, { id: crypto.randomUUID(), role: 'motion', text: `I’ll show the ${intent.range === 'all' ? 'known' : intent.range} deadlines in the deadline view.` }, now);
  }
  await save(next);
  return next;
}

export async function handleSessionMessage(message: SessionMessage): Promise<unknown> {
  switch (message.type) {
    case 'session-create': return { session: await createSession(message) };
    case 'session-select':
      await chrome.storage.session.set({ [ACTIVE_SESSION_KEY]: message.sessionId });
      return { selected: message.sessionId };
    case 'session-message': {
      const session = await getSession(message.sessionId);
      return { session: session ? await applyIntent(session, message.text) : null };
    }
    case 'session-source': {
      const session = await getSession(message.sessionId);
      if (!session) return { updated: false };
      const now = new Date().toISOString();
      const next = { ...session, context: { ...session.context, sources: session.context.sources.map((source) => source.url === message.url ? { ...source, excluded: message.excluded } : source) }, updatedAt: now };
      await save(next);
      return { updated: true };
    }
    case 'session-tab': {
      const session = await getSession(message.sessionId);
      if (!session) return { updated: false };
      const now = new Date().toISOString();
      const owned = session.workspace.ownedTabIds.filter((id) => id !== message.tabId);
      const adopted = message.op === 'adopt' ? [...new Set([...session.workspace.adoptedTabIds, message.tabId])] : session.workspace.adoptedTabIds.filter((id) => id !== message.tabId);
      await save({ ...session, workspace: { ...session.workspace, ownedTabIds: owned, adoptedTabIds: adopted, releasedTabIds: message.op === 'release' ? [...new Set([...session.workspace.releasedTabIds, message.tabId])] : session.workspace.releasedTabIds }, updatedAt: now });
      return { updated: true };
    }
    case 'session-command': {
      const session = await getSession(message.sessionId);
      if (!session) return { updated: false };
      if (message.command === 'stop-generation') { await stopGeneration(session.id); return { stopped: true }; }
      if (message.command === 'retry-model') return { session: await runModelTurn(session.id, session.goal) };
      const engine = await createEngine();
      for (const id of session.workflowIds) await (message.command === 'pause' ? engine.pause(id) : message.command === 'resume' ? engine.resume(id) : engine.cancel(id));
      if (message.command === 'archive') await closeSessionWorkspace(session, new ChromeTabs());
      const status = message.command === 'pause' ? 'paused' : message.command === 'archive' ? 'archived' : 'active';
      const next = transitionSession(session, status, new Date().toISOString());
      await save(next);
      return { session: next };
    }
  }
}

export { recoverStaleModelRequests };
