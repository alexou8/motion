import { z } from 'zod';
import { actionTypeSchema, isProhibited, riskLevelSchema, riskOf, type ActionType } from './actions';

export const approvalStatusSchema = z.enum(['pending', 'approved', 'denied', 'expired']);
export type ApprovalStatus = z.infer<typeof approvalStatusSchema>;

/**
 * A high-risk confirmation is only valid for a short window. The window exists
 * because MV3 service workers restart freely: without it, a student who
 * approved a post an hour ago and then closed the laptop could have that
 * approval consumed by a workflow resuming later, with no one watching.
 */
export const HIGH_RISK_TTL_MS = 2 * 60 * 1000;

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
  /** What Motion wants to do, in one plain sentence. */
  summary: z.string().min(1),
  /** The specific target: which page, which course, which draft. */
  target: z.string().min(1),
  /** What changes if this is allowed, and whether it can be undone. */
  effect: z.string().min(1),
  reversible: z.boolean(),
  /** The exact payload that will be used, shown verbatim before approving. */
  payload: z.record(z.unknown()).default({}),
  status: approvalStatusSchema.default('pending'),
  requestedAt: z.string().datetime(),
  decidedAt: z.string().datetime().nullable().default(null),
  expiresAt: z.string().datetime().nullable().default(null),
});
export type ApprovalRequest = z.infer<typeof approvalRequestSchema>;

export function approvalExpiry(action: ActionType, now: Date): string | null {
  return riskOf(action) === 'high' ? new Date(now.getTime() + HIGH_RISK_TTL_MS).toISOString() : null;
}

/**
 * Whether an approval may be acted on right now.
 *
 * Deliberately conservative: a prohibited action is never usable even when a
 * stored record claims approval, so a corrupted or tampered database cannot
 * unlock a capability the product does not have.
 */
export function isApprovalUsable(
  request: ApprovalRequest,
  now: Date,
): { usable: true } | { usable: false; reason: string } {
  if (isProhibited(request.action)) {
    return { usable: false, reason: 'This action is not something Motion performs.' };
  }
  if (request.status !== 'approved') {
    return { usable: false, reason: `Approval is ${request.status}, not approved.` };
  }
  if (request.expiresAt && new Date(request.expiresAt).getTime() <= now.getTime()) {
    return { usable: false, reason: 'This confirmation expired. Motion will ask again.' };
  }
  return { usable: true };
}
