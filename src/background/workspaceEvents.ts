import { appendActivity, releaseTab, type AgentSession } from '@/core/session';
import { openDatabase } from '@/core/storage/db';
import { sessionRepository } from '@/core/storage/repositories';
import { ChromeTabs, NAVIGATION_MARKERS_KEY, type LiveTab, type TabsCapability } from '@/platform/tabs';

const TAB_GROUP_ID_NONE = -1;

function now(): string {
  return new Date().toISOString();
}

async function sessions(): Promise<{ db: IDBDatabase; records: AgentSession[] }> {
  const db = await openDatabase();
  const result = await sessionRepository(db).all();
  return { db, records: result.records };
}

async function persistChanged(
  db: IDBDatabase,
  changed: AgentSession[],
): Promise<void> {
  const repository = sessionRepository(db);
  for (const session of changed) await repository.put(session);
  db.close();
}

function isTracked(session: AgentSession, tabId: number): boolean {
  return session.workspace.ownedTabIds.includes(tabId) || session.workspace.adoptedTabIds.includes(tabId);
}

function isOutOfGroup(session: AgentSession, tab: chrome.tabs.Tab, changeInfo: chrome.tabs.TabChangeInfo): boolean {
  if (changeInfo.groupId === undefined || session.workspace.groupId === null) return false;
  const groupId = tab.groupId === undefined ? TAB_GROUP_ID_NONE : tab.groupId;
  return groupId !== session.workspace.groupId;
}

async function consumeNavigationMarker(tabId: number): Promise<boolean> {
  const stored = await chrome.storage.session.get(NAVIGATION_MARKERS_KEY);
  const raw = stored[NAVIGATION_MARKERS_KEY];
  if (typeof raw !== 'object' || raw === null) return false;

  const markers = Object.fromEntries(
    Object.entries(raw).filter(([key, value]) => key !== String(tabId) && typeof value === 'string'),
  );
  const hadMarker = Object.prototype.hasOwnProperty.call(raw, String(tabId));
  if (hadMarker) await chrome.storage.session.set({ [NAVIGATION_MARKERS_KEY]: markers });
  return hadMarker;
}

function convertOwnedToAdopted(session: AgentSession, tabId: number, timestamp: string): AgentSession {
  const workspace = session.workspace;
  if (!workspace.ownedTabIds.includes(tabId)) return session;
  const converted: AgentSession = {
    ...session,
    workspace: {
      ...workspace,
      ownedTabIds: workspace.ownedTabIds.filter((id) => id !== tabId),
      adoptedTabIds: workspace.adoptedTabIds.includes(tabId)
        ? workspace.adoptedTabIds
        : [...workspace.adoptedTabIds, tabId],
    },
    updatedAt: timestamp,
  };
  return appendActivity(
    converted,
    { id: `navigate-${tabId}-${timestamp}`, kind: 'user-override', summary: `Student navigated tab ${tabId}; Motion will no longer control it.` },
    timestamp,
  );
}

/** Releases a closed tab from every session that recorded it. */
export async function onTabRemoved(tabId: number): Promise<void> {
  const { db, records } = await sessions();
  const timestamp = now();
  const changed = records
    .filter((session) => isTracked(session, tabId))
    .map((session) => releaseTab(session, tabId, `Student closed tab ${tabId}.`, timestamp));
  await persistChanged(db, changed);
}

/** Applies student moves and navigations to durable workspace ownership. */
export async function onTabUpdated(
  tabId: number,
  changeInfo: chrome.tabs.TabChangeInfo,
  tab: chrome.tabs.Tab,
): Promise<void> {
  const navigated = changeInfo.url !== undefined;
  const motionNavigation = navigated ? await consumeNavigationMarker(tabId) : false;
  if (changeInfo.groupId === undefined && !navigated) return;

  const { db, records } = await sessions();
  const timestamp = now();
  const changed: AgentSession[] = [];
  for (const session of records) {
    if (!isTracked(session, tabId)) continue;

    let next = session;
    if (isOutOfGroup(session, tab, changeInfo)) {
      next = releaseTab(next, tabId, `Student moved tab ${tabId} out of the Motion workspace.`, timestamp);
    } else if (navigated && !motionNavigation && session.workspace.ownedTabIds.includes(tabId)) {
      next = convertOwnedToAdopted(next, tabId, timestamp);
    }
    if (next !== session) changed.push(next);
  }
  await persistChanged(db, changed);
}

/** Closes only live, owned tabs from the current browser session. */
export async function closeSessionWorkspace(
  session: AgentSession,
  tabs: TabsCapability = new ChromeTabs(),
): Promise<void> {
  const currentSessionKey = await tabs.sessionKey();
  if (session.workspace.sessionKey !== currentSessionKey) return;

  const adopted = new Set(session.workspace.adoptedTabIds);
  const released = new Set(session.workspace.releasedTabIds);
  const candidates = session.workspace.ownedTabIds.filter(
    (tabId) => !adopted.has(tabId) && !released.has(tabId),
  );
  if (candidates.length === 0) return;

  const live: number[] = [];
  for (const tabId of candidates) {
    const tab: LiveTab | null = await tabs.get(tabId);
    // A moved tab is student-controlled even if its event has not reached the
    // worker yet; never close it based on stale durable ownership.
    if (tab && (session.workspace.groupId === null || tab.groupId === session.workspace.groupId)) {
      live.push(tabId);
    }
  }
  await tabs.close(live);
}
