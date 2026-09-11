/**
 * Tab and tab-group capabilities.
 *
 * These are semantic operations ("open this course resource in Motion's group
 * for the assignment"), not thin wrappers over `chrome.tabs`. Keeping the
 * boundary semantic means URL validation, group reconciliation and ownership
 * rules live in one place instead of leaking into every workflow.
 */

/** Tabs Motion opened carry this so they are identifiable after a restart. */
const MOTION_MARKER = 'motion_op';

/**
 * Session-storage keys. Session storage survives a worker restart and is
 * cleared when the browser restarts — exactly the lifetime of a tab id, which
 * is why tab ids are recorded there and nowhere longer-lived.
 */
const BROWSER_SESSION_KEY = 'motion:browser-session';
const OPERATION_KEY_PREFIX = 'motion:op:';

const operationKey = (operationId: string): string => `${OPERATION_KEY_PREFIX}${operationId}`;

/** Session record for an operation whose tab is being created right now. */
const PENDING = 'pending';

export interface OpenedTab {
  tabId: number;
  url: string;
  /** The operation that opened it, recoverable from the URL after a restart. */
  operationId: string;
}

export interface TabGroupPlan {
  /** e.g. "Motion · CP363 · Assignment 2" */
  title: string;
  color: chrome.tabGroups.ColorEnum;
  windowId?: number;
}

/**
 * Only https URLs on hosts Motion has permission for are ever opened. A URL
 * extracted from a page is attacker-influenced: `javascript:` and `data:` must
 * never reach `tabs.create`.
 */
export function isOpenableUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Stamps an operation id on a URL so the tab it opens stays identifiable. */
export function markUrl(url: string, operationId: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set(MOTION_MARKER, operationId);
  return parsed.toString();
}

export function operationIdOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).searchParams.get(MOTION_MARKER);
  } catch {
    return null;
  }
}

export interface TabsCapability {
  findByOperation(operationId: string): Promise<OpenedTab | null>;
  open(url: string, operationId: string, windowId?: number): Promise<OpenedTab>;
  ensureGroup(plan: TabGroupPlan, tabIds: number[]): Promise<number>;
  groupExists(groupId: number): Promise<boolean>;
  /** Of `tabIds`, the ones that still exist and are still in `groupId`. */
  ownedTabsInGroup(groupId: number, tabIds: number[]): Promise<number[]>;
  /** Live tabs this browser session recorded opening under an operation id with this prefix. */
  tabsOpenedBy(operationPrefix: string): Promise<number[]>;
  close(tabIds: number[]): Promise<void>;
  /**
   * Identifies the current browser session. A tab id recorded under a
   * different key belongs to a session that has ended, and Chrome may already
   * have handed the same number to an unrelated tab.
   */
  sessionKey(): Promise<string>;
}

