import { agentSessionSchema } from '../session';
import type { AgentSession } from '../session';
import { courseLinkSchema } from '../graph';
import { STORE } from './schema';
import { Repository } from './repository';
import type { CourseTask, DueDate, DueHistoryEntry } from '../domain';
import { courseTaskSchema } from '../domain';

const DUE_HISTORY_LIMIT = 10;

function historyEntry(due: DueDate, observedAt: string, provenance: CourseTask['provenance']): DueHistoryEntry {
  return { iso: due.iso, raw: due.raw, observedAt, provenance, confidence: due.confidence };
}

function appendHistory(history: CourseTask['dueHistory'], entry: DueHistoryEntry): CourseTask['dueHistory'] {
  const last = history.at(-1);
  if (last?.iso === entry.iso && last.raw === entry.raw && last.observedAt === entry.observedAt) return history;
  return [...history, entry].slice(-DUE_HISTORY_LIMIT);
}

function lastObservedLmsDue(task: CourseTask): DueHistoryEntry {
  if (task.dueConflict) return task.dueConflict.observed;
  // The first correction is the original LMS observation. Later corrections
  // start from the student's effective value and must never be relabelled as
  // an LMS observation during a rescan.
  const correctedDue = task.corrections.find((correction) => correction.field === 'due.iso');
  if (!correctedDue) {
    return historyEntry(task.due, task.due.lastObservedAt ?? task.updatedAt, task.provenance);
  }
  const historical = task.dueHistory.at(-1);
  return {
    iso: typeof correctedDue?.originalValue === 'string' ? correctedDue.originalValue : null,
    raw: task.due.raw,
    observedAt: task.due.lastObservedAt ?? task.updatedAt,
    provenance: task.provenance,
    confidence: historical?.confidence ?? 'high',
  };
}

function correctedLmsDueIso(task: CourseTask): string | null | undefined {
  const correction = task.corrections.find((entry) => entry.field === 'due.iso');
  if (!correction) return undefined;
  if (typeof correction.originalValue === 'string' || correction.originalValue === null) return correction.originalValue;
  return undefined;
}

/**
 * Combines an extracted row with a stored task without losing a student's
 * correction. A moved LMS date is detected by its parsed instant, not its
 * presentation text, so harmless formatting changes do not create history.
 */
