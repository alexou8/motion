import type { AgentSession, SessionSource } from '../session';
import type { CourseLink } from '../graph';
import type { CourseTask, Note } from '../domain';
import type { SnapshotResult, ElementDescriptor } from '../actor/contracts';

/**
 * Trusted ref tables (VISION §8; ARCH D7): the only vocabulary the model may
 * use to point at course/browser state. Every ref below is issued by Motion
 * from state Motion itself built — never copied from page text — so a ref
 * string can be trusted even though the *title/label* attached to it cannot.
 *
 * `linkRef`  ("L1"…)  -> a `CourseLink`, built from observed same-origin
 *                        page structure / the course graph.
 * `tabRef`   ("T1"…)  -> a tab id, but only for tabs in this session's
 *                        Motion-owned/adopted workspace.
 * `taskRef`           -> a `CourseTask` id (already Motion's own id).
 * `sourceRef`         -> an index into `session.context.sources`.
 * `noteRef`           -> a `Note` id.
 * `handle`            -> resolved per-tab from the *latest* snapshot only
 *                        (`refs.snapshots`), never from a stale one.
 */

export interface WorkspaceTab {
  tabId: number;
  url: string;
}

export interface BuildRefsInput {
  links: CourseLink[];
  tabs: WorkspaceTab[];
  /** Latest snapshot per tab id, keyed by `tabId`. */
  snapshots?: Record<number, SnapshotResult>;
  tasks: CourseTask[];
  notes: Note[];
}

export interface RefTables {
  linkByRef: Map<string, CourseLink>;
  refByLinkId: Map<string, string>;
  tabByRef: Map<string, WorkspaceTab>;
  refByTabId: Map<number, string>;
  taskByRef: Map<string, CourseTask>;
  sourceByRef: Map<string, SessionSource>;
  noteByRef: Map<string, Note>;
  /** Latest snapshot for a given tabRef, if one has been taken. */
  snapshotByTabRef: Map<string, SnapshotResult>;

  resolveLink(ref: string): CourseLink | null;
  resolveTab(ref: string): WorkspaceTab | null;
  resolveTask(ref: string): CourseTask | null;
  resolveSource(ref: string): SessionSource | null;
  resolveNote(ref: string): Note | null;
  /** Looks up an element handle in the *latest* snapshot for that tab only. */
  resolveHandle(tabRef: string, handle: string): ElementDescriptor | null;
}

/**
 * Builds stable ref tables for one agent turn. Ids are assigned by array
 * order (`L1`, `L2`, … / `T1`, `T2`, …); callers that need refs stable across
 * turns should keep `links`/`tabs` ordering stable themselves (e.g. sort by
 * id before calling), since this function does not persist an id assignment.
 * `taskRef`/`sourceRef`/`noteRef` reuse Motion's own existing ids rather than
 * minting new short ones — those ids are already Motion-issued and stable.
 */
export function buildTrustedRefs(session: AgentSession, input: BuildRefsInput): RefTables {
  const linkByRef = new Map<string, CourseLink>();
  const refByLinkId = new Map<string, string>();
  input.links.forEach((link, index) => {
    const ref = `L${index + 1}`;
    linkByRef.set(ref, link);
    refByLinkId.set(link.id, ref);
  });

  const tabByRef = new Map<string, WorkspaceTab>();
  const refByTabId = new Map<number, string>();
  input.tabs.forEach((tab, index) => {
    const ref = `T${index + 1}`;
    tabByRef.set(ref, tab);
    refByTabId.set(tab.tabId, ref);
  });

  const snapshotByTabRef = new Map<string, SnapshotResult>();
  if (input.snapshots) {
    for (const [tabIdStr, snapshot] of Object.entries(input.snapshots)) {
      const tabId = Number(tabIdStr);
      const ref = refByTabId.get(tabId);
      if (ref) snapshotByTabRef.set(ref, snapshot);
    }
  }

  const taskByRef = new Map<string, CourseTask>();
  for (const task of input.tasks) taskByRef.set(task.id, task);

  const sourceByRef = new Map<string, SessionSource>();
  session.context.sources.forEach((source, index) => {
    sourceByRef.set(`S${index + 1}`, source);
  });

  const noteByRef = new Map<string, Note>();
  for (const note of input.notes) noteByRef.set(note.id, note);

  return {
    linkByRef,
    refByLinkId,
    tabByRef,
    refByTabId,
    taskByRef,
    sourceByRef,
    noteByRef,
    snapshotByTabRef,
    resolveLink: (ref) => linkByRef.get(ref) ?? null,
    resolveTab: (ref) => tabByRef.get(ref) ?? null,
    resolveTask: (ref) => taskByRef.get(ref) ?? null,
    resolveSource: (ref) => sourceByRef.get(ref) ?? null,
    resolveNote: (ref) => noteByRef.get(ref) ?? null,
    resolveHandle: (tabRef, handle) => {
      const snapshot = snapshotByTabRef.get(tabRef);
      if (!snapshot) return null;
      return snapshot.elements.find((el) => el.handle === handle) ?? null;
    },
  };
}
