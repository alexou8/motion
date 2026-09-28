import { describe, expect, it } from 'vitest';
import { guardToolCall, type GuardContext } from './guard';
import { buildTrustedRefs } from './refs';
import type { AgentSession } from '../session';
import type { CourseLink } from '../graph';
import type { SnapshotResult } from '../actor/contracts';
import type { ToolCall } from './tools';

const NOW = '2026-03-02T12:00:00.000Z';

function session(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: 's1',
    title: 'CP363 · Assignment 2',
    goal: 'Work on Assignment 2',
    courseId: 'c1',
    taskId: 't1',
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
    workspace: { groupId: null, groupTitle: '', sessionKey: 'sess-1', ownedTabIds: [], adoptedTabIds: [], releasedTabIds: [] },
    plan: { steps: [], currentStepId: null },
    blockers: [],
    context: { sources: [] },
    artifacts: [],
    agent: { providerId: null, model: null },
    conversation: [],
    activity: [],
    workflowIds: [],
    modelTurnGeneration: 0,
    pendingModelRequest: null,
    ...overrides,
    revision: overrides.revision ?? 0,
  };
}

const LMS_ORIGIN = 'https://lms.example.edu';

function link(overrides: Partial<CourseLink> = {}): CourseLink {
  return {
    id: 'link-1',
    courseId: 'c1',
    taskId: 't1',
    from: { kind: 'task', id: 't1' },
    relation: 'has-rubric',
    to: { kind: 'page', url: `${LMS_ORIGIN}/rubric`, title: 'Rubric' },
    confidence: 'high',
    provenance: { sourceUrl: `${LMS_ORIGIN}/assignment`, pageTitle: '', platformId: 'd2l', pageType: 'assignment', capturedAt: NOW, extractionVersion: 1 },
    userOverride: null,
    ...overrides,
  };
}

function snapshot(elements: SnapshotResult['elements']): SnapshotResult {
  return { snapshotId: 'snap-1', url: `${LMS_ORIGIN}/page`, elements };
}

function baseCtx(overrides: Partial<GuardContext> = {}): GuardContext {
  return {
    assessmentRestrictedByTabRef: {},
    allowedConfigurable: new Set(),
    lmsOrigins: [LMS_ORIGIN],
    turnSeq: 1,
    ...overrides,
  };
}

