import type { Message } from '@/core/messaging';
import {
  checklistSchema,
  courseSchema,
  courseTaskSchema,
  noteSchema,
  pageContentSchema,
  EXTRACTION_VERSION,
  type PageContent,
} from '@/core/domain';
import { deriveRequirements, reviewDraft, summarize, toRequirements } from '@/core/assist';
import { approvalRequestSchema } from '@/core/policy';
import { openDatabase } from '@/core/storage/db';
import { Repository } from '@/core/storage/repository';
import { STORE } from '@/core/storage/schema';
import { IndexedDbWorkflowStore } from '@/core/storage/workflowStore';
import { EMPTY_PANEL_STATE, type PanelState } from '@/core/view';
import { createEngine } from './recovery';

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
      return handlePageObserved(message);
    case 'extraction-result':
      return handleExtraction(message);
    case 'get-state':
      return buildPanelState();
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
    case 'request-extraction':
      return requestExtraction(message.tabId ?? tabId);
  }
}

/**
 * A page observation is a signal, not data to keep. Nothing from a page marked
 * restricted is stored — that is the point of restricted mode.
 */
async function handlePageObserved(
  message: Extract<Message, { type: 'page-observed' }>,
): Promise<{ stored: boolean }> {
  if (message.restricted) return { stored: false };
  await chrome.storage.session.set({
    lastObservation: {
      url: message.url,
      pageType: message.pageType,
      title: message.title,
      warnings: message.warnings,
      observedAt: new Date().toISOString(),
    },
  });
  return { stored: true };
}

async function handleExtraction(
  message: Extract<Message, { type: 'extraction-result' }>,
): Promise<{ courses: number; tasks: number }> {
  const db = await openDatabase();
  const courses = new Repository(db, STORE.courses, courseSchema);
  const tasks = new Repository(db, STORE.tasks, courseTaskSchema);

  if (message.course) await courses.put(message.course);

  // A rescan must never overwrite a value the student corrected.
  let written = 0;
  for (const task of message.tasks) {
    const existing = await tasks.get(task.id);
    if (existing?.studentEdited) continue;
    await tasks.put({ ...task, createdAt: existing?.createdAt ?? task.createdAt });
    written += 1;
  }

  return { courses: message.course ? 1 : 0, tasks: written };
}

/**
 * Applies a student's correction additively: the original extracted value and
 * its provenance are kept, so a mistaken correction stays recoverable.
 */
async function handleCorrection(
  message: Extract<Message, { type: 'correct-task' }>,
): Promise<{ updated: boolean }> {
  const db = await openDatabase();
  const tasks = new Repository(db, STORE.tasks, courseTaskSchema);
  const task = await tasks.get(message.taskId);
  if (!task) return { updated: false };

  const now = new Date().toISOString();
  const next = { ...task, studentEdited: true, updatedAt: now };

  switch (message.field) {
    case 'title':
      if (typeof message.value !== 'string') return { updated: false };
      next.corrections = [
        ...task.corrections,
        { field: 'title', originalValue: task.title, correctedValue: message.value, correctedAt: now },
      ];
      next.title = message.value;
      break;
    case 'dueIso': {
      const value = typeof message.value === 'string' ? message.value : null;
      next.corrections = [
        ...task.corrections,
        { field: 'due.iso', originalValue: task.due.iso, correctedValue: value, correctedAt: now },
      ];
      // A student-supplied date is authoritative, so confidence becomes
      // 'confirmed' while the original parse stays in `corrections`.
      next.due = { ...task.due, iso: value, confidence: 'confirmed' };
      break;
    }
    case 'weight': {
      const value = typeof message.value === 'number' ? message.value : null;
      next.corrections = [
        ...task.corrections,
        { field: 'weight', originalValue: task.weight, correctedValue: value, correctedAt: now },
      ];
      next.weight = value;
      break;
    }
    case 'status': {
      const parsed = courseTaskSchema.shape.status.safeParse(message.value);
      if (!parsed.success) return { updated: false };
      next.corrections = [
        ...task.corrections,
        { field: 'status', originalValue: task.status, correctedValue: parsed.data, correctedAt: now },
      ];
      next.status = parsed.data;
      break;
    }
  }

  await tasks.put(next);
  return { updated: true };
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
    courseId: (await currentCourseId()) ?? 'unassigned',
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

/** Asks the content script for the current page's content, once. */
async function askContentScript(tabId: number): Promise<PageContent | null> {
  try {
    const response = (await chrome.tabs.sendMessage(tabId, {
      type: 'motion:extract-content',
    })) as { content?: unknown } | undefined;
    const parsed = pageContentSchema.safeParse(response?.content);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function currentCourseId(): Promise<string | null> {
  const db = await openDatabase();
  const courses = new Repository(db, STORE.courses, courseSchema);
  const all = await courses.all();
  return all.records[0]?.id ?? null;
}

async function requestExtraction(tabId: number | undefined): Promise<{ requested: boolean }> {
  if (tabId === undefined) return { requested: false };
  // The content script does the reading; the worker never scrapes a page.
  await chrome.tabs.sendMessage(tabId, { type: 'motion:extract' }).catch(() => undefined);
  return { requested: true };
}

/** Assembles everything the panel renders. */
export async function buildPanelState(): Promise<PanelState> {
  const db = await openDatabase();
  const courses = new Repository(db, STORE.courses, courseSchema);
  const taskRepo = new Repository(db, STORE.tasks, courseTaskSchema);
  const approvals = new Repository(db, STORE.approvals, approvalRequestSchema);
  const workflowStore = new IndexedDbWorkflowStore(db);

  const session = await chrome.storage.session.get('lastObservation');
  const observation = session['lastObservation'] as PanelState['page'] | undefined;

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

  const course =
    allCourses.records.find((candidate) =>
      observation?.url ? observation.url.includes(candidate.externalId ?? ' ') : false,
    ) ??
    allCourses.records[0] ??
    null;

  return {
    ...EMPTY_PANEL_STATE,
    connection: observation ? 'supported' : 'idle',
    page: observation ?? EMPTY_PANEL_STATE.page,
    course,
    tasks: upcoming,
    workflows: await workflowStore.list(),
    approvals: pending,
    corruptedRecords:
      allTasks.corrupted.length + allApprovals.corrupted.length + allCourses.corrupted.length,
  };
}

