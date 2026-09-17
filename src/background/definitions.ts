import type { WorkflowDefinition } from '@/core/workflows';
import { actionTypeSchema, tierOf } from '@/core/policy';
import type { StepPlan } from '@/core/workflows';

/**
 * The workflows Motion can run.
 *
 * Step ids are stable identifiers, not positions: they are persisted and used
 * to resume, so renaming one is a breaking change that requires bumping
 * `version` and deciding what happens to in-flight workflows.
 */

/**
 * The reference journey: a student opens an assignment and asks Motion to set
 * up around it. Every step here is low risk — reading pages the student can
 * already see and opening tabs — so the whole workflow runs without a prompt.
 * The gated steps (building a checklist) come later, deliberately, so the
 * approval is asked for at the moment it means something.
 */
export const prepareWorkspace: WorkflowDefinition = {
  id: 'prepare-workspace',
  version: 1,
  title: 'Prepare workspace',
  description:
    'Opens the rubric and linked readings in their own tab group, and collects what the assignment asks for.',
  plan: (params) => {
    const url = typeof params['url'] === 'string' ? params['url'] : '';
    const sources = Array.isArray(params['sources']) ? params['sources'] : [];
    const courseCode = typeof params['courseCode'] === 'string' ? params['courseCode'] : null;
    const label = typeof params['label'] === 'string' ? params['label'] : 'Assignment';

    return [
      {
        id: 'read-assignment',
        title: 'Read the assignment page',
        action: 'read-page',
        input: { url },
      },
      {
        id: 'open-sources',
        title: 'Open the rubric and linked readings',
        action: 'open-tab',
        input: { urls: sources, courseCode, label },
      },
    ];
  },
};

/**
 * Scans pages the student is already authorized to see and collects due dates.
 * Read-only by construction: it cannot reach a capability that changes anything.
 */
export const scanDeadlines: WorkflowDefinition = {
  id: 'scan-deadlines',
  version: 1,
  title: 'Find upcoming deadlines',
  description: 'Reads this course’s assignment and quiz lists and collects what is due.',
  plan: (params) => {
    const url = typeof params['url'] === 'string' ? params['url'] : '';
    return [
      {
        id: 'read-list',
        title: 'Read the list page',
        action: 'read-page',
        input: { url },
      },
    ];
  },
};

const AGENT_STEP_ID = /^t\d+-\d+$/;

/**
 * A model turn is deliberately data, not executable code. `guardToolCall`
 * resolves every model reference before it gets here; this second validation
 * prevents a corrupt persisted workflow or a caller bypassing that guard from
 * turning the engine into an open-ended action dispatcher.
 */
function agentTurnPlan(params: Record<string, unknown>): StepPlan[] {
  if (typeof params['sessionId'] !== 'string' || params['sessionId'].trim() === '') {
    throw new Error('agent-turn requires a sessionId.');
  }
  if (!Number.isInteger(params['turnSeq']) || (params['turnSeq'] as number) < 0) {
    throw new Error('agent-turn requires a non-negative integer turnSeq.');
  }
  if (!Array.isArray(params['steps'])) throw new Error('agent-turn requires a steps array.');

  return params['steps'].map((candidate, index) => {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
      throw new Error(`agent-turn step ${index + 1} is not an object.`);
    }
    const step = candidate as Record<string, unknown>;
    if (typeof step['id'] !== 'string' || !AGENT_STEP_ID.test(step['id'])) {
      throw new Error(`agent-turn step ${index + 1} has an invalid stable id.`);
    }
    if (typeof step['title'] !== 'string' || step['title'].trim() === '') {
      throw new Error(`agent-turn step ${step['id']} has no title.`);
    }
    const action = actionTypeSchema.safeParse(step['action']);
    if (!action.success) throw new Error(`agent-turn step ${step['id']} has an unknown action.`);
    if (
      typeof step['input'] !== 'object' ||
      step['input'] === null ||
      Array.isArray(step['input'])
    ) {
      throw new Error(`agent-turn step ${step['id']} has invalid input.`);
    }
    const input = step['input'] as Record<string, unknown>;
    if (
      tierOf(action.data) === 'fresh-confirmation' &&
      (typeof input['target'] !== 'string' ||
        input['target'].trim() === '' ||
        typeof input['effect'] !== 'string' ||
        input['effect'].trim() === '')
    ) {
      throw new Error(`agent-turn step ${step['id']} needs a specific target and effect.`);
    }
    return {
      id: step['id'],
      title: step['title'],
      action: action.data,
      input,
    };
  });
}

export const agentTurn: WorkflowDefinition = {
  id: 'agent-turn',
  version: 1,
  title: 'Agent turn',
  description: 'Executes the concrete, policy-checked steps from one Motion agent turn.',
  plan: agentTurnPlan,
};

export const WORKFLOW_DEFINITIONS: WorkflowDefinition[] = [
  prepareWorkspace,
  scanDeadlines,
  agentTurn,
];
