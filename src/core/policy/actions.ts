import { z } from 'zod';

/**
 * The complete set of actions Motion can take. The workflow engine refuses any
 * action not listed here, so introducing a new capability requires editing this
 * table — and therefore passing through the tier classification below — rather
 * than being reachable from a new workflow definition alone.
 *
 * Grouped by consequence tier (ARCH.md D5). Existing ids are never removed —
 * persisted workflows reference them by name — only added to.
 */
export const actionTypeSchema = z.enum([
  // --- automatic / low consequence: local, reversible, no effect outside the browser ---
  'read-page',
  'inspect-tab',
  'create-note',
  'extract-deadlines',
  'extract-requirements',
  'create-checklist',
  'open-tab',
  'create-tab-group',
  'navigate-owned-tab',
  'gather-material',
  'generate-draft',
  'analyze-rubric',
  'summarize',
  'organize-local-data',
  'scroll-to',
  'focus-element',

  // --- configurable / medium consequence: changes student-controlled or remote-draft state ---
  'edit-draft',
  'fill-form-field',
  'select-option',
  'toggle-control',
  'save-remote-draft',
  'prepare-upload',
  'prepare-discussion-response',
  'add-calendar-event',
  'prepare-message',
  'click-element',

  // --- fresh-confirmation / consequential: final, externally visible, hits the LMS ---
  'upload-file',
  'post-discussion',
  'send-message',
  'send-message-to-instructor',
  'finalize-remote-draft',
  'submit-assignment',
  'overwrite-remote-content',
  'modify-course-data',

  // --- forbidden: outside the product, no matter what is approved ---
  'act-in-graded-quiz',
]);
export type ActionType = z.infer<typeof actionTypeSchema>;

export const riskLevelSchema = z.enum(['low', 'medium', 'high']);
export type RiskLevel = z.infer<typeof riskLevelSchema>;

/**
 * Consequence-based policy tiers (ARCH.md D5), replacing the old binary of
 * "allowed" vs. "prohibited forever". A tier is a property of the action's
 * consequence, not of where in the UI it was triggered from.
 */
export const policyTierSchema = z.enum(['automatic', 'configurable', 'fresh-confirmation', 'forbidden']);
export type PolicyTier = z.infer<typeof policyTierSchema>;

/**
 * Canonical policy classification for every executable action. Consumers that
 * need a tier subset (for example Settings' ongoing configurable consent)
 * derive it here rather than maintaining a second hand-written action list.
 */
export const ACTIONS = {
  'read-page': 'automatic',
  'inspect-tab': 'automatic',
  'create-note': 'automatic',
  'extract-deadlines': 'automatic',
  'extract-requirements': 'automatic',
  'create-checklist': 'automatic',
  'open-tab': 'automatic',
  'create-tab-group': 'automatic',
  'navigate-owned-tab': 'automatic',
  'gather-material': 'automatic',
  'generate-draft': 'automatic',
  'analyze-rubric': 'automatic',
  summarize: 'automatic',
  'organize-local-data': 'automatic',
  'scroll-to': 'automatic',
  'focus-element': 'automatic',

  'edit-draft': 'configurable',
  'fill-form-field': 'configurable',
  'select-option': 'configurable',
  'toggle-control': 'configurable',
  'save-remote-draft': 'configurable',
  'prepare-upload': 'configurable',
  'prepare-discussion-response': 'configurable',
  'add-calendar-event': 'configurable',
  'prepare-message': 'configurable',
  'click-element': 'configurable',

  'upload-file': 'fresh-confirmation',
  'post-discussion': 'fresh-confirmation',
  'send-message': 'fresh-confirmation',
  'send-message-to-instructor': 'fresh-confirmation',
  'finalize-remote-draft': 'fresh-confirmation',
  'submit-assignment': 'fresh-confirmation',
  'overwrite-remote-content': 'fresh-confirmation',
  'modify-course-data': 'fresh-confirmation',

  'act-in-graded-quiz': 'forbidden',
} as const satisfies Record<ActionType, PolicyTier>;

export type ConfigurableActionId = {
  [Action in keyof typeof ACTIONS]: (typeof ACTIONS)[Action] extends 'configurable' ? Action : never;
}[keyof typeof ACTIONS];

