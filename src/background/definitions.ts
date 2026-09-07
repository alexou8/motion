import type { WorkflowDefinition } from '@/core/workflows';

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

export const WORKFLOW_DEFINITIONS: WorkflowDefinition[] = [prepareWorkspace, scanDeadlines];
