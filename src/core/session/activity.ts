import {
  ACTIVITY_CAP,
  CONVERSATION_CAP,
  type ActivityEntry,
  type AgentSession,
  type ConversationEntry,
  type SessionBlocker,
} from './types';

function pushCapped<T>(list: T[], entry: T, cap: number): T[] {
  const next = [...list, entry];
  return next.length > cap ? next.slice(next.length - cap) : next;
}

export function appendActivity(
  session: AgentSession,
  entry: Omit<ActivityEntry, 'at'> & { at?: string },
  now: string,
): AgentSession {
  const full: ActivityEntry = { at: entry.at ?? now, ...entry };
  return {
    ...session,
    activity: pushCapped(session.activity, full, ACTIVITY_CAP),
    updatedAt: now,
  };
}

export function appendMessage(
  session: AgentSession,
  entry: Omit<ConversationEntry, 'at'> & { at?: string },
  now: string,
): AgentSession {
  const full: ConversationEntry = { at: entry.at ?? now, ...entry };
  return {
    ...session,
    conversation: pushCapped(session.conversation, full, CONVERSATION_CAP),
    updatedAt: now,
  };
}

export function recordBlocker(session: AgentSession, blocker: SessionBlocker, now: string): AgentSession {
  const withoutExisting = session.blockers.filter((b) => b.id !== blocker.id);
  return {
    ...session,
    blockers: [...withoutExisting, blocker],
    updatedAt: now,
  };
}

export function clearBlocker(session: AgentSession, blockerId: string, now: string): AgentSession {
  const blockers = session.blockers.filter((b) => b.id !== blockerId);
  if (blockers.length === session.blockers.length) return session;
  return { ...session, blockers, updatedAt: now };
}
