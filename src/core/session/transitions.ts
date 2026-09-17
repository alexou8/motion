import type { AgentSession, SessionStatus } from './types';

/**
 * Valid next statuses per current status. `archived` is terminal: an archived
 * session is history, not something the agent resumes into.
 */
const TRANSITIONS: Record<SessionStatus, readonly SessionStatus[]> = {
  active: ['working', 'waiting', 'paused', 'completed', 'archived'],
  working: ['waiting', 'paused', 'completed', 'active', 'archived'],
  waiting: ['working', 'active', 'paused', 'completed', 'archived'],
  paused: ['active', 'working', 'archived'],
  completed: ['archived', 'active'],
  archived: [],
};

export class InvalidSessionTransitionError extends Error {
  constructor(
    public readonly from: SessionStatus,
    public readonly to: SessionStatus,
  ) {
    super(`Cannot transition session from "${from}" to "${to}"`);
    this.name = 'InvalidSessionTransitionError';
  }
}

export function canTransitionSession(from: SessionStatus, to: SessionStatus): boolean {
  if (from === to) return true;
  return TRANSITIONS[from].includes(to);
}

/**
 * Applies a status transition, rejecting invalid moves rather than silently
 * clamping — a session's status drives what the side panel and the background
 * orchestrator are allowed to do with it, so a bad move must be loud.
 */
export function transitionSession(
  session: AgentSession,
  to: SessionStatus,
  now: string,
): AgentSession {
  if (!canTransitionSession(session.status, to)) {
    throw new InvalidSessionTransitionError(session.status, to);
  }
  if (session.status === to) return session;
  return { ...session, status: to, updatedAt: now };
}
