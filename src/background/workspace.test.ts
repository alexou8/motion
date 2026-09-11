import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase, deleteDatabase } from '@/core/storage/db';
import { IndexedDbWorkflowStore } from '@/core/storage/workflowStore';
import { FakeTabs } from '@/test/fakeTabs';
import { handleActionClick, handleCloseWorkspace, handleMessage, handlePrepareWorkspace } from './router';

/**
 * "Prepare workspace" through the worker, against an in-memory browser.
 * Course content is synthetic.
 */

const ACTIVE_TAB = 3;
const ORIGIN = 'https://mylearningspace.wlu.ca';
const ASSIGNMENT = `${ORIGIN}/d2l/lms/dropbox/user/folder_submit_files.d2l?ou=999999&db=101`;
const READING = `${ORIGIN}/d2l/le/content/999999/viewContent/12/View`;
const ATTEMPT = `${ORIGIN}/d2l/lms/quizzing/user/attempt/201?ou=999999`;

let sessionStore: Record<string, unknown> = {};

beforeEach(async () => {
  await deleteDatabase('motion');
  sessionStore = {};
  vi.stubGlobal('chrome', {
    storage: {
      session: {
        get: vi.fn(async (key: string) => ({ [key]: sessionStore[key] })),
        set: vi.fn(async (values: Record<string, unknown>) => {
          Object.assign(sessionStore, values);
        }),
        remove: vi.fn(async (key: string) => {
          delete sessionStore[key];
        }),
      },
    },
    tabs: {
      // The content script answers with the assignment page's content.
      sendMessage: vi.fn(async () => ({
        content: {
          pageType: 'assignment',
          title: 'Synthetic Assignment 2',
          url: ASSIGNMENT,
          text: '',
          headings: [],
          links: [
            { href: READING, label: 'Week 6 reading' },
            { href: ATTEMPT, label: 'Quiz 3' },
          ],
          capturedAt: '2026-03-02T12:00:00.000Z',
          instructionBlocks: [],
          warnings: [],
        },
      })),
      query: vi.fn(async () => [{ id: ACTIVE_TAB, active: true }]),
    },
    alarms: { create: vi.fn() },
    runtime: { id: 'test-extension-id' },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function observe(tabId: number, restricted = false, url = ASSIGNMENT) {
  await handleMessage(
    {
      type: 'page-observed',
      url,
      pageType: restricted ? 'quiz-attempt' : 'assignment',
      title: restricted ? 'Quiz' : 'Synthetic Assignment 2',
      detectionConfidence: 'high',
      warnings: [],
      restricted,
    },
    tabId,
  );
}

async function workflows() {
  return new IndexedDbWorkflowStore(await openDatabase()).list();
}

function tabWithUrl(tabs: FakeTabs, url: string): number {
  const found = [...tabs.tabs].find(([, tab]) => tab.url === url);
  if (!found) throw new Error(`no tab for ${url}`);
  return found[0];
}

describe('preparing a workspace', () => {
  it('opens the assignment and its reading in one group, and never the quiz attempt', async () => {
    await observe(ACTIVE_TAB);
    const tabs = new FakeTabs();

    const result = await handlePrepareWorkspace(ACTIVE_TAB, tabs);

    expect(result.workflowId).not.toBeNull();
    expect([...tabs.tabs.values()].map((tab) => tab.url)).toEqual([ASSIGNMENT, READING]);
    expect([...tabs.groups.values()]).toEqual(['Motion · Synthetic Assignment 2']);
    const [workflow] = await workflows();
    expect(workflow?.status).toBe('completed');
  });

  it('returns the open workspace instead of opening a second one', async () => {
    await observe(ACTIVE_TAB);
    const tabs = new FakeTabs();
    const first = await handlePrepareWorkspace(ACTIVE_TAB, tabs);

    const second = await handlePrepareWorkspace(ACTIVE_TAB, tabs);

    expect(second).toEqual({ workflowId: first.workflowId, reused: true });
    expect(tabs.opened).toBe(2);
    expect(await workflows()).toHaveLength(1);
  });

  it('prepares afresh once the student has closed every tab it opened', async () => {
    await observe(ACTIVE_TAB);
    const tabs = new FakeTabs();
    const first = await handlePrepareWorkspace(ACTIVE_TAB, tabs);
    await tabs.close([...tabs.tabs.keys()]);

    const second = await handlePrepareWorkspace(ACTIVE_TAB, tabs);

    expect(second.workflowId).not.toBe(first.workflowId);
    expect(second.reused).toBeUndefined();
  });

  it('refuses on a graded attempt without asking the page for anything', async () => {
    await observe(ACTIVE_TAB, true, ATTEMPT);
    const tabs = new FakeTabs();

    const result = await handlePrepareWorkspace(ACTIVE_TAB, tabs);

    expect(result.workflowId).toBeNull();
    expect(result.reason).toMatch(/graded attempt/i);
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
    expect(tabs.opened).toBe(0);
    expect(await workflows()).toHaveLength(0);
  });

  it('opens one workspace when the button is pressed twice at once', async () => {
    await observe(ACTIVE_TAB);
    const tabs = new FakeTabs();

    const [a, b] = await Promise.all([
      handlePrepareWorkspace(ACTIVE_TAB, tabs),
      handlePrepareWorkspace(ACTIVE_TAB, tabs),
    ]);

    expect(a.workflowId).toBe(b.workflowId);
    expect(await workflows()).toHaveLength(1);
    expect(tabs.opened).toBe(2);
  });

  it('refuses when the tab moved to a graded attempt between the check and the read', async () => {
    await observe(ACTIVE_TAB);
    vi.mocked(chrome.tabs.sendMessage).mockResolvedValueOnce({
      content: {
        pageType: 'quiz-attempt',
        title: 'Quiz',
        url: ATTEMPT,
        text: '',
        headings: [],
        links: [{ href: READING, label: 'Week 6 reading' }],
        capturedAt: '2026-03-02T12:00:00.000Z',
        instructionBlocks: [],
        warnings: [],
      },
    });
    const tabs = new FakeTabs();

    const result = await handlePrepareWorkspace(ACTIVE_TAB, tabs);

    expect(result.workflowId).toBeNull();
    expect(tabs.opened).toBe(0);
    expect(await workflows()).toHaveLength(0);
  });

  it('does not treat a workspace from before a browser restart as open', async () => {
    await observe(ACTIVE_TAB);
    const tabs = new FakeTabs();
    const first = await handlePrepareWorkspace(ACTIVE_TAB, tabs);

    tabs.currentSession = 'session-2';
    const second = await handlePrepareWorkspace(ACTIVE_TAB, tabs);

    expect(second.workflowId).not.toBe(first.workflowId);
  });

  it('refuses on a tab it has not seen a readable course page in', async () => {
    const result = await handlePrepareWorkspace(ACTIVE_TAB, new FakeTabs());
    expect(result.workflowId).toBeNull();
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
  });
});

describe('restricted mode inside Motion’s own group', () => {
  it('treats a tab Motion opened exactly like one the student opened', async () => {
    await observe(ACTIVE_TAB);
    const tabs = new FakeTabs();
    await handlePrepareWorkspace(ACTIVE_TAB, tabs);
    const motionTab = tabWithUrl(tabs, READING);

    // The reading Motion opened turns out to be a graded attempt.
    await observe(motionTab, true, ATTEMPT);

    expect(sessionStore[`observation:${motionTab}`]).toMatchObject({
      url: null,
      title: '',
      warnings: [],
      restricted: true,
    });
    vi.mocked(chrome.tabs.query).mockResolvedValue([
      { id: motionTab, active: true } as chrome.tabs.Tab,
    ]);
    const state = (await handleMessage({ type: 'get-state' })) as { connection: string };
    expect(state.connection).toBe('restricted');
  });
});

describe('closing a workspace', () => {
  it('closes only tabs Motion opened that are still in its group', async () => {
    await observe(ACTIVE_TAB);
    const tabs = new FakeTabs();
    const { workflowId } = await handlePrepareWorkspace(ACTIVE_TAB, tabs);
    const assignmentTab = tabWithUrl(tabs, ASSIGNMENT);
    const readingTab = tabWithUrl(tabs, READING);
    const groupId = tabs.tabs.get(assignmentTab)!.groupId;

    // The student drags their own tab into the group, and Motion's reading out.
    const studentTab = tabs.addStudentTab(`${ORIGIN}/d2l/home/999999`, groupId);
    tabs.tabs.get(readingTab)!.groupId = null;

    const result = await handleCloseWorkspace(workflowId!, tabs);

    expect(result).toEqual({ closed: 1, ungrouped: 0 });
    expect(tabs.tabs.has(assignmentTab)).toBe(false);
    expect(tabs.tabs.has(readingTab)).toBe(true);
    expect(tabs.tabs.has(studentTab)).toBe(true);
  });

  it('closes nothing after a browser restart, when its tab ids may name other tabs', async () => {
    await observe(ACTIVE_TAB);
    const tabs = new FakeTabs();
    const { workflowId } = await handlePrepareWorkspace(ACTIVE_TAB, tabs);
    const before = tabs.tabs.size;

    tabs.currentSession = 'session-2';
    // Session records do not survive a restart either.
    tabs.tabsOpenedBy = async () => [];

    expect(await handleCloseWorkspace(workflowId!, tabs)).toEqual({ closed: 0, ungrouped: 0 });
    expect(tabs.tabs.size).toBe(before);
  });

  it('also closes tabs a stopped attempt opened but never recorded', async () => {
    await observe(ACTIVE_TAB);
    const tabs = new FakeTabs();
    const { workflowId } = await handlePrepareWorkspace(ACTIVE_TAB, tabs);
    // An earlier attempt opened a tab, then was stopped before recording it.
    const stray = (await tabs.open(READING, `${workflowId}:open-sources:9:0`)).tabId;

    await handleCloseWorkspace(workflowId!, tabs);

    expect(tabs.tabs.has(stray)).toBe(false);
  });

  it('closes nothing for a workflow that is not a workspace', async () => {
    expect(await handleCloseWorkspace('no-such-workflow', new FakeTabs())).toEqual({ closed: 0, ungrouped: 0 });
  });
});

describe('the toolbar icon', () => {
  async function currentTab(tabs = new FakeTabs()) {
    const tabId = tabs.addStudentTab(ASSIGNMENT);
    await observe(tabId);
    return { tabs, tabId };
  }

  it('adopts the current tab into the same group as Prepare workspace', async () => {
    const { tabs, tabId } = await currentTab();
    expect(await handleActionClick({ id: tabId, url: ASSIGNMENT }, tabs)).toEqual({ grouped: true });
    await handlePrepareWorkspace(tabId, tabs);
    expect([...tabs.groups.values()]).toEqual(['Motion · Synthetic Assignment 2']);
    expect([...tabs.tabs.values()].filter((tab) => tab.groupId !== null)).toHaveLength(3);
    expect(tabs.adopted.get(tabId)).toBe([...tabs.groups.keys()][0]);
  });

  it('ungroups an adopted tab while closing Motion tabs', async () => {
    const { tabs, tabId } = await currentTab();
    await handleActionClick({ id: tabId, url: ASSIGNMENT }, tabs);
    const { workflowId } = await handlePrepareWorkspace(tabId, tabs);
    const result = await handleCloseWorkspace(workflowId!, tabs);
    expect(result.ungrouped).toBe(1);
    expect(tabs.tabs.get(tabId)?.groupId).toBeNull();
    expect(tabs.tabs.has(tabId)).toBe(true);
  });

  it('leaves an adopted tab the student dragged out of the group where they put it', async () => {
    const { tabs, tabId } = await currentTab();
    await handleActionClick({ id: tabId, url: ASSIGNMENT }, tabs);
    const { workflowId } = await handlePrepareWorkspace(tabId, tabs);
    const studentGroup = 900;
    tabs.groups.set(studentGroup, 'My reading list');
    tabs.tabs.get(tabId)!.groupId = studentGroup;

    const result = await handleCloseWorkspace(workflowId!, tabs);

    expect(result.ungrouped).toBe(0);
    expect(tabs.tabs.get(tabId)?.groupId).toBe(studentGroup);
  });

  /** Asserts the click changed nothing: no group, no adoption, tab untouched. */
  async function expectDeclined(tabs: FakeTabs, tab: Parameters<typeof handleActionClick>[0]) {
    const groupsBefore = tabs.groups.size;
    const groupBefore = tabs.tabs.get(tab.id!)?.groupId;
    expect(await handleActionClick(tab, tabs)).toEqual({ grouped: false });
    expect(tabs.groups.size).toBe(groupsBefore);
    expect(tabs.tabs.get(tab.id!)?.groupId).toBe(groupBefore);
    expect(tabs.adopted.size).toBe(0);
  }

  it('does not group a graded attempt', async () => {
    const tabs = new FakeTabs();
    const tabId = tabs.addStudentTab(ATTEMPT);
    await observe(tabId, true, ATTEMPT);
    await expectDeclined(tabs, { id: tabId, url: ATTEMPT });
  });

  it('does not group a live URL the policy restricts, even beside a supported observation', async () => {
    const tabs = new FakeTabs();
    const tabId = tabs.addStudentTab(ATTEMPT);
    // A stored observation that wrongly claims the attempt is readable: the
    // live-URL check must still hold on its own.
    await observe(tabId, false, ATTEMPT);
    await expectDeclined(tabs, { id: tabId, url: ATTEMPT });
  });

  it('does not group a tab that has navigated since it was observed', async () => {
    const { tabs, tabId } = await currentTab();
    tabs.tabs.get(tabId)!.url = READING;
    await expectDeclined(tabs, { id: tabId, url: READING });
  });

  it('decides on the live tab, not the snapshot the click carried', async () => {
    // The click saw an ungrouped assignment; by the time the lock is held the
    // tab has gone into a graded attempt. The stored observation is stale.
    const { tabs, tabId } = await currentTab();
    tabs.tabs.get(tabId)!.url = ATTEMPT;
    await expectDeclined(tabs, { id: tabId, url: ASSIGNMENT });

    // Or the student dragged it into their own group in the meantime.
    const other = await currentTab(new FakeTabs());
    other.tabs.groups.set(900, 'My reading list');
    other.tabs.tabs.get(other.tabId)!.groupId = 900;
    await expectDeclined(other.tabs, { id: other.tabId, url: ASSIGNMENT });
  });

  it('still ungroups, never closes, a tab whose adoption was cut short by a worker restart', async () => {
    const { tabs, tabId } = await currentTab();
    // The worker dies after grouping the tab and before recording the group id.
    const record = tabs.recordAdopted.bind(tabs);
    tabs.recordAdopted = async (id, groupId) => {
      if (groupId !== 'pending') throw new Error('worker stopped');
      await record(id, groupId);
    };
    await expect(
      handleActionClick({ id: tabId, url: ASSIGNMENT }, tabs),
    ).rejects.toThrow('worker stopped');
    tabs.recordAdopted = record;
    const { workflowId } = await handlePrepareWorkspace(tabId, tabs);

    const result = await handleCloseWorkspace(workflowId!, tabs);

    expect(result.ungrouped).toBe(1);
    expect(tabs.tabs.has(tabId)).toBe(true);
    expect(tabs.tabs.get(tabId)?.groupId).toBeNull();
  });

  it('does not group a page that has not reported itself yet', async () => {
    const tabs = new FakeTabs();
    const tabId = tabs.addStudentTab(ASSIGNMENT);
    await expectDeclined(tabs, { id: tabId, url: ASSIGNMENT });
  });

  it('does not group a site no adapter supports', async () => {
    const tabs = new FakeTabs();
    const url = 'https://example.com/notes';
    const tabId = tabs.addStudentTab(url);
    await expectDeclined(tabs, { id: tabId, url });
  });

  it('leaves a tab that is already in the student’s own group', async () => {
    const tabs = new FakeTabs();
    const studentGroup = 900;
    tabs.groups.set(studentGroup, 'My reading list');
    const tabId = tabs.addStudentTab(ASSIGNMENT, studentGroup);
    await observe(tabId);
    await expectDeclined(tabs, { id: tabId, url: ASSIGNMENT });
  });

  it('serializes two clicks into one group', async () => {
    const { tabs, tabId } = await currentTab();
    const tab = { id: tabId, url: ASSIGNMENT } as const;
    await Promise.all([handleActionClick(tab, tabs), handleActionClick(tab, tabs)]);
    expect(tabs.groups.size).toBe(1);
    expect(tabs.adopted.get(tabId)).toBe(100);
  });
});