export class ChromeTabs implements TabsCapability {
  /**
   * Look for a tab this operation already opened. This is what makes opening a
   * tab idempotent across a service-worker restart.
   *
   * Only operations this browser session started are recognised. The session
   * record names the tab once it exists — which survives an LMS redirect that
   * drops the marker. Before that, it reads `PENDING`, and only then is the URL
   * marker trusted, to cover the moment between Chrome creating the tab and
   * Motion recording it. With no record at all, a tab carrying the marker was
   * restored by the browser from an earlier session: it is the student's now,
   * and adopting it would let Motion later close it.
   */
  async findByOperation(operationId: string): Promise<OpenedTab | null> {
    const key = operationKey(operationId);
    const recorded = (await chrome.storage.session.get(key))[key];
    if (typeof recorded === 'number') {
      const tab = await chrome.tabs.get(recorded).catch(() => undefined);
      if (tab?.id !== undefined) return { tabId: tab.id, url: tab.url ?? '', operationId };
    }
    if (recorded !== PENDING) return null;

    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (tab.id === undefined || !tab.url) continue;
      if (operationIdOf(tab.url) === operationId) {
        return { tabId: tab.id, url: tab.url, operationId };
      }
    }
    return null;
  }

  async open(url: string, operationId: string, windowId?: number): Promise<OpenedTab> {
    if (!isOpenableUrl(url)) {
      throw new Error(`Refusing to open a non-https URL: ${url.slice(0, 40)}`);
    }
    const existing = await this.findByOperation(operationId);
    if (existing) return existing;

    const marked = markUrl(url, operationId);
    // Written before the tab exists, so a crash mid-create leaves evidence
    // that this session started the operation (see findByOperation).
    await chrome.storage.session.set({ [operationKey(operationId)]: PENDING });
    const created = await chrome.tabs.create({
      url: marked,
      // Never steal focus: the student is reading something else.
      active: false,
      ...(windowId === undefined ? {} : { windowId }),
    });
    if (created.id === undefined) throw new Error('Chrome did not return a tab id');
    await chrome.storage.session.set({ [operationKey(operationId)]: created.id });
    return { tabId: created.id, url: marked, operationId };
  }

  /**
   * Create or reuse Motion's group for this work, then add the tabs to it.
   *
   * Group ids are session-scoped and a student may rename, move or ungroup at
   * will, so the group is located by title within the window and its actual
   * membership is reconciled before mutation. Tabs the student moved out are
   * left where the student put them.
   */
  async ensureGroup(plan: TabGroupPlan, tabIds: number[]): Promise<number> {
    if (tabIds.length === 0) throw new Error('No tabs to group');

    const existingGroups = await chrome.tabGroups.query({
      title: plan.title,
      ...(plan.windowId === undefined ? {} : { windowId: plan.windowId }),
    });
    const existing = existingGroups[0];

    if (existing) {
      const alreadyIn = await chrome.tabs.query({ groupId: existing.id });
      const present = new Set(alreadyIn.map((tab) => tab.id));
      const missing = tabIds.filter((id) => !present.has(id));
      if (missing.length > 0) {
        await chrome.tabs.group({ groupId: existing.id, tabIds: missing });
      }
      return existing.id;
    }

    const groupId = await chrome.tabs.group({ tabIds });
    await chrome.tabGroups.update(groupId, { title: plan.title, color: plan.color });
    return groupId;
  }

  async groupExists(groupId: number): Promise<boolean> {
    try {
      await chrome.tabGroups.get(groupId);
      return true;
    } catch {
      return false;
    }
  }

  async ownedTabsInGroup(groupId: number, tabIds: number[]): Promise<number[]> {
    const wanted = new Set(tabIds);
    const tabs = await chrome.tabs.query({ groupId });
    return tabs.flatMap((tab) => (tab.id !== undefined && wanted.has(tab.id) ? [tab.id] : []));
  }

  /**
   * Session records only, deliberately not URL markers: Chrome restores tabs
   * with their URLs after a restart, so a marker can outlive the session that
   * set it and would claim tabs the student now considers their own.
   */
  async tabsOpenedBy(operationPrefix: string): Promise<number[]> {
    const records = await chrome.storage.session.get(null);
    const recorded = new Set<number>();
    for (const [key, value] of Object.entries(records)) {
      if (key.startsWith(operationKey(operationPrefix)) && typeof value === 'number') {
        recorded.add(value);
      }
    }
    if (recorded.size === 0) return [];
    const live = await chrome.tabs.query({});
    return live.flatMap((tab) => (tab.id !== undefined && recorded.has(tab.id) ? [tab.id] : []));
  }

  async close(tabIds: number[]): Promise<void> {
    if (tabIds.length > 0) await chrome.tabs.remove(tabIds);
  }

  /**
   * Two first calls racing can each write a key; the loser's records then
   * read as another session's and own nothing. That fails safe — Motion
   * closes less, never more.
   */
  async sessionKey(): Promise<string> {
    const stored = (await chrome.storage.session.get(BROWSER_SESSION_KEY))[BROWSER_SESSION_KEY];
    if (typeof stored === 'string') return stored;
    const created = crypto.randomUUID();
    await chrome.storage.session.set({ [BROWSER_SESSION_KEY]: created });
    return created;
  }
}

/** Motion's tab groups are named so a student can tell whose they are. */
export function groupTitle(parts: (string | null | undefined)[]): string {
  const meaningful = parts.filter((part): part is string => Boolean(part && part.trim()));
  return ['Motion', ...meaningful].join(' · ');
}