export function mergeExtractedTask(existing: CourseTask | null, incoming: CourseTask): CourseTask {
  if (!existing) return incoming;

  // Learn can show a stale list row after an item has been submitted or graded.
  // Never regress a terminal local status, while still accepting a newly
  // observed submission for a student-edited task.
  const status = ['submitted', 'graded'].includes(existing.status) && !['submitted', 'graded'].includes(incoming.status)
    ? existing.status
    : incoming.status;

  const base = {
    ...incoming,
    status,
    createdAt: existing.createdAt,
    dueHistory: existing.dueHistory,
    dueChangedAt: existing.dueChangedAt,
    dueConflict: existing.dueConflict,
  };

  const statusCorrection = [...existing.corrections].reverse().find((correction) => correction.field === 'status');
  // A later LMS terminal observation is authoritative for status. Older or
  // non-terminal observations remain pinned to the student's correction.
  const incomingIsTerminal = incoming.status === 'submitted' || incoming.status === 'graded';
  const incomingIsNewer = statusCorrection !== undefined && incoming.updatedAt > statusCorrection.correctedAt;
  if (statusCorrection && !(incomingIsTerminal && incomingIsNewer)) base.status = existing.status;

  // A student-edited task is handled entirely below: it must never fall
  // through to the generic weaker/undated-evidence guard, which does not
  // know how to preserve title/weight/corrections/studentEdited.
  if (existing.studentEdited) {
    const hasDueCorrection = existing.corrections.some((correction) => correction.field === 'due.iso');
    // Only a logged due.iso correction gives us an LMS value to compare
    // against. Other student edits (title, weight, status) carry no due
    // observation, so a rescan can't tell a real LMS move from a value that
    // was simply set directly; keep the existing due as-is rather than
    // fabricate a conflict.
    if (!hasDueCorrection) {
      return {
        ...base,
        title: existing.title,
        due: existing.due,
        weight: existing.weight,
        corrections: existing.corrections,
        studentEdited: true,
      };
    }

    const correctedLmsIso = correctedLmsDueIso(existing);
    // A weak/undated route sighting is not evidence that Learn moved a date.
    // It must not create a conflict against the student's correction.
    const confidenceRank = { low: 0, medium: 1, high: 2, confirmed: 3 } as const;
    const previousLmsConfidence = lastObservedLmsDue(existing).confidence ?? 'high';
    if (incoming.due.iso === null || confidenceRank[incoming.due.confidence] < confidenceRank[previousLmsConfidence]) {
      return {
        ...base,
        title: existing.title,
        due: existing.due,
        weight: existing.weight,
        corrections: existing.corrections,
        studentEdited: true,
      };
    }
    // If Learn moved back to the value the student originally corrected, the
    // disagreement is resolved. Keep the superseded LMS observation in history.
    if (
      (correctedLmsIso !== undefined && correctedLmsIso === incoming.due.iso) ||
      (existing.dueConflict !== null && existing.due.iso === incoming.due.iso && existing.dueConflict.observed.iso === incoming.due.iso)
    ) {
      return {
        ...base,
        title: existing.title,
        due: existing.due,
        weight: existing.weight,
        corrections: existing.corrections,
        studentEdited: true,
        dueHistory: existing.dueConflict
          ? appendHistory(existing.dueHistory, existing.dueConflict.observed)
          : existing.dueHistory,
        dueConflict: null,
      };
    }
    const previousLmsDue = lastObservedLmsDue(existing);
    if (previousLmsDue.iso !== incoming.due.iso) {
      return {
        ...base,
        title: existing.title,
        due: existing.due,
        weight: existing.weight,
        corrections: existing.corrections,
        studentEdited: true,
        dueHistory: appendHistory(existing.dueHistory, previousLmsDue),
        dueConflict: { observed: historyEntry(incoming.due, incoming.due.lastObservedAt ?? incoming.updatedAt, incoming.provenance) },
      };
    }

    return {
      ...base,
      title: existing.title,
      due: existing.due,
      weight: existing.weight,
      corrections: existing.corrections,
      studentEdited: true,
    };
  }

  // SOL-17: an undated or lower-confidence sighting (e.g. a content-module
  // link with no date) must never erase a previously observed due date.
  const confidenceRank = { low: 0, medium: 1, high: 2, confirmed: 3 } as const;
  const weakerOrUndated = incoming.due.iso === null || confidenceRank[incoming.due.confidence] < confidenceRank[existing.due.confidence];
  if (weakerOrUndated && existing.due.iso !== null) {
    return { ...base, due: existing.due, dueConflict: existing.dueConflict };
  }

  if (existing.due.iso !== incoming.due.iso) {
    return {
      ...base,
      dueHistory: appendHistory(
        existing.dueHistory,
        historyEntry(existing.due, existing.due.lastObservedAt ?? existing.updatedAt, existing.provenance),
      ),
      dueChangedAt: incoming.due.lastObservedAt ?? incoming.updatedAt,
      dueConflict: null,
    };
  }

  return base;
}

/** Typed repository over the `sessions` store, validating on every read/write. */
export function sessionRepository(db: IDBDatabase) {
  return new Repository(db, STORE.sessions, agentSessionSchema);
}

/**
 * Atomically update one AgentSession.
 *
 * The read, mutation and write intentionally share one IndexedDB transaction.
 * IndexedDB serializes concurrent readwrite transactions for this store, so a
 * second worker observes the first worker's revision rather than overwriting
 * it with a stale read-modify-write result.
 */
