import {
  type AdoptionRecord,
  type LiveTab,
  type OpenedTab,
  type TabGroupPlan,
  type TabsCapability,
} from '@/platform/tabs';

/**
 * An in-memory browser for testing tab behaviour without Chrome.
 *
 * Tabs and groups are plain records a test can rearrange, because the cases
 * that matter are the ones the *student* causes: dragging a tab into or out of
 * Motion's group, closing one, or restarting the browser.
 */
export interface FakeTab {
  url: string;
  title?: string;
  groupId: number | null;
  operationId: string | null;
}

export class FakeTabs implements TabsCapability {
  readonly tabs = new Map<number, FakeTab>();
  readonly groups = new Map<number, string>();
  opened = 0;
  /** Change to simulate a browser restart. */
  currentSession = 'session-1';
  /** Called before each tab is opened, so a test can interleave a student action. */
  beforeOpen: (() => Promise<void>) | null = null;
  /** Called while an adoption intent is being written. */
  onRecordAdopted: ((tabId: number, record: AdoptionRecord) => Promise<void> | void) | null = null;
  /** Called while the toolbar finds its target group. */
  onFindGroup: ((plan: TabGroupPlan) => Promise<void> | void) | null = null;
  private nextTabId = 10;
  private nextGroupId = 100;
  readonly adopted = new Map<number, AdoptionRecord>();
  readonly groupWindows = new Map<number, number>();

  /** A tab the student opened themselves. */
  addStudentTab(url: string, groupId: number | null = null): number {
    const id = this.nextTabId++;
    this.tabs.set(id, { url, groupId, operationId: null });
    return id;
  }

  async findByOperation(operationId: string): Promise<OpenedTab | null> {
    for (const [tabId, tab] of this.tabs) {
      if (tab.operationId === operationId) return { tabId, url: tab.url, operationId };
    }
    return null;
  }

  async open(url: string, operationId: string): Promise<OpenedTab> {
    const existing = await this.findByOperation(operationId);
    if (existing) return existing;
    if (this.beforeOpen) await this.beforeOpen();
    const tabId = this.nextTabId++;
    this.opened += 1;
    this.tabs.set(tabId, { url, groupId: null, operationId });
    return { tabId, url, operationId };
  }

  async ensureGroup(plan: TabGroupPlan, tabIds: number[]): Promise<number> {
    let groupId = [...this.groups].find(([, title]) => title === plan.title)?.[0];
    if (groupId === undefined) {
      groupId = this.nextGroupId++;
      this.groups.set(groupId, plan.title);
      this.groupWindows.set(groupId, plan.windowId ?? 1);
    }
    for (const id of tabIds) {
      const tab = this.tabs.get(id);
      if (tab) tab.groupId = groupId;
    }
    return groupId;
  }

  async findGroup(plan: TabGroupPlan): Promise<number | null> {
    const groupId = [...this.groups].find(([id, title]) =>
      title === plan.title && (plan.windowId === undefined || (this.groupWindows.get(id) ?? 1) === plan.windowId),
    )?.[0];
    if (this.onFindGroup) await this.onFindGroup(plan);
    return groupId ?? null;
  }

  async groupInto(existingGroupId: number | null, tabIds: number[], plan: TabGroupPlan): Promise<number> {
    if (tabIds.length === 0) throw new Error('No tabs to group');
    let groupId = existingGroupId;
    if (groupId !== null) {
      if (!this.groups.has(groupId)) throw new Error('Group no longer exists');
    } else {
      groupId = this.nextGroupId++;
      this.groups.set(groupId, plan.title);
      this.groupWindows.set(groupId, plan.windowId ?? 1);
    }
    for (const id of tabIds) {
      const tab = this.tabs.get(id);
      if (tab) tab.groupId = groupId;
    }
    return groupId;
  }

  async groupExists(groupId: number): Promise<boolean> {
    return this.groups.has(groupId);
  }

  async ownedTabsInGroup(groupId: number, tabIds: number[]): Promise<number[]> {
    return tabIds.filter((id) => this.tabs.get(id)?.groupId === groupId);
  }

  async tabsOpenedBy(operationPrefix: string): Promise<number[]> {
    return [...this.tabs]
      .filter(([, tab]) => tab.operationId?.startsWith(operationPrefix))
      .map(([id]) => id);
  }

  async close(tabIds: number[]): Promise<void> {
    for (const id of tabIds) this.tabs.delete(id);
  }

  async ungroup(tabIds: number[]): Promise<void> {
    for (const id of tabIds) {
      const tab = this.tabs.get(id);
      if (tab) tab.groupId = null;
    }
  }

  async get(tabId: number): Promise<LiveTab | null> {
    const tab = this.tabs.get(tabId);
    return tab ? { url: tab.url, title: tab.title ?? '', groupId: tab.groupId, windowId: 1 } : null;
  }

  async recordAdopted(tabId: number, record: AdoptionRecord): Promise<void> {
    if (this.adopted.get(tabId)?.state === 'adopted') return;
    this.adopted.set(tabId, record);
    if (this.onRecordAdopted) await this.onRecordAdopted(tabId, record);
  }

  async forgetAdopted(tabId: number): Promise<void> {
    if (this.adopted.get(tabId)?.state === 'adopted') return;
    this.adopted.delete(tabId);
  }

  async adoptedTabsInGroup(groupId: number, groupTitle: string): Promise<number[]> {
    return [...this.adopted]
      .filter(
        ([tabId, recorded]) =>
          ((recorded.state === 'adopted' && recorded.groupId === groupId)
            || (recorded.state === 'pending' && recorded.title === groupTitle))
          && this.tabs.get(tabId)?.groupId === groupId,
      )
      .map(([tabId]) => tabId);
  }

  async sessionKey(): Promise<string> {
    return this.currentSession;
  }
}
