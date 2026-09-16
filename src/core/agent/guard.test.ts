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
    pendingModelRequest: null,
    ...overrides,
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
