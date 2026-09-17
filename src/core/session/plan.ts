import type { AgentSession, PlanStep } from './types';

/** Replaces the plan wholesale, activating the first pending step if any. */
export function setPlan(session: AgentSession, steps: PlanStep[], now: string): AgentSession {
  const firstPending = steps.find((s) => s.status === 'pending' || s.status === 'active');
  const normalized = steps.map((step) =>
    firstPending && step.id === firstPending.id && step.status === 'pending'
      ? { ...step, status: 'active' as const }
      : step,
  );
  return {
    ...session,
    plan: { steps: normalized, currentStepId: firstPending?.id ?? null },
    updatedAt: now,
  };
}

/** Marks the current step done and activates the next pending step, if any. */
export function advancePlanStep(session: AgentSession, now: string): AgentSession {
  const { steps, currentStepId } = session.plan;
  if (!currentStepId) return session;
  const currentIndex = steps.findIndex((s) => s.id === currentStepId);
  if (currentIndex === -1) return session;

  const nextIndex = steps.findIndex(
    (s, i) => i > currentIndex && (s.status === 'pending' || s.status === 'active'),
  );

  const updatedSteps = steps.map((step, i) => {
    if (i === currentIndex) return { ...step, status: 'done' as const };
    if (nextIndex !== -1 && i === nextIndex) return { ...step, status: 'active' as const };
    return step;
  });

  return {
    ...session,
    plan: { steps: updatedSteps, currentStepId: nextIndex !== -1 ? steps[nextIndex]!.id : null },
    updatedAt: now,
  };
}

/**
 * Resets `stepId` and every step after it back to `pending` (so "start over
 * on section 3" (VISION §6) discards their prior progress) and activates
 * `stepId`. Steps before it are left untouched.
 */
export function restartFromStep(session: AgentSession, stepId: string, now: string): AgentSession {
  const { steps } = session.plan;
  const index = steps.findIndex((s) => s.id === stepId);
  if (index === -1) return session;

  const updatedSteps = steps.map((step, i) => {
    if (i < index) return step;
    if (i === index) return { ...step, status: 'active' as const };
    return { ...step, status: 'pending' as const };
  });

  return {
    ...session,
    plan: { steps: updatedSteps, currentStepId: stepId },
    updatedAt: now,
  };
}
