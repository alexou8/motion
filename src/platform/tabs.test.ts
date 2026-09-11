import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChromeTabs, groupTitle, isOpenableUrl, markUrl, operationIdOf } from './tabs';

/**
 * A minimal fake of the Chrome tab APIs. Built by hand rather than mocked
 * wholesale so the tests describe the browser behaviour that actually matters:
 * tab ids are not durable, groups can be renamed or emptied by the student,
 * and the same operation can be attempted twice after a restart.
 */
interface FakeTab {
  id: number;
  url: string;
  groupId?: number;
  active?: boolean;
}

function fakeChrome() {
  const tabs: FakeTab[] = [];
  const groups = new Map<number, { id: number; title?: string; color?: string; windowId: number }>();
  const session: Record<string, unknown> = {};
  let nextTabId = 1;
  let nextGroupId = 100;

  const api = {
    tabs: {
      query: vi.fn(async (info: { groupId?: number }) =>
        info.groupId === undefined ? [...tabs] : tabs.filter((t) => t.groupId === info.groupId),
      ),
      create: vi.fn(async (info: { url: string; active?: boolean }) => {
        const tab: FakeTab = { id: nextTabId++, url: info.url, active: info.active ?? false };
        tabs.push(tab);
        return tab;
      }),
      group: vi.fn(async (info: { groupId?: number; tabIds: number[] }) => {
        const groupId = info.groupId ?? nextGroupId++;
        if (!groups.has(groupId)) groups.set(groupId, { id: groupId, windowId: 1 });
        for (const id of info.tabIds) {
          const tab = tabs.find((t) => t.id === id);
          if (tab) tab.groupId = groupId;
        }
        return groupId;
      }),
      sendMessage: vi.fn(async () => undefined),
      get: vi.fn(async (id: number) => {
        const tab = tabs.find((t) => t.id === id);
        if (!tab) throw new Error('No tab with id');
        return tab;
      }),
      remove: vi.fn(async (ids: number[]) => {
        for (const id of ids) {
          const index = tabs.findIndex((t) => t.id === id);
          if (index >= 0) tabs.splice(index, 1);
        }
      }),
      ungroup: vi.fn(async (ids: number[]) => {
        for (const id of ids) {
          const tab = tabs.find((candidate) => candidate.id === id);
          if (tab) tab.groupId = -1;
        }
      }),
    },
    tabGroups: {
      query: vi.fn(async (info: { title?: string }) =>
        [...groups.values()].filter((g) => (info.title ? g.title === info.title : true)),
      ),
      update: vi.fn(async (groupId: number, props: { title?: string; color?: string }) => {
        const group = groups.get(groupId);
        if (group) Object.assign(group, props);
        return group;
      }),
      get: vi.fn(async (groupId: number) => {
        const group = groups.get(groupId);
        if (!group) throw new Error('No group with id');
        return group;
      }),
    },
    // Session storage: survives a worker restart, cleared by a browser restart.
    storage: {
      session: {
        get: vi.fn(async (key: string | null) =>
          key === null ? { ...session } : { [key]: session[key] },
        ),
        set: vi.fn(async (values: Record<string, unknown>) => {
          Object.assign(session, values);
        }),
      },
    },
    _state: { tabs, groups, session },
  };
  return api;
}

let api: ReturnType<typeof fakeChrome>;

