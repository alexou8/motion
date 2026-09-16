import { describe, expect, it } from 'vitest';
import type { Course, CourseTask } from '../domain';
import {
  ACTIVITY_CAP,
  CONVERSATION_CAP,
  InvalidSessionTransitionError,
  adoptTab,
  advancePlanStep,
  agentSessionSchema,
  appendActivity,
  appendMessage,
  clearBlocker,
  excludeSource,
  isMotionOwned,
  recordBlocker,
  releaseTab,
  resolveTaskForGoal,
  restartFromStep,
  sessionTitle,
  setPlan,
  transitionSession,
} from './index';

const NOW = '2026-03-02T12:00:00.000Z';

function session(overrides: Partial<Parameters<typeof agentSessionSchema.parse>[0]> = {}) {
  return agentSessionSchema.parse({
    id: 's1',
    title: 'CP363 · Assignment 2',
    goal: 'Work on Assignment 2',
    courseId: 'course-1',
    taskId: null,
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  });
}

describe('sessionTitle', () => {
  it('joins course code and task title', () => {
    expect(sessionTitle('CP363', 'Assignment 2')).toBe('CP363 · Assignment 2');
  });

  it('falls back to the bare goal when there is no course code', () => {
    expect(sessionTitle(null, 'Catch up on unfinished coursework')).toBe(
      'Catch up on unfinished coursework',
    );
  });

  it('bounds the length', () => {
    const long = 'A'.repeat(200);
    const title = sessionTitle('CP363', long, 20);
    expect(title.length).toBeLessThanOrEqual(20);
    expect(title.startsWith('CP363 · ')).toBe(true);
  });
});

describe('transitionSession', () => {
  it('allows a valid move', () => {
    const s = session({ status: 'active' });
    const next = transitionSession(s, 'working', '2026-03-02T12:05:00.000Z');
    expect(next.status).toBe('working');
    expect(next.updatedAt).toBe('2026-03-02T12:05:00.000Z');
  });

  it('rejects an invalid move', () => {
    const s = session({ status: 'archived' });
    expect(() => transitionSession(s, 'working', NOW)).toThrow(InvalidSessionTransitionError);
  });

  it('rejects completed -> working directly', () => {
    const s = session({ status: 'completed' });
    expect(() => transitionSession(s, 'working', NOW)).toThrow();
  });

  it('is a no-op transitioning to the same status', () => {
    const s = session({ status: 'active' });
    expect(transitionSession(s, 'active', NOW)).toBe(s);
  });
});

describe('appendActivity / appendMessage caps', () => {
  it('caps activity at ACTIVITY_CAP, dropping the oldest', () => {
    let s = session();
    for (let i = 0; i < ACTIVITY_CAP + 10; i++) {
      s = appendActivity(s, { id: `a${i}`, kind: 'info', summary: `entry ${i}` }, NOW);
    }
    expect(s.activity).toHaveLength(ACTIVITY_CAP);
    expect(s.activity[0]!.id).toBe('a10');
    expect(s.activity.at(-1)!.id).toBe(`a${ACTIVITY_CAP + 9}`);
  });

  it('caps conversation at CONVERSATION_CAP, dropping the oldest', () => {
    let s = session();
    for (let i = 0; i < CONVERSATION_CAP + 5; i++) {
      s = appendMessage(s, { id: `m${i}`, role: 'student', text: `msg ${i}` }, NOW);
    }
    expect(s.conversation).toHaveLength(CONVERSATION_CAP);
    expect(s.conversation[0]!.id).toBe('m5');
  });
});

describe('blockers', () => {
  it('records and clears a blocker', () => {
    let s = session();
    s = recordBlocker(s, { id: 'b1', kind: 'approval', message: 'Needs approval' }, NOW);
    expect(s.blockers).toHaveLength(1);
    s = clearBlocker(s, 'b1', NOW);
    expect(s.blockers).toHaveLength(0);
  });
});

describe('workspace ownership and tab helpers', () => {
  it('adopts a user tab', () => {
    let s = session();
    s = adoptTab(s, 42, NOW);
    expect(s.workspace.adoptedTabIds).toContain(42);
  });

  it('user-closed tab is removed and never re-added', () => {
    let s = session();
    s.workspace.ownedTabIds.push(7); // seed as owned via mutation on a fresh parse copy
    s = { ...s, workspace: { ...s.workspace, ownedTabIds: [7] } };

    s = releaseTab(s, 7, 'user closed tab 7', NOW);
    expect(s.workspace.ownedTabIds).not.toContain(7);
    expect(s.workspace.releasedTabIds).toContain(7);
    expect(s.activity.some((a) => a.kind === 'user-override')).toBe(true);

    // A later re-scan tries to adopt/own it again — must be refused.
    const reattempt = adoptTab(s, 7, NOW);
    expect(reattempt.workspace.adoptedTabIds).not.toContain(7);
    expect(reattempt).toBe(s);
  });

  it('isMotionOwned is scoped to the session key, like workspace ownership.ts', () => {
    const s = session({
      workspace: {
        groupId: 1,
        groupTitle: 'Motion · CP363',
        sessionKey: 'session-A',
        ownedTabIds: [5],
        adoptedTabIds: [],
        releasedTabIds: [],
      },
    });
    expect(isMotionOwned(s, 5, 'session-A')).toBe(true);
    expect(isMotionOwned(s, 5, 'session-B')).toBe(false);
    expect(isMotionOwned(s, 99, 'session-A')).toBe(false);
  });

  it('excludeSource marks a matching source excluded', () => {
    const s = session({
      context: {
        sources: [
          { url: 'https://lms.example.com/rubric', title: 'Rubric', kind: 'rubric', excluded: false, provenance: '' },
        ],
      },
    });
    const next = excludeSource(s, 'https://lms.example.com/rubric', NOW);
    expect(next.context.sources[0]!.excluded).toBe(true);
  });
});

