import { describe, expect, it } from 'vitest';
import { d2lAdapter } from '@/core/adapters';
import type { PageContent } from '@/core/domain';
import { workflowSchema, type Workflow } from '@/core/workflows';
import { selectWorkspaceSources, workspaceOwnership } from '.';

/** Synthetic page content; no real course material. */
const ORIGIN = 'https://school.brightspace.com';
const ASSIGNMENT = `${ORIGIN}/d2l/lms/dropbox/user/folder_submit_files.d2l?ou=363&db=101`;

function content(links: { href: string; label: string }[], url = ASSIGNMENT): PageContent {
  return {
    pageType: 'assignment',
    title: 'Synthetic Assignment 2',
    url,
    text: '',
    headings: [],
    links,
    capturedAt: '2026-03-02T12:00:00.000Z',
    instructionBlocks: [],
    warnings: [],
  };
}

const classify = (url: string) => d2lAdapter.classifyUrl(url);
const link = (href: string, label = 'Link') => ({ href, label });

describe('choosing what a workspace opens', () => {
  it('puts the assignment itself first', () => {
    expect(selectWorkspaceSources(content([]), classify)).toEqual([ASSIGNMENT]);
  });

  it('opens linked readings the adapter recognises as readable pages', () => {
    const reading = `${ORIGIN}/d2l/le/content/363/viewContent/12/View`;
    const topic = `${ORIGIN}/d2l/le/363/discussions/topics/301/View`;
    expect(selectWorkspaceSources(content([link(reading), link(topic)]), classify)).toEqual([
      ASSIGNMENT,
      reading,
      topic,
    ]);
  });

  it.each([
    ['a graded attempt', `${ORIGIN}/d2l/lms/quizzing/user/attempt/201`],
    ['a quiz list', `${ORIGIN}/d2l/lms/quizzing/user/quizzes_list.d2l`],
    ['a logout link', `${ORIGIN}/d2l/logout`],
    ['an unrecognised route', `${ORIGIN}/d2l/lp/something/unknown`],
    ['another origin', 'https://other.brightspace.com/d2l/le/content/363/viewContent/12/View'],
    ['plain http', 'http://school.brightspace.com/d2l/le/content/363/viewContent/12/View'],
    ['a javascript: link', 'javascript:alert(1)'],
    ['the grades page', `${ORIGIN}/d2l/lms/grades/363`],
  ])('never opens %s', (_name, href) => {
    expect(selectWorkspaceSources(content([link(href)]), classify)).toEqual([ASSIGNMENT]);
  });

  it('refuses a readable-looking route whose address says it is an attempt', () => {
    const disguised = `${ORIGIN}/d2l/le/content/363/viewContent/12/View?take_quiz=1`;
    expect(selectWorkspaceSources(content([link(disguised)]), classify)).toEqual([ASSIGNMENT]);
  });

  it('opens a page once, whatever its fragment or marker', () => {
    const reading = `${ORIGIN}/d2l/le/content/363/viewContent/12/View`;
    const sources = selectWorkspaceSources(
      content([link(`${reading}#top`), link(reading), link(`${reading}?motion_op=old`)]),
      classify,
    );
    expect(sources).toEqual([ASSIGNMENT, reading]);
  });

  it('does not reopen the assignment through a link to itself', () => {
    expect(selectWorkspaceSources(content([link(`${ASSIGNMENT}#instructions`)]), classify)).toEqual([
      ASSIGNMENT,
    ]);
  });

  it('caps the workspace, counting the assignment', () => {
    const readings = Array.from({ length: 20 }, (_, index) =>
      link(`${ORIGIN}/d2l/le/content/363/viewContent/${index}/View`),
    );
    expect(selectWorkspaceSources(content(readings), classify, 4)).toHaveLength(4);
  });

  it.each([
    ['a graded attempt', `${ORIGIN}/d2l/lms/quizzing/user/attempt/201`],
    ['a quiz list', `${ORIGIN}/d2l/lms/quizzing/user/quizzes_list.d2l`],
    ['a sign-in page', `${ORIGIN}/d2l/login`],
    ['an unrecognised route', `${ORIGIN}/d2l/logout`],
  ])('opens nothing, not even its links, when the page itself is %s', (_name, url) => {
    const reading = link(`${ORIGIN}/d2l/le/content/363/viewContent/12/View`);
    expect(selectWorkspaceSources(content([reading], url), classify)).toEqual([]);
  });

  it('opens nothing from a page that is not https', () => {
    expect(selectWorkspaceSources(content([], 'http://school.brightspace.com/d2l/home/363'), classify)).toEqual([]);
  });
});

function workflowWith(evidence: Record<string, unknown> | null): Workflow {
  const now = '2026-03-02T12:00:00.000Z';
  return workflowSchema.parse({
    id: 'wf-1',
    definitionId: 'prepare-workspace',
    definitionVersion: 1,
    title: 'Motion · CP363 · A2',
    steps: [
      { id: 'read-assignment', title: 'Read', action: 'read-page', risk: 'low' },
      {
        id: 'open-sources',
        title: 'Open',
        action: 'open-tab',
        risk: 'low',
        intent: evidence ? { key: 'k', state: 'applied', evidence, updatedAt: now } : null,
      },
    ],
    createdAt: now,
    updatedAt: now,
  });
}

describe('workspace ownership', () => {
  const SESSION = 'session-1';
  const nothing = { groupId: null, tabIds: [] };

  it('is the group and the tab ids Motion recorded when it opened them', () => {
    const workflow = workflowWith({ groupId: 100, tabIds: [4, 5], sessionKey: SESSION });
    expect(workspaceOwnership(workflow, SESSION)).toEqual({ groupId: 100, tabIds: [4, 5] });
  });

  it('is nothing once the browser session that issued those ids has ended', () => {
    const workflow = workflowWith({ groupId: 100, tabIds: [4, 5], sessionKey: SESSION });
    expect(workspaceOwnership(workflow, 'session-2')).toEqual(nothing);
  });

  it('is nothing before the tabs were opened', () => {
    expect(workspaceOwnership(workflowWith(null), SESSION)).toEqual(nothing);
  });

  it('is nothing when the stored record is corrupt or unsigned, rather than a guess', () => {
    expect(workspaceOwnership(workflowWith({ groupId: 'x', tabIds: ['4'] }), SESSION)).toEqual(
      nothing,
    );
    expect(workspaceOwnership(workflowWith({ groupId: 100, tabIds: [4] }), SESSION)).toEqual(
      nothing,
    );
  });
});