export function updateSession(
  db: IDBDatabase,
  id: string,
  mutator: (session: AgentSession) => AgentSession | null,
): Promise<AgentSession | null> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE.sessions, 'readwrite');
    const store = transaction.objectStore(STORE.sessions);
    let intentionalAbort = false;
    let result: AgentSession | null = null;
    let failure: unknown = null;

    const request = store.get(id);
    request.onerror = () => {
      failure = request.error ?? new Error('Failed to read session.');
      transaction.abort();
    };
    request.onsuccess = () => {
      const parsed = agentSessionSchema.safeParse(request.result);
      if (!parsed.success) {
        intentionalAbort = true;
        transaction.abort();
        return;
      }

      let next: AgentSession | null;
      try {
        next = mutator(parsed.data);
      } catch (error) {
        failure = error;
        transaction.abort();
        return;
      }
      if (next === null) {
        intentionalAbort = true;
        transaction.abort();
        return;
      }

      try {
        result = agentSessionSchema.parse({
          ...next,
          revision: parsed.data.revision + 1,
        });
        store.put(result);
      } catch (error) {
        failure = error;
        transaction.abort();
      }
    };

    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => {
      if (failure) reject(failure);
      else reject(transaction.error ?? new Error('Session transaction failed.'));
    };
    transaction.onabort = () => {
      if (failure) reject(failure);
      else if (intentionalAbort) resolve(null);
      else reject(transaction.error ?? new Error('Session transaction aborted.'));
    };
  });
}

/**
 * Atomically modifies one task. Task rescans and student corrections share
 * this primitive so either writer sees the other's committed record.
 */
export function updateTask(
  db: IDBDatabase,
  id: string,
  mutator: (task: CourseTask) => CourseTask | null,
): Promise<CourseTask | null> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE.tasks, 'readwrite');
    const store = transaction.objectStore(STORE.tasks);
    let result: CourseTask | null = null;
    let intentionalAbort = false;
    let failure: unknown = null;
    const request = store.get(id);
    request.onerror = () => { failure = request.error ?? new Error('Failed to read task.'); transaction.abort(); };
    request.onsuccess = () => {
      const parsed = courseTaskSchema.safeParse(request.result);
      if (!parsed.success) { intentionalAbort = true; transaction.abort(); return; }
      try {
        const next = mutator(parsed.data);
        if (!next) { intentionalAbort = true; transaction.abort(); return; }
        result = courseTaskSchema.parse(next);
        store.put(result);
      } catch (error) { failure = error; transaction.abort(); }
    };
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(failure ?? transaction.error ?? new Error('Task transaction failed.'));
    transaction.onabort = () => intentionalAbort ? resolve(null) : reject(failure ?? transaction.error ?? new Error('Task transaction aborted.'));
  });
}

type RepointableEndpoint = { kind?: unknown; id?: unknown };
type RepointableRow = { taskId?: unknown; from?: RepointableEndpoint; to?: RepointableEndpoint };

function repointedRow(row: RepointableRow, fromId: string, toId: string): RepointableRow {
  const next: RepointableRow = { ...row };
  if (next.taskId === fromId) next.taskId = toId;
  if (next.from && next.from.kind === 'task' && next.from.id === fromId) next.from = { ...next.from, id: toId };
  if (next.to && next.to.kind === 'task' && next.to.id === fromId) next.to = { ...next.to, id: toId };
  return next;
}

/**
 * Re-points every note, checklist and course-link that referenced `fromId` at
 * `toId`, inside the caller's transaction. Used when a legacy task row is
 * folded into its canonical id (D-ID), so a note taken before the migration
 * does not stay attached to the archived tombstone.
 */
function repointTaskDependents(transaction: IDBTransaction, fromId: string, toId: string): void {
  for (const storeName of [STORE.notes, STORE.checklists, STORE.sessions] as const) {
    const store = transaction.objectStore(storeName);
    const index = store.index('byTask');
    const cursorRequest = index.openCursor(IDBKeyRange.only(fromId));
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor) return;
      const row = cursor.value as RepointableRow;
      const next = repointedRow(row, fromId, toId);
      if (storeName === STORE.sessions) {
        const session = agentSessionSchema.parse({
          ...next,
          revision: ((row as { revision?: number }).revision ?? 0) + 1,
          updatedAt: new Date().toISOString(),
        });
        cursor.update(session);
      } else cursor.update(next);
      cursor.continue();
    };
  }
  // Course links can reference a task only through `from`/`to` while their
  // nullable taskId remains unset, so the byTask index is insufficient.
  const links = transaction.objectStore(STORE.courseLinks);
  const linkCursor = links.openCursor();
  linkCursor.onsuccess = () => {
    const cursor = linkCursor.result;
    if (!cursor) return;
    const row = cursor.value as RepointableRow;
    const next = repointedRow(row, fromId, toId);
    if (JSON.stringify(next) !== JSON.stringify(row)) cursor.update(next);
    cursor.continue();
  };
}

