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
    _state: { tabs, groups },
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

describe('group naming', () => {
  it('always prefixes Motion so a student can tell whose group it is', () => {
    expect(groupTitle(['CP363', 'Assignment 2'])).toBe('Motion · CP363 · Assignment 2');
  });

  it('skips missing parts rather than leaving empty separators', () => {
    expect(groupTitle([null, 'Week 6'])).toBe('Motion · Week 6');
    expect(groupTitle([undefined, '  '])).toBe('Motion');
  });
});
