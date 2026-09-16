import { describe, expect, it } from 'vitest';
import { fallbackPlan } from './fallback';
import type { CourseLink } from '../graph';
import type { Course, CourseTask } from '../domain';

const NOW = '2026-03-02T12:00:00.000Z';

function task(overrides: Partial<CourseTask> = {}): CourseTask {
  return {
    id: 't1',
    courseId: 'c1',
    title: 'Assignment 2',
    kind: 'assignment',
    due: { iso: '2026-03-10T23:59:00.000Z', raw: 'Mar 10', zoneEvidence: 'explicit', timeAssumed: false, confidence: 'high' },
    status: 'todo',
    weight: null,
    provenance: { sourceUrl: 'https://lms.example.edu/a2', pageTitle: '', platformId: 'd2l', pageType: 'assignment', capturedAt: NOW, extractionVersion: 1 },
    corrections: [],
    studentEdited: false,
    manual: false,
    archived: false,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function course(overrides: Partial<Course> = {}): Course {
  return {
    id: 'c1',
    platformId: 'd2l',
    name: 'Software Design',
    code: 'CP363',
    lastVerifiedAt: NOW,
    archived: false,
    ...overrides,
  };
}

function rubricLink(): CourseLink {
  return {
    id: 'link-rubric',
    courseId: 'c1',
    taskId: 't1',
    from: { kind: 'task', id: 't1' },
    relation: 'has-rubric',
    to: { kind: 'page', url: 'https://lms.example.edu/rubric', title: 'Rubric' },
    confidence: 'high',
    provenance: { sourceUrl: 'https://lms.example.edu/a2', pageTitle: '', platformId: 'd2l', pageType: 'assignment', capturedAt: NOW, extractionVersion: 1 },
    userOverride: null,
  };
}

describe('fallbackPlan', () => {
  it('resolves the task and opens resources, instructions, and builds a checklist', () => {
    const result = fallbackPlan('work on assignment 2', { tasks: [task()], courses: [course()], links: [] });
    expect(result.taskId).toBe('t1');
    expect(result.usedAi).toBe(false);
    const tools = result.plan.map((s) => s.call.tool);
    expect(tools).toContain('open_assignment_resources');
    expect(tools).toContain('read_assignment_instructions');
    expect(tools).toContain('build_checklist');
    expect(result.reply.toLowerCase()).toContain('no ai provider');
  });

  it('includes read_rubric when a rubric link exists for the task', () => {
    const result = fallbackPlan('CP363 assignment 2', {
      tasks: [task()],
      courses: [course()],
      links: [rubricLink()],
    });
    const tools = result.plan.map((s) => s.call.tool);
    expect(tools).toContain('read_rubric');
  });

  it('omits read_rubric when no rubric link exists', () => {
    const result = fallbackPlan('assignment 2', { tasks: [task()], courses: [course()], links: [] });
    const tools = result.plan.map((s) => s.call.tool);
    expect(tools).not.toContain('read_rubric');
  });

  it('returns an empty plan and asks for clarification when no task resolves', () => {
    const result = fallbackPlan('do the thing', { tasks: [task()], courses: [course()], links: [] });
    expect(result.taskId).toBeNull();
    expect(result.plan).toHaveLength(0);
  });
});
