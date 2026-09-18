import { z } from 'zod';
import { courseSchema, courseTaskSchema, pageTypeSchema } from '../domain';
import { approvalRequestSchema } from '../policy';
import { workflowSchema } from '../workflows/types';
import { agentSessionSchema } from '../session/types';

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

export const sessionSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  status: agentSessionSchema.shape.status,
  courseId: z.string().nullable(),
  taskId: z.string().nullable(),
  updatedAt: z.string().datetime(),
  needsYou: z.number().int().nonnegative(),
  currentStepTitle: z.string().nullable(),
});
export type SessionSummary = z.infer<typeof sessionSummarySchema>;

/** Human-readable workspace rows. `tabId` is a command handle, never UI copy. */
export const workspaceTabSummarySchema = z.object({
  tabId: z.number().int().nonnegative(),
  title: z.string().max(500),
  host: z.string().max(255).nullable(),
  ownership: z.enum(['motion', 'student']),
  current: z.boolean(),
});
export type WorkspaceTabSummary = z.infer<typeof workspaceTabSummarySchema>;

export const deadlineIdsSchema = z.object({
  today: z.array(z.string()),
  upcoming: z.array(z.string()),
  overdue: z.array(z.string()),
  needsReview: z.array(z.string()),
});

export const panelAiSchema = z.object({
  providerId: z.enum(['chrome-local', 'openai', 'anthropic']),
  displayName: z.string(),
  cloud: z.boolean(),
  status: z.string(),
  message: z.string(),
});
export const discoveryStateSchema = z.object({ host: z.string().nullable(), optedIn: z.boolean().nullable(), busy: z.boolean().default(false), result: z.object({ deadlines: z.number().int().nonnegative(), courses: z.number().int().nonnegative(), updatedAt: z.string().datetime() }).nullable().default(null), blocker: z.string().nullable().default(null) });

export const panelStateSchema = z.object({
  connection: connectionStateSchema,
  page: pageContextSchema,
  course: courseSchema.nullable(),
  /** Known courses, used to name grouped deadline counts without another panel round trip. */
  courses: z.array(courseSchema).default([]),
  /** Upcoming and recent work, already sorted by the worker. */
  tasks: z.array(courseTaskSchema).default([]),
  workflows: z.array(workflowSchema).default([]),
  /** Anything waiting on the student, newest first. */
  approvals: z.array(approvalRequestSchema).default([]),
  /** Rows that failed validation on read, so the panel can say so honestly. */
  corruptedRecords: z.number().int().nonnegative().default(0),
  /** True while the worker is mid-extraction, for the loading state. */
  busy: z.boolean().default(false),
  /** AgentSessions, most recently updated first (summaries: no conversation/activity). */
  sessions: z.array(sessionSummarySchema).default([]),
  /** The session the panel is showing, in full. Null shows the session list. */
  activeSession: agentSessionSchema.nullable().default(null),
  /** Live metadata for the selected session's workspace tabs. */
  workspaceTabs: z.array(workspaceTabSummarySchema).default([]),
  /** Deadline buckets across known courses (task ids reference `tasks`). */
  deadlines: deadlineIdsSchema.default({ today: [], upcoming: [], overdue: [], needsReview: [] }),
  /** The selected AI provider as the session header shows it ("AI · OpenAI"). */
  ai: panelAiSchema.default({ providerId: 'chrome-local', displayName: 'Chrome Local', cloud: false, status: 'unavailable', message: '' }),
  /** Text being generated right now for the active session, if streaming. */
  streaming: z.object({ sessionId: z.string(), text: z.string().max(40_000) }).nullable().default(null),
  discovery: discoveryStateSchema.default({ host: null, optedIn: null, busy: false, result: null, blocker: null }),
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
  courses: [],
  tasks: [],
  workflows: [],
  approvals: [],
  corruptedRecords: 0,
  busy: false,
  sessions: [],
  activeSession: null,
  workspaceTabs: [],
  deadlines: { today: [], upcoming: [], overdue: [], needsReview: [] },
  ai: { providerId: 'chrome-local', displayName: 'Chrome Local', cloud: false, status: 'unavailable', message: '' },
  streaming: null,
  discovery: { host: null, optedIn: null, busy: false, result: null, blocker: null },
};

/** How long before an observation is shown as stale rather than current. */
export const STALE_AFTER_MS = 5 * 60 * 1000;

export function isStale(observedAt: string | null, now: Date): boolean {
  if (!observedAt) return false;
  return now.getTime() - new Date(observedAt).getTime() > STALE_AFTER_MS;
}