/** The only ids a persistent configurable-consent preference may contain. */
export const CONFIGURABLE_ACTION_IDS = actionTypeSchema.options.filter(
  (action): action is ConfigurableActionId => ACTIONS[action] === 'configurable',
) as [ConfigurableActionId, ...ConfigurableActionId[]];

/** Strict runtime schema paired with the policy-derived configurable subset. */
export const configurableActionIdSchema = z.enum(CONFIGURABLE_ACTION_IDS);

export function tierOf(action: ActionType): PolicyTier {
  return ACTIONS[action];
}

/**
 * Legacy three-level risk, kept for callers (UI copy, approval TTL selection)
 * that were written against it. Derived mechanically from the tier so the two
 * never drift: automatic -> low, configurable -> medium, fresh-confirmation
 * and forbidden -> high.
 */
export function riskOf(action: ActionType): RiskLevel {
  switch (tierOf(action)) {
    case 'automatic':
      return 'low';
    case 'configurable':
      return 'medium';
    case 'fresh-confirmation':
    case 'forbidden':
      return 'high';
  }
}

/**
 * Actions Motion will not perform, no matter what the student approves.
 *
 * Statically, this is only `act-in-graded-quiz`: answering or selecting inside
 * an active graded/timed/proctored attempt would make Motion the author of
 * that work, which is the line the product does not cross. `policyDecision`
 * below extends this dynamically — any non-read action whose target tab is a
 * restricted assessment context is forbidden too, even though the action
 * itself (e.g. `fill-form-field`) is not statically prohibited elsewhere.
 *
 * The engine consults this before any approval record is even read, so a
 * forged or replayed approval cannot reach a prohibited action.
 */
export const PROHIBITED_ACTIONS: ReadonlySet<ActionType> = new Set<ActionType>(
  actionTypeSchema.options.filter((action) => tierOf(action) === 'forbidden'),
);

export function isProhibited(action: ActionType): boolean {
  return tierOf(action) === 'forbidden';
}

export function isImplemented(action: ActionType): boolean {
  return !isProhibited(action);
}

export function requiresApproval(action: ActionType): boolean {
  return tierOf(action) !== 'automatic';
}

/**
 * The verdict the engine must reach before running a step. Computed fresh
 * every time from the action's tier plus the caller-supplied context — it is
 * never stored, so a stale cached decision cannot outlive the context that
 * produced it.
 */
export type PolicyDecisionResult =
  | { decision: 'allow'; reason: string }
  | { decision: 'needs-approval'; reason: string }
  | { decision: 'needs-fresh-approval'; reason: string }
  | { decision: 'forbid'; reason: string };

export interface PolicyDecisionInput {
  action: ActionType;
  /** Whether the step's target tab is currently a restricted assessment context. */
  assessmentRestricted: boolean;
  /** Configurable actions the student has opted into running automatically. */
  allowedConfigurable: ReadonlySet<ActionType>;
}

/**
 * `policyDecision` is the single place that turns a tier plus live context
 * into a verdict. Forbidding is checked first and unconditionally: a graded
 * attempt makes every non-read action forbidden regardless of its own tier,
 * and that check never looks at an approval record.
 */
export function policyDecision(input: PolicyDecisionInput): PolicyDecisionResult {
  const { action, assessmentRestricted, allowedConfigurable } = input;
  const tier = tierOf(action);

  if (tier === 'forbidden') {
    return { decision: 'forbid', reason: `Motion does not perform "${action}".` };
  }

  if (assessmentRestricted && action !== 'read-page') {
    return {
      decision: 'forbid',
      reason:
        'This looks like a graded attempt. Motion will not read, draft, or act here beyond reading the page.',
    };
  }

  switch (tier) {
    case 'automatic':
      return { decision: 'allow', reason: 'Automatic: low consequence, reversible, local.' };
    case 'configurable':
      return allowedConfigurable.has(action)
        ? { decision: 'allow', reason: 'You enabled this action to run automatically.' }
        : {
            decision: 'needs-approval',
            reason: 'This changes state and needs your approval (or your ongoing consent in settings).',
          };
    case 'fresh-confirmation':
      return {
        decision: 'needs-fresh-approval',
        reason: 'This is a final, consequential action and needs a fresh, target-specific confirmation.',
      };
  }
}