describe('guardToolCall', () => {
  it('rejects an unknown linkRef', () => {
    const refs = buildTrustedRefs(session(), { links: [], tabs: [], tasks: [], notes: [] });
    const call: ToolCall = { tool: 'open_link', linkRef: 'L99' };
    const result = guardToolCall(call, refs, baseCtx());
    expect(result.kind).toBe('rejected');
  });

  it('rejects a link that resolves cross-origin', () => {
    const crossOriginLink = link({ to: { kind: 'page', url: 'https://evil.example/steal', title: 'x' } });
    const refs = buildTrustedRefs(session(), { links: [crossOriginLink], tabs: [], tasks: [], notes: [] });
    const result = guardToolCall({ tool: 'open_link', linkRef: 'L1' }, refs, baseCtx());
    expect(result.kind).toBe('rejected');
  });

  it('rejects a non-https resolved link', () => {
    const httpLink = link({ to: { kind: 'page', url: 'http://lms.example.edu/insecure', title: 'x' } });
    const refs = buildTrustedRefs(session(), { links: [httpLink], tabs: [], tasks: [], notes: [] });
    const result = guardToolCall({ tool: 'open_link', linkRef: 'L1' }, refs, baseCtx());
    expect(result.kind).toBe('rejected');
  });

  it('rejects a same-origin quiz attempt even when a hostile page labels it a reading', () => {
    const attempt = link({
      relation: 'has-reading',
      to: { kind: 'page', url: `${LMS_ORIGIN}/d2l/lms/quizzing/user/attempt/123`, title: 'Reading' },
    });
    const refs = buildTrustedRefs(session(), { links: [attempt], tabs: [], tasks: [], notes: [] });
    const result = guardToolCall({ tool: 'open_link', linkRef: 'L1' }, refs, baseCtx());
    expect(result).toEqual(expect.objectContaining({ kind: 'rejected', reason: expect.stringMatching(/assessment/i) }));
  });

  // D-DEST-2 (SOL-10): authority now comes only from the adapter's own URL
  // classification, which matches on a real D2L/Brightspace host — not from
  // the "safe" observed relation these links carry. These two resources use
  // a real classified LMS host so the adapter recognizes the routes as
  // readable (`assignment` / `content-topic`) on their own merits.
  const CLASSIFIED_ORIGIN = 'https://school.brightspace.com';

  it('resolves assignment resources into workspace open steps instead of a metadata lookup', () => {
    const resources = [
      link({ relation: 'has-instructions', to: { kind: 'page', url: `${CLASSIFIED_ORIGIN}/d2l/lms/dropbox/user/folder_submit_files.d2l?ou=1`, title: 'Instructions' } }),
      link({ id: 'rubric', relation: 'has-rubric', to: { kind: 'page', url: `${CLASSIFIED_ORIGIN}/d2l/le/content/1/viewContent/2/View`, title: 'Rubric' } }),
    ];
    const refs = buildTrustedRefs(session(), { links: resources, tabs: [], tasks: [], notes: [] });
    const result = guardToolCall({ tool: 'open_assignment_resources' }, refs, baseCtx({ lmsOrigins: [CLASSIFIED_ORIGIN] }));
    expect(result).toEqual(expect.objectContaining({
      kind: 'ok',
      step: expect.objectContaining({ action: 'open-tab', input: expect.objectContaining({ urls: expect.arrayContaining([resources[0]!.to.url, resources[1]!.to.url]) }) }),
    }));
  });

  it('makes rubric reads a page read with its resolved URL, never a provider analysis', () => {
    const rubric = link({ to: { kind: 'page', url: `${CLASSIFIED_ORIGIN}/d2l/le/content/1/viewContent/2/View`, title: 'Rubric' } });
    const refs = buildTrustedRefs(session(), { links: [rubric], tabs: [], tasks: [], notes: [] });
    const result = guardToolCall({ tool: 'read_rubric', linkRef: 'L1' }, refs, baseCtx({ lmsOrigins: [CLASSIFIED_ORIGIN] }));
    expect(result).toEqual(expect.objectContaining({
      kind: 'ok',
      step: expect.objectContaining({ action: 'read-page', input: expect.objectContaining({ url: rubric.to.url }) }),
    }));
  });

  it('rejects a rubric link labeled "Rubric" whose route the adapter does not classify as readable (SOL-10)', () => {
    // The exact forgery scenario from the review: an anchor's *label* says
    // "Rubric" (so derive.ts tags the relation has-rubric), but the href is
    // an unclassified/unsafe same-origin route. Label text must never be
    // authority.
    const forged = link({
      relation: 'has-rubric',
      to: { kind: 'page', url: `${CLASSIFIED_ORIGIN}/d2l/logout`, title: 'Rubric' },
    });
    const refs = buildTrustedRefs(session(), { links: [forged], tabs: [], tasks: [], notes: [] });
    const result = guardToolCall({ tool: 'read_rubric', linkRef: 'L1' }, refs, baseCtx({ lmsOrigins: [CLASSIFIED_ORIGIN] }));
    expect(result.kind).toBe('rejected');
  });

  it('resolves a course navigation request to an open-tab URL', () => {
    const courseOrigin = 'https://school.brightspace.com';
    const current = session({
      context: { sources: [{
        url: `${courseOrigin}/d2l/home/363`, title: 'Course home', kind: 'other', excluded: false, provenance: 'observed page', excerpt: '',
      }] },
    });
    const refs = buildTrustedRefs(current, { links: [], tabs: [], tasks: [], notes: [] });
    const result = guardToolCall({ tool: 'open_course_page', page: 'assignments' }, refs, baseCtx({ lmsOrigins: [courseOrigin] }));
    expect(result).toEqual(expect.objectContaining({
      kind: 'ok',
      step: expect.objectContaining({ action: 'open-tab', input: expect.objectContaining({ url: `${courseOrigin}/d2l/lms/dropbox/user/folders_list.d2l?ou=363` }) }),
    }));
  });

  it('rejects a tabRef outside the workspace', () => {
    const refs = buildTrustedRefs(session(), { links: [], tabs: [{ tabId: 1, url: `${LMS_ORIGIN}/x` }], tasks: [], notes: [] });
    const result = guardToolCall({ tool: 'read_page', tabRef: 'T99' }, refs, baseCtx());
    expect(result.kind).toBe('rejected');
  });

  it('rejects a stale handle not present in the latest snapshot', () => {
    const tabs = [{ tabId: 1, url: `${LMS_ORIGIN}/x` }];
    const snapshots = { 1: snapshot([{ handle: 'e1', role: 'button', tag: 'button', label: 'Save draft', disabled: false }]) };
    const refs = buildTrustedRefs(session(), { links: [], tabs, snapshots, tasks: [], notes: [] });
    const result = guardToolCall({ tool: 'click', tabRef: 'T1', handle: 'e-stale' }, refs, baseCtx());
    expect(result.kind).toBe('rejected');
  });

  it('classifies a click on a "Submit" element as needs-fresh-approval / submit-assignment', () => {
    const tabs = [{ tabId: 1, url: `${LMS_ORIGIN}/x` }];
    const snapshots = {
      1: snapshot([{ handle: 'e1', role: 'button', tag: 'button', label: 'Submit Assignment', disabled: false }]),
    };
    const refs = buildTrustedRefs(session(), { links: [], tabs, snapshots, tasks: [], notes: [] });
    const result = guardToolCall({ tool: 'click', tabRef: 'T1', handle: 'e1' }, refs, baseCtx());
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.step.action).toBe('submit-assignment');
      expect(result.decision.decision).toBe('needs-fresh-approval');
    }
  });

  it('forbids fill_field in a restricted assessment tab', () => {
    const tabs = [{ tabId: 1, url: `${LMS_ORIGIN}/x` }];
    const snapshots = { 1: snapshot([{ handle: 'e1', role: 'textbox', tag: 'input', label: 'Answer', disabled: false }]) };
    const refs = buildTrustedRefs(session(), { links: [], tabs, snapshots, tasks: [], notes: [] });
    const ctx = baseCtx({ assessmentRestrictedByTabRef: { T1: true } });
    const result = guardToolCall({ tool: 'fill_field', tabRef: 'T1', handle: 'e1', value: 'answer' }, refs, ctx);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') expect(result.decision.decision).toBe('forbid');
  });

  it('still allows read_page in a restricted assessment tab', () => {
    const tabs = [{ tabId: 1, url: `${LMS_ORIGIN}/x` }];
    const refs = buildTrustedRefs(session(), { links: [], tabs, tasks: [], notes: [] });
    const ctx = baseCtx({ assessmentRestrictedByTabRef: { T1: true } });
    const result = guardToolCall({ tool: 'read_page', tabRef: 'T1' }, refs, ctx);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') expect(result.decision.decision).toBe('allow');
  });

  it('maps snapshot-bound scroll and focus tools to their automatic actions', () => {
    const tabs = [{ tabId: 1, url: `${LMS_ORIGIN}/x` }];
    const snapshots = { 1: snapshot([{ handle: 'e1', role: 'textbox', tag: 'input', label: 'Answer', disabled: false }]) };
    const refs = buildTrustedRefs(session(), { links: [], tabs, snapshots, tasks: [], notes: [] });
    const ctx = baseCtx({ assessmentRestrictedByTabRef: { T1: true } });

    for (const [tool, action] of [['scroll_to', 'scroll-to'], ['focus_element', 'focus-element']] as const) {
      const result = guardToolCall({ tool, tabRef: 'T1', handle: 'e1' }, refs, ctx);
      expect(result).toMatchObject({ kind: 'ok', step: { action }, decision: { decision: 'allow' } });
    }
  });

  it('allows a configurable action automatically when the student enabled it', () => {
    const tabs = [{ tabId: 1, url: `${LMS_ORIGIN}/x` }];
    const snapshots = { 1: snapshot([{ handle: 'e1', role: 'textbox', tag: 'input', label: 'Comment', disabled: false }]) };
    const refs = buildTrustedRefs(session(), { links: [], tabs, snapshots, tasks: [], notes: [] });
    const ctx = baseCtx({ allowedConfigurable: new Set(['fill-form-field']) });
    const result = guardToolCall({ tool: 'fill_field', tabRef: 'T1', handle: 'e1', value: 'x' }, refs, ctx);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') expect(result.decision.decision).toBe('allow');
  });

  it('produces stable step ids from turnSeq and index', () => {
    const refs = buildTrustedRefs(session(), { links: [], tabs: [], tasks: [], notes: [] });
    const ctx = baseCtx({ turnSeq: 7 });
    const result = guardToolCall({ tool: 'build_checklist' }, refs, ctx, 2);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') expect(result.step.id).toBe('t7-2');
  });
});
