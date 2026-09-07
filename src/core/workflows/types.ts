import { z } from 'zod';
import { actionTypeSchema, riskLevelSchema } from '../policy';

/**
 * Workflow state, shaped by one constraint: a Manifest V3 service worker is
 * killed without warning, mid-step, and several independent triggers (a
 * message, an alarm, startup recovery) can observe the same workflow at the
 * same moment. Every field below that looks like bookkeeping is load-bearing
 * for exactly that situation.
 */

export const stepStatusSchema = z.enum([
  'pending',
  'running',
  'awaiting-permission',
  'awaiting-approval',
  'done',
  'skipped',
  'blocked',
  'failed',
]);
export type StepStatus = z.infer<typeof stepStatusSchema>;

export const workflowStatusSchema = z.enum([
  'queued',
  'running',
  'awaiting-permission',
  'awaiting-approval',
  'retry-scheduled',
  'paused',
  'blocked',
  'failed',
  'cancelled',
  'completed',
]);
export type WorkflowStatus = z.infer<typeof workflowStatusSchema>;

/**
 * A side effect that reaches outside IndexedDB (opening a tab, creating a tab
 * group). IndexedDB and the Chrome APIs cannot commit together, so a crash
 * between them either duplicates the effect or loses it. Modelling the effect
 * as a durable intent makes the gap recoverable:
 *
 *   prepared   -- we intend to do this, and have written that down first
 *   applied    -- the Chrome call returned, and we recorded what it produced
 *   reconciled -- we have since confirmed real browser state matches
 *
 * On restart, a `prepared` intent is reconciled by *looking* for its evidence
 * (a marker the effect carries) rather than blindly retrying it.
 */
export const intentStateSchema = z.enum(['prepared', 'applied', 'reconciled']);
export type IntentState = z.infer<typeof intentStateSchema>;

export const intentSchema = z.object({
  /** Deterministic per (workflow, step, attempt) so a retry is recognisable. */
  key: z.string().min(1),
  state: intentStateSchema,
  /** What the effect produced, e.g. a tab id. Not durable across sessions. */
  evidence: z.record(z.unknown()).default({}),
  updatedAt: z.string().datetime(),
});
export type Intent = z.infer<typeof intentSchema>;

export const workflowStepSchema = z.object({
  /**
   * Stable across extension updates. Never an array index: inserting or
   * reordering steps in a new version would silently change what a persisted
   * index means and resume an old workflow into the wrong action.
   */
  id: z.string().min(1),
  title: z.string().min(1),
  action: actionTypeSchema,
  risk: riskLevelSchema,
  input: z.record(z.unknown()).default({}),
  status: stepStatusSchema.default('pending'),
  /**
   * Incremented each time the step is claimed. A completion is only accepted
   * if it carries the generation that claimed the step, so a zombie execution
   * resuming after a restart cannot overwrite a newer attempt's result.
   */
  attempt: z.number().int().nonnegative().default(0),
  result: z.string().nullable().default(null),
  error: z.string().nullable().default(null),
  sourcesVisited: z.array(z.string().url()).default([]),
  approvalId: z.string().nullable().default(null),
  intent: intentSchema.nullable().default(null),
  startedAt: z.string().datetime().nullable().default(null),
  finishedAt: z.string().datetime().nullable().default(null),
});
export type WorkflowStep = z.infer<typeof workflowStepSchema>;

/**
 * A short-lived exclusive claim on a workflow. Held in the database rather than
 * in memory, because an in-memory guard cannot survive the worker restart it
 * exists to protect against — which makes it not a control at all.
 */
export const leaseSchema = z.object({
  /** Identifies the execution that holds the claim. */
  owner: z.string().min(1),
  generation: z.number().int().nonnegative(),
  expiresAt: z.string().datetime(),
});
export type Lease = z.infer<typeof leaseSchema>;

/** A lease is deliberately short: a killed worker must not block progress for long. */
export const LEASE_TTL_MS = 30_000;

export const workflowSchema = z.object({
  id: z.string().min(1),
  definitionId: z.string().min(1),
  /**
   * The version of the definition this workflow was planned against. An update
   * that changes a definition must decide, per version, whether to upgrade an
   * in-flight workflow or cancel it — never silently reinterpret it.
   */
  definitionVersion: z.number().int().positive(),
  title: z.string().min(1),
  courseId: z.string().nullable().default(null),
  params: z.record(z.unknown()).default({}),
  steps: z.array(workflowStepSchema).min(1),
  status: workflowStatusSchema.default('queued'),
  /** Resume point, by stable id. Null once nothing remains. */
  currentStepId: z.string().nullable().default(null),
  lease: leaseSchema.nullable().default(null),
  /** When a retry is due. Scheduled with chrome.alarms, never setTimeout. */
  retryAt: z.string().datetime().nullable().default(null),
  tabGroupId: z.number().int().nullable().default(null),
  warnings: z.array(z.string()).default([]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Workflow = z.infer<typeof workflowSchema>;

export const MAX_ATTEMPTS = 3;

/** Backoff for a retryable failure. Bounded so a broken step cannot spin. */
export function retryDelayMs(attempt: number): number {
  return Math.min(60_000, 2 ** Math.max(0, attempt - 1) * 5_000);
}

/**
 * Terminal states. Reached only deliberately; recovery never resurrects one.
 */
export const TERMINAL_STATUSES: readonly WorkflowStatus[] = [
  'completed',
  'failed',
  'cancelled',
];

export function isTerminal(status: WorkflowStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/**
 * Valid state transitions. Declared as data so the engine can reject an
 * invalid move loudly instead of drifting into an unrepresentable state, and
 * so the transition table itself is testable.
 */
export const ALLOWED_TRANSITIONS: Record<WorkflowStatus, readonly WorkflowStatus[]> = {
  queued: ['running', 'cancelled', 'paused'],
  running: [
    'running',
    'awaiting-permission',
    'awaiting-approval',
    'retry-scheduled',
    'paused',
    'blocked',
    'failed',
    'cancelled',
    'completed',
  ],
  'awaiting-permission': ['running', 'paused', 'cancelled', 'failed'],
  'awaiting-approval': ['running', 'paused', 'cancelled', 'failed', 'completed'],
  'retry-scheduled': ['running', 'paused', 'cancelled', 'failed'],
  paused: ['running', 'cancelled'],
  blocked: ['running', 'paused', 'cancelled', 'failed'],
  failed: ['running'],
  cancelled: [],
  completed: [],
};

export function canTransition(from: WorkflowStatus, to: WorkflowStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export interface StepPlan {
  id: string;
  title: string;
  action: z.infer<typeof actionTypeSchema>;
  input?: Record<string, unknown>;
}

export interface WorkflowDefinition {
  id: string;
  version: number;
  title: string;
  description: string;
  plan(params: Record<string, unknown>): StepPlan[];
}
