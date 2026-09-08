import { z } from 'zod';
import { courseSchema, courseTaskSchema, pageTypeSchema } from '../domain';
import { approvalRequestSchema } from '../policy';
import { workflowSchema } from '../workflows/types';

/**
 * Everything the side panel renders, in one serializable shape.
 *
 * The panel is a view: it receives this, draws it, and sends commands back. It
 * holds no repository handle and performs no orchestration, so an XSS in the
 * panel inherits a narrow command surface rather than the database
 * (docs/THREAT_MODEL.md T3).
 */

export const connectionStateSchema = z.enum([
  /** Panel is open on a page an adapter claims. */
  'supported',
  /** Open on a page Motion does not support. */
  'unsupported',
  /** On a supported host, but Motion lacks permission for it. */
  'permission-needed',
  /** Page looks like a graded attempt: restricted learning-support mode. */
  'restricted',
  /** The LMS redirected to sign-in; nothing can be read until the student returns. */
  'signed-out',
  /** No active tab, or the panel opened before a page was observed. */
  'idle',
]);
export type ConnectionState = z.infer<typeof connectionStateSchema>;

export const pageContextSchema = z.object({
  url: z.string().url().nullable(),
  pageType: pageTypeSchema.nullable(),
  title: z.string(),
  /** When the page looks like an assessment, why Motion is standing back. */
  restrictionReason: z.string().nullable().default(null),
  /** Non-fatal problems: a partial load, a renamed region, a stale read. */
  warnings: z.array(z.string()).default([]),
  /** When this observation was made, so the panel can mark it stale. */
  observedAt: z.string().datetime().nullable(),
});
export type PageContext = z.infer<typeof pageContextSchema>;

export const panelStateSchema = z.object({
  connection: connectionStateSchema,
  page: pageContextSchema,
  course: courseSchema.nullable(),
  /** Upcoming and recent work, already sorted by the worker. */
  tasks: z.array(courseTaskSchema).default([]),
  workflows: z.array(workflowSchema).default([]),
  /** Anything waiting on the student, newest first. */
  approvals: z.array(approvalRequestSchema).default([]),
  /** Rows that failed validation on read, so the panel can say so honestly. */
  corruptedRecords: z.number().int().nonnegative().default(0),
  /** True while the worker is mid-extraction, for the loading state. */
  busy: z.boolean().default(false),
});
export type PanelState = z.infer<typeof panelStateSchema>;

export const EMPTY_PANEL_STATE: PanelState = {
  connection: 'idle',
  page: {
    url: null,
    pageType: null,
    title: '',
    restrictionReason: null,
    warnings: [],
    observedAt: null,
  },
  course: null,
  tasks: [],
  workflows: [],
  approvals: [],
  corruptedRecords: 0,
  busy: false,
};

/** How long before an observation is shown as stale rather than current. */
export const STALE_AFTER_MS = 5 * 60 * 1000;

export function isStale(observedAt: string | null, now: Date): boolean {
  if (!observedAt) return false;
  return now.getTime() - new Date(observedAt).getTime() > STALE_AFTER_MS;
}
