import { appendActivity } from './activity';
import type { AgentSession } from './types';

/**
 * Adopts a user-created tab into the session's workspace.
 *
 * Refuses to re-adopt a tab the student previously released (VISION §5: "do
 * not fight the user" — a released tab stays released until the session's
 * `sessionKey` changes, e.g. a fresh browser session).
 */
export function adoptTab(session: AgentSession, tabId: number, now: string): AgentSession {
  const { workspace } = session;
  if (workspace.releasedTabIds.includes(tabId)) return session;
  if (workspace.ownedTabIds.includes(tabId) || workspace.adoptedTabIds.includes(tabId)) {
    return session;
  }
  return {
    ...session,
    workspace: { ...workspace, adoptedTabIds: [...workspace.adoptedTabIds, tabId] },
    updatedAt: now,
  };
}

/**
 * Removes a tab from the session's workspace because the student closed,
 * moved, or otherwise removed it themselves. Logs a `user-override` activity
 * entry and records the tab as released so it is never silently re-added.
 */
export function releaseTab(
  session: AgentSession,
  tabId: number,
  reason: string,
  now: string,
): AgentSession {
  const { workspace } = session;
  const wasTracked =
    workspace.ownedTabIds.includes(tabId) || workspace.adoptedTabIds.includes(tabId);
  const released: AgentSession = {
    ...session,
    workspace: {
      ...workspace,
      ownedTabIds: workspace.ownedTabIds.filter((id) => id !== tabId),
      adoptedTabIds: workspace.adoptedTabIds.filter((id) => id !== tabId),
      releasedTabIds: workspace.releasedTabIds.includes(tabId)
        ? workspace.releasedTabIds
        : [...workspace.releasedTabIds, tabId],
    },
    updatedAt: now,
  };
  if (!wasTracked && workspace.releasedTabIds.includes(tabId)) return session;
  return appendActivity(
    released,
    { id: `release-${tabId}-${now}`, kind: 'user-override', summary: reason },
    now,
  );
}

/** Session-key-scoped ownership check, mirroring `src/core/workspace/ownership.ts`. */
export function isMotionOwned(session: AgentSession, tabId: number, sessionKey: string): boolean {
  if (session.workspace.sessionKey !== sessionKey) return false;
  return session.workspace.ownedTabIds.includes(tabId);
}

/** Marks a context source as excluded (student said "don't use that source"). */
export function excludeSource(session: AgentSession, url: string, now: string): AgentSession {
  let changed = false;
  const sources = session.context.sources.map((source) => {
    if (source.url !== url || source.excluded) return source;
    changed = true;
    return { ...source, excluded: true };
  });
  if (!changed) return session;
  return { ...session, context: { ...session.context, sources }, updatedAt: now };
}
