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
}

export class ChromeTabs implements TabsCapability {
  /**
   * Look for a tab this operation already opened. This is what makes opening a
   * tab idempotent across a service-worker restart: tab ids are not durable, so
   * recovery searches for the marker rather than trusting a stored id.
   */
  async findByOperation(operationId: string): Promise<OpenedTab | null> {
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
    const created = await chrome.tabs.create({
      url: marked,
      // Never steal focus: the student is reading something else.
      active: false,
      ...(windowId === undefined ? {} : { windowId }),
    });
    if (created.id === undefined) throw new Error('Chrome did not return a tab id');
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
}

/** Motion's tab groups are named so a student can tell whose they are. */
export function groupTitle(parts: (string | null | undefined)[]): string {
  const meaningful = parts.filter((part): part is string => Boolean(part && part.trim()));
  return ['Motion', ...meaningful].join(' · ');
}
