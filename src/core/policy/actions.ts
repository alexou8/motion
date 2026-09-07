import { z } from 'zod';

/**
 * The complete set of actions Motion can take. The workflow engine refuses any
 * action not listed here, so introducing a new capability requires editing this
 * table — and therefore passing through the risk classification below — rather
 * than being reachable from a new workflow definition alone.
 */
export const actionTypeSchema = z.enum([
  // --- low risk: local, reversible, no effect outside the browser ---
  'read-page',
  'create-note',
  'open-tab',
  'create-tab-group',
  'extract-deadlines',
  'extract-requirements',
  'organize-local-data',

  // --- medium risk: changes student-controlled state, still local ---
  'edit-draft',
  'create-checklist',
  'add-calendar-event',
  'prepare-message',

  // --- high risk: externally consequential, hits the LMS ---
  'post-discussion',
  'send-message-to-instructor',
  'submit-assignment',
  'act-in-graded-quiz',
  'modify-course-data',
]);
export type ActionType = z.infer<typeof actionTypeSchema>;

export const riskLevelSchema = z.enum(['low', 'medium', 'high']);
export type RiskLevel = z.infer<typeof riskLevelSchema>;

/**
 * Risk is a property of the action's consequence, not of where in the UI it was
 * triggered from. A "post" is high risk whether it originates in the side panel,
 * a workflow step, or a keyboard shortcut.
 */
const RISK: Record<ActionType, RiskLevel> = {
  'read-page': 'low',
  'create-note': 'low',
  'open-tab': 'low',
  'create-tab-group': 'low',
  'extract-deadlines': 'low',
  'extract-requirements': 'low',
  'organize-local-data': 'low',

  'edit-draft': 'medium',
  'create-checklist': 'medium',
  'add-calendar-event': 'medium',
  'prepare-message': 'medium',

  'post-discussion': 'high',
  'send-message-to-instructor': 'high',
  'submit-assignment': 'high',
  'act-in-graded-quiz': 'high',
  'modify-course-data': 'high',
};

export function riskOf(action: ActionType): RiskLevel {
  return RISK[action];
}

/**
 * Actions Motion will not perform, no matter what the student approves.
 *
 * These are not "high risk with a scarier dialog" — they are outside the
 * product. Submitting assessed work or acting inside a graded attempt would
 * make Motion the author of that work, which is the line the product does not
 * cross. Deleting or mutating remote course data is excluded because it is
 * irreversible from Motion and offers the student nothing Motion should own.
 *
 * The engine consults this before any approval record is even read, so a forged
 * or replayed approval cannot reach a prohibited action.
 */
export const PROHIBITED_ACTIONS: ReadonlySet<ActionType> = new Set<ActionType>([
  'submit-assignment',
  'act-in-graded-quiz',
  'modify-course-data',
]);

/**
 * Actions that exist in the risk table but are not implemented in the MVP.
 * Declared separately from `PROHIBITED_ACTIONS` because the distinction matters:
 * these are deferred pending a production-ready approval path, not refused on
 * principle. Keeping them here means the UI can explain "not yet" honestly
 * instead of pretending the capability does not exist.
 */
export const NOT_IN_MVP: ReadonlySet<ActionType> = new Set<ActionType>([
  'post-discussion',
  'send-message-to-instructor',
  'add-calendar-event',
  'prepare-message',
]);

export function isProhibited(action: ActionType): boolean {
  return PROHIBITED_ACTIONS.has(action);
}

export function isImplemented(action: ActionType): boolean {
  return !PROHIBITED_ACTIONS.has(action) && !NOT_IN_MVP.has(action);
}

export function requiresApproval(action: ActionType): boolean {
  return riskOf(action) !== 'low';
}