/**
 * Merges an extracted task and any single legacy row inside one readwrite
 * transaction. The course-index read and both writes deliberately share the
 * transaction so a concurrent correction cannot be clobbered between lookup
 * and put, including while an old URL id is being folded into the new id.
 *
 * Dependents (notes, checklists, course links) are re-pointed at the
 * canonical id in the same transaction. A tombstone — a row already archived
 * by a previous fold, recognisable by its `migratedTo` pointer — is never
 * un-archived by a later exact-id hit; the merge is redirected onto the
 * canonical row instead (D-ID).
 */
export function upsertExtractedTask(
  db: IDBDatabase,
  incoming: CourseTask,
  isLegacyMatch: (candidate: CourseTask, incoming: CourseTask) => boolean,
): Promise<{ task: CourseTask; migrated: boolean; migratedFromId: string | null }> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE.tasks, STORE.notes, STORE.checklists, STORE.courseLinks, STORE.sessions], 'readwrite');
    const store = transaction.objectStore(STORE.tasks);
    let result: { task: CourseTask; migrated: boolean; migratedFromId: string | null } | null = null;
    let failure: unknown = null;
    const request = store.index('byCourse').getAll(incoming.courseId);
    request.onerror = () => { failure = request.error ?? new Error('Failed to read course tasks.'); transaction.abort(); };
    request.onsuccess = () => {
      try {
        const candidates = (request.result as unknown[])
          .map((row) => courseTaskSchema.safeParse(row))
          .flatMap((parsed) => parsed.success ? [parsed.data] : []);
        const existing = candidates.find((candidate) => candidate.id === incoming.id) ?? null;

        // A later scan reproduced a legacy id that was already folded once.
        // Never resurrect the tombstone: redirect the merge onto whatever it
        // was migrated into, and leave the tombstone archived.
        if (existing?.archived && existing.migratedTo) {
          const canonicalId = existing.migratedTo;
          const canonicalRow = candidates.find((candidate) => candidate.id === canonicalId) ?? null;
          const merged = mergeExtractedTask(canonicalRow, { ...incoming, id: canonicalId });
          const task = courseTaskSchema.parse(merged);
          store.put(task);
          result = { task, migrated: false, migratedFromId: null };
          return;
        }

        const legacyCandidates = existing ? [] : candidates.filter((candidate) => isLegacyMatch(candidate, incoming));
        const legacy = legacyCandidates.length === 1 ? legacyCandidates[0]! : null;
        const merged = mergeExtractedTask(existing ?? legacy, incoming);
        const task = courseTaskSchema.parse(merged);
        store.put(task);
        if (legacy) {
          store.put(courseTaskSchema.parse({ ...legacy, archived: true, migratedTo: task.id, updatedAt: incoming.updatedAt }));
          if (legacy.id !== task.id) repointTaskDependents(transaction, legacy.id, task.id);
        }
        result = { task, migrated: legacy !== null, migratedFromId: legacy ? legacy.id : null };
      } catch (error) { failure = error; transaction.abort(); }
    };
    transaction.oncomplete = () => result ? resolve(result) : reject(new Error('Task transaction completed without a result.'));
    transaction.onerror = () => reject(failure ?? transaction.error ?? new Error('Task transaction failed.'));
    transaction.onabort = () => reject(failure ?? transaction.error ?? new Error('Task transaction aborted.'));
  });
}

/** Typed repository over the `courseLinks` store, validating on every read/write. */
export function courseLinkRepository(db: IDBDatabase) {
  return new Repository(db, STORE.courseLinks, courseLinkSchema);
}
