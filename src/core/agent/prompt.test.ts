import { describe, expect, it } from 'vitest';
import { buildAgentPrompt } from './prompt';
import { buildTrustedRefs } from './refs';
import type { AgentSession } from '../session';

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

describe('buildAgentPrompt', () => {
  it('contains the four section headers in order', () => {
    const refs = buildTrustedRefs(session(), { links: [], tabs: [], tasks: [], notes: [] });
    const prompt = buildAgentPrompt({ session: session(), goalText: 'Work on Assignment 2', refs });
    const iSystem = prompt.indexOf('# SYSTEM / MOTION POLICY');
    const iGoal = prompt.indexOf('# USER GOAL');
    const iTrusted = prompt.indexOf('# TRUSTED MOTION STATE');
    expect(iSystem).toBeGreaterThanOrEqual(0);
    expect(iGoal).toBeGreaterThan(iSystem);
    expect(iTrusted).toBeGreaterThan(iGoal);
  });

  it('fences untrusted page content and it never becomes a section header', () => {
    const refs = buildTrustedRefs(session(), { links: [], tabs: [], tasks: [], notes: [] });
    const prompt = buildAgentPrompt({
      session: session(),
      goalText: 'Work on Assignment 2',
      refs,
      pageContent: { url: 'https://lms.example.edu/a2', title: 'Assignment 2', text: 'Read chapter 3 and write a summary.' },
    });
    expect(prompt).toContain('UNTRUSTED PAGE CONTENT');
    expect(prompt).toContain('BEGIN UNTRUSTED');
    expect(prompt).toContain('Read chapter 3 and write a summary.');
  });

  it('truncates an oversized prompt with a visible marker', () => {
    const refs = buildTrustedRefs(session(), { links: [], tabs: [], tasks: [], notes: [] });
    const prompt = buildAgentPrompt({
      session: session(),
      goalText: 'Work on Assignment 2',
      refs,
      pageContent: { url: 'https://lms.example.edu/a2', title: 'Assignment 2', text: 'x'.repeat(100_000) },
    });
    expect(prompt.length).toBeLessThan(30_000);
    expect(prompt).toContain('truncated');
  });

  it('never embeds a canary secret placed in unrelated session state into the prompt', () => {
    const canary = 'CANARY-SECRET-DO-NOT-LEAK-93af1';
    const withCanary = session({ agent: { providerId: canary, model: null } });
    const refs = buildTrustedRefs(withCanary, { links: [], tabs: [], tasks: [], notes: [] });
    const prompt = buildAgentPrompt({ session: withCanary, goalText: 'Work on Assignment 2', refs });
    expect(prompt).not.toContain(canary);
  });
});
