import { resolveTaskForGoal } from '../session';
import { resourcesForTask } from '../graph';
import type { CourseLink } from '../graph';
import type { Course, CourseTask } from '../domain';
import type { ToolCall } from './tools';

/**
 * A deterministic, model-free plan (VISION §20 "sessions are useful without
 * AI"). When no provider is available, Motion should still be able to open
 * everything it already knows about for a task rather than sit idle — this
 * is what runs then, clearly labelled as not AI-assisted.
 */

export interface FallbackContext {
  tasks: CourseTask[];
  courses: Course[];
  links: CourseLink[];
}

export interface FallbackPlanStep {
  title: string;
  call: ToolCall;
}

export interface FallbackPlanResult {
  reply: string;
  plan: FallbackPlanStep[];
  taskId: string | null;
  usedAi: false;
}

const NO_MODEL_NOTICE =
  "No AI provider is available right now, so this is a plan built from what Motion already knows — no model was used.";

/**
 * `fallbackPlan("work on <task>", context)` resolves the task deterministically
 * (`resolveTaskForGoal`), then opens the resources Motion already has for it:
 * assignment resources, instructions, the rubric (if a rubric link exists),
 * and a checklist.
 */
export function fallbackPlan(goal: string, context: FallbackContext): FallbackPlanResult {
  const resolution = resolveTaskForGoal(goal, context.tasks, context.courses);

  if (!resolution.task) {
    const reply =
      resolution.ambiguous.length > 0
        ? `${NO_MODEL_NOTICE} Motion found more than one possible match for "${goal}" and needs you to say which one you mean: ${resolution.ambiguous
            .map((t) => t.title)
            .join(', ')}.`
        : `${NO_MODEL_NOTICE} Motion couldn't work out which task "${goal}" refers to. Try naming the course and assignment.`;
    return { reply, plan: [], taskId: null, usedAi: false };
  }

  const task = resolution.task;
  const plan: FallbackPlanStep[] = [
    { title: 'Open assignment resources', call: { tool: 'open_assignment_resources', taskRef: task.id } },
    { title: 'Read assignment instructions', call: { tool: 'read_assignment_instructions' } },
  ];

  // Fallback mode runs without a refs table (no model turn to build one for),
  // so it references the link by Motion's own stable link id directly. The
  // caller (background) is responsible for resolving this the same way it
  // would resolve a normal `linkRef` before executing the step.
  const rubricLink = resourcesForTask(context.links, task.id).find((link) => link.relation === 'has-rubric');
  if (rubricLink) {
    plan.push({ title: 'Read rubric', call: { tool: 'read_rubric', linkRef: rubricLink.id } });
  }

  plan.push({ title: 'Build checklist', call: { tool: 'build_checklist' } });

  return {
    reply: `${NO_MODEL_NOTICE} Motion will open what it has for "${task.title}" and build a checklist.`,
    plan,
    taskId: task.id,
    usedAi: false,
  };
}
