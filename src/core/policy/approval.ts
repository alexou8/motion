import { z } from 'zod';
import {
  actionTypeSchema,
  policyTierSchema,
  riskLevelSchema,
  riskOf,
  tierOf,
  type ActionType,
} from './actions';

export const approvalStatusSchema = z.enum(['pending', 'approved', 'denied', 'expired']);
export type ApprovalStatus = z.infer<typeof approvalStatusSchema>;

/**
 * A fresh-confirmation approval is only valid for a short window. The window
 * exists because MV3 service workers restart freely: without it, a student
 * who approved a submission an hour ago and then closed the laptop could have
 * that approval consumed by a workflow resuming later, with no one watching.
 */
export const FRESH_APPROVAL_TTL_MS = 2 * 60 * 1000;
/** @deprecated use {@link FRESH_APPROVAL_TTL_MS}; kept for existing callers. */
export const HIGH_RISK_TTL_MS = FRESH_APPROVAL_TTL_MS;

/**
 * What the student is being asked to allow. `summary` and `effect` are written
 * for a person, not a log: an approval prompt that a student cannot evaluate is
 * not informed consent, which is the whole point of the gate.
 */
export const approvalRequestSchema = z.object({
  id: z.string().min(1),
  workflowId: z.string().min(1),
  stepId: z.string().min(1),
  action: actionTypeSchema,
  risk: riskLevelSchema,
  /**
   * The tier this approval was requested under. Optional so approvals written
   * before this field existed keep parsing; code that needs it falls back to
   * `tierOf(action)`.
   */
  tier: policyTierSchema.optional(),
  /** What Motion wants to do, in one plain sentence. */
  summary: z.string().min(1),
  /** The specific target: which page, which course, which draft. */
  target: z.string().min(1),
  /** What changes if this is allowed, and whether it can be undone. */
  effect: z.string().min(1),
  reversible: z.boolean(),
  /** The exact payload that will be used, shown verbatim before approving. */
  payload: z.record(z.unknown()).default({}),
  /**
   * A deterministic hash of (action, target, canonical payload), computed by
   * {@link targetDigest}. This is an *integrity binding*, not a security MAC:
   * it exists so a stale or replayed approval cannot silently authorize a
   * different payload than the one the student looked at, not to resist a
   * motivated adversary with write access to the approval store.
   */
  targetDigest: z.string().optional(),
  /** The step's attempt number this approval was requested for. A retry gets a new attempt and therefore a new approval. */
  stepAttempt: z.number().int().nonnegative().optional(),
  status: approvalStatusSchema.default('pending'),
  requestedAt: z.string().datetime(),
  decidedAt: z.string().datetime().nullable().default(null),
  expiresAt: z.string().datetime().nullable().default(null),
  /** Single-use marker: once set, this approval can never be consumed again. */
  consumedAt: z.string().datetime().nullable().optional(),
});
export type ApprovalRequest = z.infer<typeof approvalRequestSchema>;

export function approvalExpiry(action: ActionType, now: Date): string | null {
  return riskOf(action) === 'high' ? new Date(now.getTime() + FRESH_APPROVAL_TTL_MS).toISOString() : null;
}

/**
 * Deterministic canonical-JSON hash (FNV-1a over a stable stringification, no
 * crypto dependency needed since this never needs to resist a motivated
 * forger — see {@link approvalRequestSchema.targetDigest}). Object keys are
 * sorted so two equivalent payloads always hash the same regardless of
 * construction order.
 */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalize(entry)).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(',')}}`;
}

function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export interface TargetDigestInput {
  action: ActionType;
  target: string;
  payload: Record<string, unknown>;
}

/**
 * A stable hash binding an approval to exactly the action/target/payload the
 * student was shown. The engine recomputes this against the step's *current*
 * input before consuming an approval; a mismatch (the payload changed since
 * the approval was granted) means the approval cannot be used — see
 * VISION.md §10, "approval for payload A cannot execute payload B".
 */
export function targetDigest(input: TargetDigestInput): string {
  return fnv1a(canonicalize({ action: input.action, target: input.target, payload: input.payload }));
}

export interface ApprovalUsabilityBinding {
  /** The digest of the step's current input, to compare against the approval's. */
  targetDigest: string;
  /** The attempt number the step is about to run as. */
  stepAttempt: number;
}

/**
 * Whether an approval may be acted on right now.
 *
 * Deliberately conservative: a forbidden-tier action is never usable even
 * when a stored record claims approval, so a corrupted or tampered database
 * cannot unlock a capability the product does not have. When `binding` is
 * supplied (the engine always supplies it before executing a gated step), the
 * approval must also match the step's current digest and attempt — a stale,
 * replayed, or retargeted approval is rejected rather than honoured.
 */
export function isApprovalUsable(
  request: ApprovalRequest,
  now: Date,
  binding?: ApprovalUsabilityBinding,
): { usable: true } | { usable: false; reason: string } {
  const tier = request.tier ?? tierOf(request.action);
  if (tier === 'forbidden') {
    return { usable: false, reason: 'This action is not something Motion performs.' };
  }
  if (request.status !== 'approved') {
    return { usable: false, reason: `Approval is ${request.status}, not approved.` };
  }
  if (request.consumedAt) {
    return { usable: false, reason: 'This approval was already used and cannot be used again.' };
  }
  // A fresh confirmation without an expiry is malformed (legacy or tampered):
  // it must never read as "valid forever".
  if (tier === 'fresh-confirmation' && !request.expiresAt) {
    return { usable: false, reason: 'This confirmation has no time limit recorded. Motion will ask again.' };
  }
  if (request.expiresAt && new Date(request.expiresAt).getTime() <= now.getTime()) {
    return { usable: false, reason: 'This confirmation expired. Motion will ask again.' };
  }
  if (binding) {
    if (!request.targetDigest || request.targetDigest !== binding.targetDigest) {
      return {
        usable: false,
        reason: 'What Motion is about to do no longer matches what you approved. Motion will ask again.',
      };
    }
    if (request.stepAttempt === undefined || request.stepAttempt !== binding.stepAttempt) {
      return {
        usable: false,
        reason: 'This approval was for an earlier attempt at this step. Motion will ask again.',
      };
    }
  }
  return { usable: true };
}

/**
 * Marks an approval as consumed. Pure: the caller is responsible for
 * persisting the result. The engine folds the *authoritative* single-use
 * guarantee into the same compare-and-swap commit that claims the workflow
 * step (see engine.ts `runStep`), because two independent stores (the
 * workflow store and the approval store) cannot be written atomically
 * together; this function's output is the durable record of that fact for
 * audit and UI purposes, not itself the concurrency control.
 */
export function consumeApproval(request: ApprovalRequest, now: Date): ApprovalRequest {
  return { ...request, consumedAt: now.toISOString() };
}
