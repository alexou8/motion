import { z } from 'zod';
import type { Workflow } from '@/core/workflows';

/**
 * Which tabs a prepared workspace owns.
 *
 * A tab is Motion's because Motion recorded its id when it opened it — never
 * because it sits in Motion's group. A student can drag their own tab into the
 * group, and closing the workspace must not close it (docs/THREAT_MODEL.md T14).
 *
 * The record is the evidence the `open-sources` step committed, which is stored
 * with the workflow. It is read back through a schema because it is persisted
 * data: a corrupted row yields "owns nothing", never a guess.
 *
 * Tab and group ids are only meaningful within the browser session that
 * issued them, while the workflow row outlives it. The record therefore names
 * its session, and a record from any other session owns nothing: after a
 * browser restart Chrome may give the same numbers to unrelated tabs.
 */

/** Stable step id from the `prepare-workspace` definition. */
export const OPEN_SOURCES_STEP_ID = 'open-sources';

const evidenceSchema = z.object({
  groupId: z.number().int(),
  tabIds: z.array(z.number().int().nonnegative()),
  sessionKey: z.string().min(1),
});

export interface WorkspaceOwnership {
  groupId: number | null;
  tabIds: number[];
}

const OWNS_NOTHING: WorkspaceOwnership = { groupId: null, tabIds: [] };

export function workspaceOwnership(workflow: Workflow, sessionKey: string): WorkspaceOwnership {
  const step = workflow.steps.find((candidate) => candidate.id === OPEN_SOURCES_STEP_ID);
  const parsed = evidenceSchema.safeParse(step?.intent?.evidence ?? {});
  if (!parsed.success || parsed.data.sessionKey !== sessionKey) return OWNS_NOTHING;
  return { groupId: parsed.data.groupId, tabIds: parsed.data.tabIds };
}