describe('plan helpers', () => {
  const steps = [
    { id: 'p1', title: 'Read instructions', status: 'pending' as const },
    { id: 'p2', title: 'Read rubric', status: 'pending' as const },
    { id: 'p3', title: 'Draft section 2', status: 'pending' as const },
  ];

  it('setPlan activates the first pending step', () => {
    const s = setPlan(session(), steps, NOW);
    expect(s.plan.currentStepId).toBe('p1');
    expect(s.plan.steps[0]!.status).toBe('active');
  });

  it('advancePlanStep marks current done and activates the next', () => {
    let s = setPlan(session(), steps, NOW);
    s = advancePlanStep(s, NOW);
    expect(s.plan.steps[0]!.status).toBe('done');
    expect(s.plan.steps[1]!.status).toBe('active');
    expect(s.plan.currentStepId).toBe('p2');
  });

  it('restartFromStep resets it and everything after to pending, activating it', () => {
    let s = setPlan(session(), steps, NOW);
    s = advancePlanStep(s, NOW); // p1 done, p2 active
    s = advancePlanStep(s, NOW); // p2 done, p3 active
    s = restartFromStep(s, 'p2', NOW);
    expect(s.plan.steps[0]!.status).toBe('done'); // untouched, before the restart point
    expect(s.plan.steps[1]!.status).toBe('active');
    expect(s.plan.steps[2]!.status).toBe('pending');
    expect(s.plan.currentStepId).toBe('p2');
  });
});

describe('resolveTaskForGoal', () => {
  const courses: Course[] = [
    { id: 'c1', platformId: 'd2l', name: 'Database II', code: 'CP363', lastVerifiedAt: NOW, archived: false },
    { id: 'c2', platformId: 'd2l', name: 'Software Design', code: 'CP312', lastVerifiedAt: NOW, archived: false },
  ];

  function task(overrides: Partial<CourseTask>): CourseTask {
    return {
      id: overrides.id ?? 't',
      courseId: overrides.courseId ?? 'c1',
      title: overrides.title ?? 'Assignment 1',
      kind: 'assignment',
      due: { iso: null, raw: '', zoneEvidence: 'none', timeAssumed: false, confidence: 'low' },
      status: 'todo',
      weight: null,
      provenance: {
        sourceUrl: 'https://lms.example.com/a',
        pageTitle: '',
        platformId: 'd2l',
        pageType: 'assignment',
        capturedAt: NOW,
        extractionVersion: 1,
      },
      corrections: [],
      studentEdited: false,
      manual: false,
      archived: false,
      createdAt: NOW,
      updatedAt: NOW,
      ...overrides,
    };
  }

  it('matches "CP363 assignment 2" to the right task with high confidence', () => {
    const tasks = [
      task({ id: 't1', courseId: 'c1', title: 'Assignment 2' }),
      task({ id: 't2', courseId: 'c2', title: 'Assignment 2' }),
    ];
    const result = resolveTaskForGoal('CP363 assignment 2', tasks, courses);
    expect(result.task?.id).toBe('t1');
    expect(result.confidence).toBe('high');
    expect(result.ambiguous).toHaveLength(0);
  });

  it('matches "lab 3" by kind + number without a course', () => {
    const tasks = [
      task({ id: 't1', title: 'Lab 3: Recursion' }),
      task({ id: 't2', title: 'Lab 4: Iteration' }),
    ];
    const result = resolveTaskForGoal('lab 3', tasks, courses);
    expect(result.task?.id).toBe('t1');
  });

  it('returns ambiguity when two tasks tie and no course narrows it', () => {
    const tasks = [
      task({ id: 't1', courseId: 'c1', title: 'Assignment 2' }),
      task({ id: 't2', courseId: 'c2', title: 'Assignment 2' }),
    ];
    const result = resolveTaskForGoal('assignment 2', tasks, courses);
    expect(result.task).toBeNull();
    expect(result.ambiguous.length).toBeGreaterThanOrEqual(2);
  });

  it('returns none confidence when nothing matches', () => {
    const tasks = [task({ id: 't1', title: 'Discussion 1' })];
    const result = resolveTaskForGoal('xyz completely unrelated', tasks, courses);
    expect(result.task).toBeNull();
    expect(result.confidence).toBe('none');
  });
});
