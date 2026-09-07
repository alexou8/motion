import { z } from 'zod';
import { courseSchema, courseTaskSchema, pageContentSchema, pageTypeSchema } from '../domain';

/**
 * Typed message contracts between extension contexts.
 *
 * Every message names the role permitted to send it. Shape validation and
 * sender authorization are separate concerns — a schema proves what a message
 * looks like, never who was entitled to send it (see docs/THREAT_MODEL.md T2).
 */

export const senderRoleSchema = z.enum(['content-script', 'extension-ui']);
export type SenderRole = z.infer<typeof senderRoleSchema>;

/** Bounds on anything derived from a page, so a hostile page cannot exhaust storage. */
export const LIMITS = {
  text: 200_000,
  title: 500,
  taskCount: 500,
  linkCount: 300,
  warningCount: 50,
} as const;

const boundedString = (max: number) => z.string().max(max);

/* ---------------- content script -> service worker ---------------- */

export const pageObservedSchema = z.object({
  type: z.literal('page-observed'),
  /** The URL the content script saw. Cross-checked against the real sender. */
  url: z.string().url(),
  pageType: pageTypeSchema,
  title: boundedString(LIMITS.title),
  detectionConfidence: z.enum(['confirmed', 'high', 'medium', 'low']),
  warnings: z.array(boundedString(500)).max(LIMITS.warningCount).default([]),
  /** True when the page looked like a graded attempt; the worker stores nothing. */
  restricted: z.boolean().default(false),
});

export const extractionResultSchema = z.object({
  type: z.literal('extraction-result'),
  requestId: z.string().uuid(),
  url: z.string().url(),
  course: courseSchema.nullable(),
  tasks: z.array(courseTaskSchema).max(LIMITS.taskCount).default([]),
  content: pageContentSchema.nullable(),
  warnings: z.array(boundedString(500)).max(LIMITS.warningCount).default([]),
});

/* ---------------- side panel / options -> service worker ---------------- */

export const requestExtractionSchema = z.object({
  type: z.literal('request-extraction'),
  tabId: z.number().int().nonnegative(),
});

export const getStateSchema = z.object({ type: z.literal('get-state') });

export const decideApprovalSchema = z.object({
  type: z.literal('decide-approval'),
  approvalId: z.string().min(1),
  approved: z.boolean(),
});

export const workflowCommandSchema = z.object({
  type: z.literal('workflow-command'),
  workflowId: z.string().min(1),
  command: z.enum(['pause', 'resume', 'retry', 'cancel']),
});

export const correctTaskSchema = z.object({
  type: z.literal('correct-task'),
  taskId: z.string().min(1),
  field: z.enum(['title', 'dueIso', 'weight', 'status']),
  value: z.union([z.string().max(500), z.number(), z.null()]),
});

/* ---------------- the union ---------------- */

export const messageSchema = z.discriminatedUnion('type', [
  pageObservedSchema,
  extractionResultSchema,
  requestExtractionSchema,
  getStateSchema,
  decideApprovalSchema,
  workflowCommandSchema,
  correctTaskSchema,
]);
export type Message = z.infer<typeof messageSchema>;
export type MessageType = Message['type'];

/**
 * Which role may send which message. A content script runs in a page Motion
 * does not control, so it may only *report* what it saw — it can never command
 * the worker to act, decide an approval, or drive a workflow.
 */
export const ALLOWED_SENDERS: Record<MessageType, readonly SenderRole[]> = {
  'page-observed': ['content-script'],
  'extraction-result': ['content-script'],
  'request-extraction': ['extension-ui'],
  'get-state': ['extension-ui'],
  'decide-approval': ['extension-ui'],
  'workflow-command': ['extension-ui'],
  'correct-task': ['extension-ui'],
};

export function maySend(type: MessageType, role: SenderRole): boolean {
  return ALLOWED_SENDERS[type].includes(role);
}
