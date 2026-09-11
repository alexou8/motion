import { describe, expect, it } from 'vitest';
import { workflowSchema, type StepContext } from '@/core/workflows';
import { FakeTabs } from '@/test/fakeTabs';
import { openSourcesCapability } from './capabilities';

const NOW = '2026-03-02T12:00:00.000Z';
const URLS = [
  'https://school.brightspace.com/d2l/lms/dropbox/user/folder_submit_files.d2l?ou=363&db=101',
  'https://school.brightspace.com/d2l/le/content/363/viewContent/12/View',
  'https://school.brightspace.com/d2l/le/content/363/viewContent/13/View',
];

function context(
  intentKey = 'wf-1:open-sources:1',
  stillCurrent: () => Promise<boolean> = async () => true,
): StepContext {
  const workflow = workflowSchema.parse({
    id: 'wf-1',
    definitionId: 'prepare-workspace',
    definitionVersion: 1,
    title: 'Motion · CP363 · A2',
    steps: [
      {
        id: 'open-sources',
        title: 'Open',
        action: 'open-tab',
        risk: 'low',
        input: { urls: URLS, courseCode: 'CP363', label: 'A2' },
      },
    ],
    createdAt: NOW,
    updatedAt: NOW,
  });
  return { workflow, step: workflow.steps[0]!, intentKey, now: new Date(NOW), stillCurrent };
}

describe('opening a workspace', () => {
  it('opens every source and groups them under one titled group', async () => {
    const tabs = new FakeTabs();
    const outcome = await openSourcesCapability(tabs).execute(context());

    expect(outcome).toMatchObject({
      kind: 'done',
      evidence: { groupId: 100, sessionKey: 'session-1' },
    });
    expect(tabs.opened).toBe(3);
    expect([...tabs.groups.values()]).toEqual(['Motion · CP363 · A2']);
    expect([...tabs.tabs.values()].every((tab) => tab.groupId === 100)).toBe(true);
  });

  it('stops opening tabs the moment it no longer holds the workflow', async () => {
    const tabs = new FakeTabs();
    let current = true;
    // The student closes the workspace while the first tab is opening.
    tabs.beforeOpen = async () => {
      current = false;
    };

    const outcome = await openSourcesCapability(tabs).execute(
      context('wf-1:open-sources:1', async () => current),
    );

    expect(tabs.opened).toBe(1);
    expect(tabs.groups.size).toBe(0);
    expect(outcome.kind).toBe('skipped');
  });
});

describe('recovering after the worker died mid-step', () => {
  it('groups the tabs already open and opens only the one still missing', async () => {
    const tabs = new FakeTabs();
    const capability = openSourcesCapability(tabs);
    // The previous worker opened two of three tabs, then died before grouping.
    await tabs.open(URLS[0]!, 'wf-1:open-sources:1:0');
    await tabs.open(URLS[1]!, 'wf-1:open-sources:1:1');

    const outcome = await capability.reconcile!(context());

    expect(tabs.opened).toBe(3);
    expect(outcome).toMatchObject({
      kind: 'done',
      evidence: { groupId: 100, tabIds: [10, 11, 12] },
    });
    expect([...tabs.tabs.values()].every((tab) => tab.groupId === 100)).toBe(true);
  });

  it('reports that nothing happened when no tab carries the old marker', async () => {
    const tabs = new FakeTabs();
    expect(await openSourcesCapability(tabs).reconcile!(context())).toBeNull();
    expect(tabs.opened).toBe(0);
  });
});
