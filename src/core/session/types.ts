import { z } from 'zod';

/**
 * AgentSession: Motion's core unit of goal-oriented work (VISION §4, ARCH D6).
 *
 * Deliberately action-free: a session references workflow ids rather than
 * embedding action/step execution state, which lives in `src/core/workflows`.
 * That keeps a session cheap to read for the side panel while the workflow
 * engine remains the single place durable step execution is tracked.
 */

export const sessionStatusSchema = z.enum([
  'active',
  'working',
  'waiting',
  'paused',
  'completed',
  'archived',
]);
export type SessionStatus = z.infer<typeof sessionStatusSchema>;

export const planStepStatusSchema = z.enum([
  'pending',
  'active',
  'done',
  'blocked',
  'skipped',
  'failed',
]);
export type PlanStepStatus = z.infer<typeof planStepStatusSchema>;

export const planStepSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  status: planStepStatusSchema.default('pending'),
  rationale: z.string().optional(),
});
export type PlanStep = z.infer<typeof planStepSchema>;

export const sessionPlanSchema = z.object({
  steps: z.array(planStepSchema).default([]),
  currentStepId: z.string().nullable().default(null),
});
export type SessionPlan = z.infer<typeof sessionPlanSchema>;

export const blockerKindSchema = z.enum([
  'approval',
  'provider',
  'permission',
  'document-context',
  'rate-limit',
  'user-input',
  'error',
]);
export type BlockerKind = z.infer<typeof blockerKindSchema>;

export const sessionBlockerSchema = z.object({
  id: z.string().min(1),
  kind: blockerKindSchema,
  message: z.string().min(1),
  retryAt: z.string().datetime().optional(),
  approvalId: z.string().optional(),
});
export type SessionBlocker = z.infer<typeof sessionBlockerSchema>;

export const sessionSourceKindSchema = z.enum([
  'instructions',
  'rubric',
  'reading',
  'module',
  'discussion',
  'submission',
  'other',
]);
export type SessionSourceKind = z.infer<typeof sessionSourceKindSchema>;

export const sessionSourceSchema = z.object({
  url: z.string().url(),
  title: z.string().default(''),
  kind: sessionSourceKindSchema,
  excluded: z.boolean().default(false),
  provenance: z.string().default(''),
  /** Bounded readable text captured from a non-restricted page. */
  excerpt: z.string().max(8_000).default(''),
});
export type SessionSource = z.infer<typeof sessionSourceSchema>;

export const sessionContextSchema = z.object({
  sources: z.array(sessionSourceSchema).default([]),
});
export type SessionContext = z.infer<typeof sessionContextSchema>;

export const sessionArtifactSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['checklist', 'note', 'draft', 'answer', 'summary', 'citation']),
  refId: z.string().min(1),
  title: z.string().min(1),
  createdAt: z.string().datetime(),
});
export type SessionArtifact = z.infer<typeof sessionArtifactSchema>;

export const sessionAgentSchema = z.object({
  providerId: z.string().nullable().default(null),
  model: z.string().nullable().default(null),
});
export type SessionAgent = z.infer<typeof sessionAgentSchema>;

export const conversationRoleSchema = z.enum(['student', 'motion']);
export type ConversationRole = z.infer<typeof conversationRoleSchema>;

export const conversationEntrySchema = z.object({
  id: z.string().min(1),
  role: conversationRoleSchema,
  text: z.string().min(1),
  at: z.string().datetime(),
});
export type ConversationEntry = z.infer<typeof conversationEntrySchema>;

export const activityKindSchema = z.enum([
  'plan',
  'tool',
  'result',
  'approval',
  'blocker',
  'user-override',
  'info',
]);
export type ActivityKind = z.infer<typeof activityKindSchema>;

export const activityEntrySchema = z.object({
  id: z.string().min(1),
  at: z.string().datetime(),
  kind: activityKindSchema,
  summary: z.string().min(1),
  sourceUrl: z.string().url().optional(),
});
export type ActivityEntry = z.infer<typeof activityEntrySchema>;

/** Caps on unbounded-growth arrays (VISION §26: bounded durable steps). */
export const CONVERSATION_CAP = 100;
export const ACTIVITY_CAP = 200;

export const sessionWorkspaceSchema = z.object({
  groupId: z.number().int().nullable().default(null),
  groupTitle: z.string().default(''),
  /**
   * Names the browser session that owns `ownedTabIds`/`adoptedTabIds`, exactly
   * as `src/core/workspace/ownership.ts` scopes workflow tab ownership: tab ids
   * are only meaningful within the session that issued them.
   */
  sessionKey: z.string().nullable().default(null),
  ownedTabIds: z.array(z.number().int().nonnegative()).default([]),
  adoptedTabIds: z.array(z.number().int().nonnegative()).default([]),
  /**
   * Tabs the student explicitly removed/closed/moved out of this session's
   * workspace. Kept so a later re-scan never silently re-adds one — "do not
   * fight the user" (VISION §5).
   */
  releasedTabIds: z.array(z.number().int().nonnegative()).default([]),
});
export type SessionWorkspace = z.infer<typeof sessionWorkspaceSchema>;

export const agentSessionSchema = z.object({
  id: z.string().min(1),
  /** Monotonic revision assigned by the repository's atomic session updater. */
  revision: z.number().int().nonnegative().default(0),
  /** e.g. "CP363 · Assignment 2" — see `sessionTitle`. */
  title: z.string().min(1),
  goal: z.string().min(1),
  courseId: z.string().nullable().default(null),
  taskId: z.string().nullable().default(null),
  status: sessionStatusSchema.default('active'),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  workspace: sessionWorkspaceSchema.default({}),
  plan: sessionPlanSchema.default({}),
  blockers: z.array(sessionBlockerSchema).default([]),
  context: sessionContextSchema.default({}),
  artifacts: z.array(sessionArtifactSchema).default([]),
  agent: sessionAgentSchema.default({}),
  conversation: z.array(conversationEntrySchema).max(CONVERSATION_CAP).default([]),
  activity: z.array(activityEntrySchema).max(ACTIVITY_CAP).default([]),
  workflowIds: z.array(z.string().min(1)).default([]),
  /** Bumps whenever a model turn is claimed or invalidated. */
  modelTurnGeneration: z.number().int().nonnegative().default(0),
  pendingModelRequest: z
    .object({
      key: z.string().min(1),
      providerId: z.string().min(1),
      startedAt: z.string().datetime(),
      generation: z.number().int().nonnegative().default(0),
      /**
       * Refreshed while the request is genuinely alive — during provider
       * retry waits and while streaming deltas arrive — so recovery (N5) can
       * tell a slow-but-live request from an abandoned one instead of only
       * looking at `startedAt`. Optional/additive: absent on rows written
       * before this field existed, in which case recovery falls back to
       * `startedAt`.
       */
      heartbeatAt: z.string().datetime().optional(),
    })
    .nullable()
    .default(null),
});
export type AgentSession = z.infer<typeof agentSessionSchema>;
