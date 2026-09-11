import type { OpenedTab, TabGroupPlan, TabsCapability } from '@/platform/tabs';

/**
 * An in-memory browser for testing tab behaviour without Chrome.
 *
 * Tabs and groups are plain records a test can rearrange, because the cases
 * that matter are the ones the *student* causes: dragging a tab into or out of
 * Motion's group, closing one, or restarting the browser.
 */
export interface FakeTab {
  url: string;
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
  private nextTabId = 10;
  private nextGroupId = 100;

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

  async sessionKey(): Promise<string> {
    return this.currentSession;
  }
}