beforeEach(() => {
  api = fakeChrome();
  vi.stubGlobal('chrome', api);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('URL safety', () => {
  it.each([
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'http://mylearningspace.wlu.ca/d2l/home/1',
    'chrome-extension://abc/page.html',
    'not a url',
  ])('refuses to treat %s as openable', (url) => {
    expect(isOpenableUrl(url)).toBe(false);
  });

  it('accepts an https URL', () => {
    expect(isOpenableUrl('https://mylearningspace.wlu.ca/d2l/home/1')).toBe(true);
  });

  it('refuses to open a non-https URL even when asked directly', async () => {
    const tabs = new ChromeTabs();
    await expect(tabs.open('javascript:alert(1)', 'op-1')).rejects.toThrow(/non-https/i);
    expect(api.tabs.create).not.toHaveBeenCalled();
  });
});

describe('operation markers', () => {
  it('round-trips an operation id through the URL', () => {
    const marked = markUrl('https://example.brightspace.com/d2l/home/1', 'op-abc');
    expect(operationIdOf(marked)).toBe('op-abc');
  });

  it('preserves the original query parameters', () => {
    const marked = markUrl('https://x.brightspace.com/d2l/home?ou=363&db=1', 'op-1');
    const parsed = new URL(marked);
    expect(parsed.searchParams.get('ou')).toBe('363');
    expect(parsed.searchParams.get('db')).toBe('1');
  });

  it('returns null for a URL Motion did not open', () => {
    expect(operationIdOf('https://example.com/page')).toBeNull();
    expect(operationIdOf(undefined)).toBeNull();
  });
});

describe('opening tabs is idempotent across a restart', () => {
  it('does not open a second tab for an operation already carried out', async () => {
    const tabs = new ChromeTabs();
    const first = await tabs.open('https://x.brightspace.com/d2l/le/content/1', 'op-1');
    expect(api.tabs.create).toHaveBeenCalledTimes(1);

    // The worker died here. A new one retries the same operation.
    const second = await tabs.open('https://x.brightspace.com/d2l/le/content/1', 'op-1');

    expect(api.tabs.create).toHaveBeenCalledTimes(1);
    expect(second.tabId).toBe(first.tabId);
  });

  it('finds a tab by operation id after a restart', async () => {
    const tabs = new ChromeTabs();
    await tabs.open('https://x.brightspace.com/d2l/le/content/1', 'op-42');
    const found = await tabs.findByOperation('op-42');
    expect(found?.operationId).toBe('op-42');
  });

  it('reports nothing for an operation that never ran', async () => {
    const tabs = new ChromeTabs();
    expect(await tabs.findByOperation('never')).toBeNull();
  });

  it('does not steal focus when opening', async () => {
    const tabs = new ChromeTabs();
    await tabs.open('https://x.brightspace.com/d2l/home/1', 'op-1');
    expect(api.tabs.create).toHaveBeenCalledWith(expect.objectContaining({ active: false }));
  });
});

describe('tab groups', () => {
  it('ungroups tabs without closing them', async () => {
    const tabs = new ChromeTabs();
    const tab = await tabs.open('https://x.brightspace.com/a', 'op-a');
    const groupId = await tabs.ensureGroup({ title: 'Motion · A', color: 'blue' }, [tab.tabId]);
    await tabs.ungroup([tab.tabId]);
    expect(api._state.tabs.find((candidate) => candidate.id === tab.tabId)?.groupId).toBe(-1);
    expect(await tabs.groupExists(groupId)).toBe(true);
  });

  it('tracks adopted tabs separately from owned tabs and only while they remain live in the group', async () => {
    const tabs = new ChromeTabs();
    const adopted = await tabs.open('https://x.brightspace.com/a', 'op-a');
    const moved = await tabs.open('https://x.brightspace.com/b', 'op-b');
    const closed = await tabs.open('https://x.brightspace.com/c', 'op-c');
    const groupId = await tabs.ensureGroup({ title: 'Motion · A', color: 'blue' }, [adopted.tabId, moved.tabId, closed.tabId]);
    const studentTab = { id: 99, url: 'https://x.brightspace.com/student', groupId: groupId };
    api._state.tabs.push(studentTab);
    await tabs.recordAdopted(studentTab.id, groupId);
    await tabs.recordAdopted(moved.tabId, groupId);
    await tabs.recordAdopted(closed.tabId, groupId);
    await tabs.ungroup([moved.tabId]);
    await tabs.close([closed.tabId]);
    expect(await tabs.adoptedTabsInGroup(groupId)).toEqual([studentTab.id]);
    expect(await tabs.tabsOpenedBy('op')).toEqual([adopted.tabId, moved.tabId]);
  });

  it('counts a pending adoption only while its tab is in the group', async () => {
    const tabs = new ChromeTabs();
    const anchor = await tabs.open('https://x.brightspace.com/a', 'op-a');
    const groupId = await tabs.ensureGroup({ title: 'Motion · A', color: 'blue' }, [anchor.tabId]);
    // The worker died between grouping this tab and recording the group id.
    const cutShort = { id: 98, url: 'https://x.brightspace.com/cut-short', groupId };
    // A pending record whose grouping never happened.
    const neverGrouped = { id: 97, url: 'https://x.brightspace.com/never', groupId: -1 };
    api._state.tabs.push(cutShort, neverGrouped);
    await tabs.recordAdopted(cutShort.id, 'pending');
    await tabs.recordAdopted(neverGrouped.id, 'pending');

    expect(await tabs.adoptedTabsInGroup(groupId)).toEqual([cutShort.id]);
  });

  it('reads a live tab with Chrome’s no-group value as ungrouped, and a closed one as gone', async () => {
    const tabs = new ChromeTabs();
    const opened = await tabs.open('https://x.brightspace.com/a', 'op-a');
    const groupId = await tabs.ensureGroup({ title: 'Motion · A', color: 'blue' }, [opened.tabId]);
    expect((await tabs.get(opened.tabId))?.groupId).toBe(groupId);

    await tabs.ungroup([opened.tabId]);
    expect(await tabs.get(opened.tabId)).toMatchObject({ groupId: null });

    await tabs.close([opened.tabId]);
    expect(await tabs.get(opened.tabId)).toBeNull();
  });

  it('creates a titled group the first time', async () => {
    const tabs = new ChromeTabs();
    const a = await tabs.open('https://x.brightspace.com/a', 'op-a');
    const groupId = await tabs.ensureGroup({ title: 'Motion · CP363 · A2', color: 'blue' }, [a.tabId]);

    expect(api.tabGroups.update).toHaveBeenCalledWith(
      groupId,
      expect.objectContaining({ title: 'Motion · CP363 · A2' }),
    );
  });

  it('reuses an existing group instead of creating a duplicate', async () => {
    const tabs = new ChromeTabs();
    const a = await tabs.open('https://x.brightspace.com/a', 'op-a');
    const first = await tabs.ensureGroup({ title: 'Motion · CP363 · A2', color: 'blue' }, [a.tabId]);

    const b = await tabs.open('https://x.brightspace.com/b', 'op-b');
    const second = await tabs.ensureGroup({ title: 'Motion · CP363 · A2', color: 'blue' }, [b.tabId]);

    expect(second).toBe(first);
    expect(api._state.groups.size).toBe(1);
  });

  it('only adds tabs that are not already in the group', async () => {
    const tabs = new ChromeTabs();
    const a = await tabs.open('https://x.brightspace.com/a', 'op-a');
    const groupId = await tabs.ensureGroup({ title: 'Motion · A', color: 'blue' }, [a.tabId]);

    api.tabs.group.mockClear();
    // Re-running with the same tab must not re-group it.
    await tabs.ensureGroup({ title: 'Motion · A', color: 'blue' }, [a.tabId]);
    expect(api.tabs.group).not.toHaveBeenCalled();

    const b = await tabs.open('https://x.brightspace.com/b', 'op-b');
    await tabs.ensureGroup({ title: 'Motion · A', color: 'blue' }, [a.tabId, b.tabId]);
    expect(api.tabs.group).toHaveBeenCalledWith({ groupId, tabIds: [b.tabId] });
  });

  it('refuses to group nothing', async () => {
    const tabs = new ChromeTabs();
    await expect(tabs.ensureGroup({ title: 'Motion · A', color: 'blue' }, [])).rejects.toThrow(
      /No tabs/i,
    );
  });

  it('reports a group the student closed as gone', async () => {
    const tabs = new ChromeTabs();
    expect(await tabs.groupExists(9999)).toBe(false);
  });
});

describe('tabs Motion owns', () => {
  it('are the recorded tabs still in the group, not everything in it', async () => {
    const tabs = new ChromeTabs();
    const a = await tabs.open('https://x.brightspace.com/a', 'op-a');
    const b = await tabs.open('https://x.brightspace.com/b', 'op-b');
    const groupId = await tabs.ensureGroup({ title: 'Motion · A', color: 'blue' }, [a.tabId, b.tabId]);

    // The student drags their own tab in, and one of Motion's out.
    api._state.tabs.push({ id: 99, url: 'https://x.brightspace.com/mine', groupId });
    api._state.tabs.find((t) => t.id === b.tabId)!.groupId = undefined;

    expect(await tabs.ownedTabsInGroup(groupId, [a.tabId, b.tabId])).toEqual([a.tabId]);
  });

  it('still finds a tab whose URL lost its marker to a redirect', async () => {
    const tabs = new ChromeTabs();
    const first = await tabs.open('https://x.brightspace.com/a', 'op-a');
    api._state.tabs.find((t) => t.id === first.tabId)!.url = 'https://x.brightspace.com/a/canonical';

    await tabs.open('https://x.brightspace.com/a', 'op-a');

    expect(api.tabs.create).toHaveBeenCalledTimes(1);
  });

  it('recovers a tab created just before the worker died, before it was recorded', async () => {
    const tabs = new ChromeTabs();
    // The worker marked the operation pending, Chrome created the tab, then
    // the worker died before recording the tab id.
    api._state.session['motion:op:op-a'] = 'pending';
    api._state.tabs.push({ id: 5, url: 'https://x.brightspace.com/a?motion_op=op-a' });

    const found = await tabs.open('https://x.brightspace.com/a', 'op-a');

    expect(found.tabId).toBe(5);
    expect(api.tabs.create).not.toHaveBeenCalled();
  });

  it('never adopts a tab the browser restored from an earlier session', async () => {
    const tabs = new ChromeTabs();
    // Session storage was cleared by the restart; the restored tab kept its URL.
    api._state.tabs.push({ id: 5, url: 'https://x.brightspace.com/a?motion_op=op-a' });

    expect(await tabs.findByOperation('op-a')).toBeNull();
    const opened = await tabs.open('https://x.brightspace.com/a', 'op-a');
    expect(opened.tabId).not.toBe(5);
  });

  it('lists live tabs recorded under an operation prefix, from session records only', async () => {
    const tabs = new ChromeTabs();
    const a = await tabs.open('https://x.brightspace.com/a', 'wf-1:open-sources:1:0');
    await tabs.open('https://x.brightspace.com/b', 'wf-2:open-sources:1:0');
    // A tab restored after a browser restart still carries a marker in its
    // URL, but this session never recorded opening it.
    api._state.tabs.push({ id: 77, url: 'https://x.brightspace.com/c?motion_op=wf-1:open-sources:1:1' });

    expect(await tabs.tabsOpenedBy('wf-1:')).toEqual([a.tabId]);
  });

  it('keeps one session key for the whole browser session', async () => {
    const tabs = new ChromeTabs();
    const first = await tabs.sessionKey();
    expect(await new ChromeTabs().sessionKey()).toBe(first);
  });

  it('closes exactly the tabs it is given, and nothing when given none', async () => {
    const tabs = new ChromeTabs();
    await tabs.close([]);
    expect(api.tabs.remove).not.toHaveBeenCalled();

    const a = await tabs.open('https://x.brightspace.com/a', 'op-a');
    await tabs.close([a.tabId]);
    expect(api.tabs.remove).toHaveBeenCalledWith([a.tabId]);
  });
});

describe('group naming', () => {
  it('always prefixes Motion so a student can tell whose group it is', () => {
    expect(groupTitle(['CP363', 'Assignment 2'])).toBe('Motion · CP363 · Assignment 2');
  });

  it('skips missing parts rather than leaving empty separators', () => {
    expect(groupTitle([null, 'Week 6'])).toBe('Motion · Week 6');
    expect(groupTitle([undefined, '  '])).toBe('Motion');
  });
});
