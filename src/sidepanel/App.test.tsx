import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { ApprovalRequest } from '../core/policy';
import type { CourseTask, Course } from '../core/domain';
import type { AgentSession } from '../core/session/types';
import { EMPTY_PANEL_STATE, type PanelState } from '../core/view/state';
import { App } from './App';
import type { MotionBridge, MotionCommand } from './bridge';

const NOW = new Date('2026-09-16T12:00:00.000Z');

const course: Course = {
  id: 'course-1',
  platformId: 'test-platform',
  name: 'Synthetic course',
  code: 'TEST 101',
  lastVerifiedAt: NOW.toISOString(),
  archived: false,
};

const task: CourseTask = {
  id: 'task-1',
  courseId: course.id,
  title: 'Read the chapter',
  kind: 'assignment',
  due: {
    iso: '2026-09-17T16:00:00.000Z',
    raw: 'Thursday, maybe at noon',
    zoneEvidence: 'assumed-local',
    timeAssumed: true,
    confidence: 'low',
  },
  dueHistory: [],
  dueConflict: null,
  status: 'todo',
  weight: 10,
  provenance: {
    sourceUrl: 'https://lms.example.test/course/1/assignments',
    pageTitle: 'Synthetic assignments',
    platformId: 'test-platform',
    pageType: 'assignment-list',
    capturedAt: NOW.toISOString(),
    extractionVersion: 1,
  },
  corrections: [],
  studentEdited: false,
  manual: false,
  archived: false,
  createdAt: NOW.toISOString(),
  updatedAt: NOW.toISOString(),
};

const session: AgentSession = {
  id: 'session-1', revision: 0,
  title: 'CP363 · Assignment 2',
  goal: 'Work on Assignment 2',
  courseId: course.id,
  taskId: task.id,
  status: 'working',
  createdAt: NOW.toISOString(),
  updatedAt: NOW.toISOString(),
  workspace: { groupId: 1, groupTitle: 'CP363', sessionKey: 'session-key', ownedTabIds: [11], adoptedTabIds: [22], releasedTabIds: [] },
  plan: {
    steps: [
      { id: 'step-1', title: 'Read the instructions', status: 'done' },
      { id: 'step-2', title: 'Draft an outline', status: 'active', rationale: 'The rubric weights structure heavily.' },
      { id: 'step-3', title: 'Write the draft', status: 'pending' },
    ],
    currentStepId: 'step-2',
  },
  blockers: [],
  context: { sources: [{ url: 'https://lms.example.test/course/1/rubric', title: 'Rubric', kind: 'rubric', excluded: false, provenance: 'assignment page', excerpt: '' }] },
  artifacts: [{ id: 'artifact-1', kind: 'checklist', refId: 'checklist-1', title: 'Assignment 2 checklist', createdAt: NOW.toISOString() }],
  agent: { providerId: 'chrome-local', model: 'chrome-on-device' },
  conversation: [
    { id: 'c1', role: 'student', text: 'Work on Assignment 2', at: NOW.toISOString() },
    { id: 'c2', role: 'motion', text: 'Starting with the rubric.', at: NOW.toISOString() },
  ],
  activity: [{ id: 'a1', at: NOW.toISOString(), kind: 'plan', summary: 'Read the rubric.', sourceUrl: 'https://lms.example.test/course/1/rubric' }],
  workflowIds: ['workflow-1'],
  modelTurnGeneration: 0,
  pendingModelRequest: null,
};

const approval: ApprovalRequest = {
  id: 'approval-1',
  workflowId: 'workflow-1',
  stepId: 'step-3',
  action: 'submit-assignment',
  risk: 'high',
  tier: 'fresh-confirmation',
  summary: 'Submit "Assignment 2 - report.pdf" to CP363 Assignment 2?',
  target: 'CP363 Assignment 2',
  effect: 'This will create a final LMS submission.',
  reversible: false,
  payload: { file: 'Assignment 2 - report.pdf' },
  status: 'pending',
  requestedAt: NOW.toISOString(),
  decidedAt: null,
  expiresAt: '2026-09-16T12:02:00.000Z',
};

function state(overrides: Partial<PanelState> = {}): PanelState {
  return {
    ...EMPTY_PANEL_STATE,
    connection: 'supported',
    page: {
      url: 'https://lms.example.test/course/1/assignments',
      pageType: 'assignment-list',
      title: 'Synthetic assignments',
      restrictionReason: null,
      warnings: [],
      observedAt: NOW.toISOString(),
    },
    course,
    ...overrides,
  };
}

function bridgeFor(panelState: PanelState, commands: MotionCommand[] = []): MotionBridge {
  return {
    getState: () => panelState,
    subscribe: () => () => undefined,
    send: (command) => {
      commands.push(command);
    },
  };
}

describe('connection views on Home', () => {
  it.each([
    ['idle', 'Motion organizes coursework'],
    ['unsupported', 'Synthetic assignments'],
    ['permission-needed', 'Let Motion read Synthetic assignments'],
    ['restricted', 'Restricted mode'],
  ] as const)('renders the %s view', (connection, heading) => {
    render(<App bridge={bridgeFor(state({ connection }))} now={NOW} />);
    expect(screen.getByRole('heading', { name: heading })).toBeInTheDocument();
  });
});

it('keeps restricted mode read-only and free of automation controls', () => {
  render(
    <App
      bridge={bridgeFor(state({ connection: 'restricted', page: { ...state().page, restrictionReason: 'Graded attempt detected.' } }))}
      now={NOW}
    />,
  );
  expect(screen.getByText('Graded attempt detected.')).toBeInTheDocument();
  expect(screen.queryAllByRole('button').map((button) => button.getAttribute('aria-label'))).toEqual(['Settings']);
  expect(screen.queryAllByRole('textbox')).toHaveLength(0);
});

describe('Home', () => {
  it('renders deadline buckets, resolving ids against state.tasks, and the session list', () => {
    render(
      <App
        bridge={bridgeFor(
          state({
            tasks: [task],
            deadlines: { today: [], upcoming: [], overdue: [], needsReview: [task.id] },
            sessions: [{ id: session.id, title: session.title, status: 'working', courseId: course.id, taskId: task.id, updatedAt: NOW.toISOString(), needsYou: 1, currentStepTitle: 'Draft an outline' }],
          }),
        )}
        now={NOW}
      />,
    );
    expect(screen.getAllByText('Needs review').length).toBeGreaterThan(0);
    expect(screen.getByText('Source text: Thursday, maybe at noon')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Synthetic assignments.*lms\.example\.test/ })).toHaveAttribute('href', task.provenance.sourceUrl);
    expect(screen.getByText('CP363 · Assignment 2')).toBeInTheDocument();
    expect(screen.getByText('Needs you · 1')).toBeInTheDocument();
  });

  it('renders a moved date with visible and accessible text', () => {
    const moved = {
      ...task,
      due: { ...task.due, iso: '2026-09-24T16:00:00.000Z', zoneEvidence: 'explicit' as const, timeAssumed: false, confidence: 'high' as const },
      dueHistory: [{
        iso: '2026-09-17T16:00:00.000Z', raw: 'Due Sep 17', observedAt: NOW.toISOString(), provenance: task.provenance,
      }],
      dueChangedAt: NOW.toISOString(),
    };
    render(<App bridge={bridgeFor(state({ tasks: [moved], deadlines: { today: [], upcoming: [moved.id], overdue: [], needsReview: [] } }))} now={NOW} />);

    expect(screen.getByText('Moved')).toBeInTheDocument();
    expect(screen.getByText('Moved from')).toBeInTheDocument();
    expect(screen.getByText('Thu, Sep 17')).toHaveAccessibleName('Previously due Thu, Sep 17');
  });

  it('remembers a deadline view selection in local storage', async () => {
    const user = userEvent.setup();
    const set = vi.fn(async () => undefined);
    vi.stubGlobal('chrome', { storage: { local: { get: vi.fn(async () => ({})), set } } });
    try {
      render(<App bridge={bridgeFor(state({ tasks: [task], deadlines: { today: [], upcoming: [task.id], overdue: [], needsReview: [] } }))} now={NOW} />);
      await user.click(screen.getByRole('button', { name: 'Week' }));
      expect(screen.getByRole('button', { name: 'Week' })).toHaveAttribute('aria-pressed', 'true');
      expect(set).toHaveBeenCalledWith({ 'motion.deadlines.view': 'week' });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does not label a high-confidence later deadline as needing review in Week view', async () => {
    const user = userEvent.setup();
    const laterTask = { ...task, id: 'later-task', due: { ...task.due, iso: '2026-10-20T12:00:00.000Z', confidence: 'high' as const, zoneEvidence: 'explicit' as const } };
    render(<App bridge={bridgeFor(state({ tasks: [laterTask], deadlines: { today: [], upcoming: [], overdue: [], needsReview: [] } }))} now={NOW} />);
    await user.click(screen.getByRole('button', { name: 'Week' }));
    expect(screen.getByText(/Later/)).toBeInTheDocument();
    expect(screen.queryByText('Motion is not confident in this date.')).not.toBeInTheDocument();
  });

  it('sends session-create from the composer', async () => {
    const user = userEvent.setup();
    const commands: MotionCommand[] = [];
    render(<App bridge={bridgeFor(state(), commands)} now={NOW} />);

    await user.type(screen.getByLabelText('What do you want to work on?'), 'Work on Assignment 2{Enter}');

    expect(commands).toEqual([{ type: 'session-create', goal: 'Work on Assignment 2', tabId: null }]);
  });

  it('sends session-create from a suggestion chip', async () => {
    const user = userEvent.setup();
    const commands: MotionCommand[] = [];
    render(
      <App
        bridge={bridgeFor(
          state({ page: { ...state().page, pageType: 'assignment' }, deadlines: { today: [], upcoming: [], overdue: [], needsReview: [] } }),
          commands,
        )}
        now={NOW}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Work on Synthetic assignments' }));
    expect(commands).toEqual([{ type: 'session-create', goal: 'Work on Synthetic assignments', tabId: null }]);
  });

  it('opens a session from the list, sending session-select', async () => {
    const user = userEvent.setup();
    const commands: MotionCommand[] = [];
    render(
      <App
        bridge={bridgeFor(
          state({ sessions: [{ id: session.id, title: session.title, status: 'working', courseId: course.id, taskId: task.id, updatedAt: NOW.toISOString(), needsYou: 0, currentStepTitle: null }] }),
          commands,
        )}
        now={NOW}
      />,
    );
    await user.click(screen.getByRole('button', { name: /CP363 · Assignment 2/ }));
    expect(commands).toContainEqual({ type: 'session-select', sessionId: session.id });
  });
});

describe('SessionView', () => {
  function withSession(overrides: Partial<PanelState> = {}) {
    return state({ activeSession: session, tasks: [task], ...overrides });
  }

  it('shows plan, workspace, and needs-you', () => {
    render(<App bridge={bridgeFor(withSession({ approvals: [approval] }))} now={NOW} />);
    expect(screen.getByRole('heading', { name: 'CP363 · Assignment 2' })).toBeInTheDocument();
    expect(screen.getByText('Read the instructions')).toBeInTheDocument();
    expect(screen.getByText('Draft an outline')).toBeInTheDocument();
    expect(screen.getByText('Workspace · 2 tabs')).toBeInTheDocument();
    expect(screen.getByText('Needs you')).toBeInTheDocument();
  });

  it('shows the provider chip, marking a cloud provider', () => {
    render(
      <App
        bridge={bridgeFor(withSession({ ai: { providerId: 'openai', displayName: 'OpenAI', cloud: true, status: 'available', message: 'Ready.' } }))}
        now={NOW}
      />,
    );
    expect(screen.getByText('AI · OpenAI')).toBeInTheDocument();
  });

  it('opens the fresh-confirmation approval dialog with the exact summary/target/effect and no always-allow control', async () => {
    const user = userEvent.setup();
    const commands: MotionCommand[] = [];
    render(<App bridge={bridgeFor(withSession({ approvals: [approval] }), commands)} now={NOW} />);

    await user.click(screen.getByRole('button', { name: 'Review' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(approval.summary)).toBeInTheDocument();
    expect(within(dialog).getByText(/Target: CP363 Assignment 2/)).toBeInTheDocument();
    expect(within(dialog).getByText(/final LMS submission/)).toBeInTheDocument();
    expect(within(dialog).queryByText(/always allow/i)).not.toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    expect(commands).toContainEqual({ type: 'decide-approval', approvalId: approval.id, approved: true });
  });

  it('sends stop-generation while streaming', async () => {
    const user = userEvent.setup();
    const commands: MotionCommand[] = [];
    render(
      <App
        bridge={bridgeFor(withSession({ streaming: { sessionId: session.id, text: 'Drafting the outline…' } }), commands)}
        now={NOW}
      />,
    );
    expect(screen.getByRole('log')).toHaveTextContent('Drafting the outline…');
    await user.click(screen.getByRole('button', { name: 'Stop' }));
    expect(commands).toContainEqual({ type: 'session-command', sessionId: session.id, command: 'stop-generation' });
  });

  it('announces streaming text in the live log', () => {
    render(
      <App
        bridge={bridgeFor(withSession({ streaming: { sessionId: session.id, text: 'Drafting the outline…' } }))}
        now={NOW}
      />,
    );
    const log = screen.getByRole('log');
    expect(log).toHaveAttribute('aria-live', 'polite');
    expect(within(log).getByText('Drafting the outline…')).toBeInTheDocument();
  });

  it('sends session-message on Enter and a newline on Shift+Enter', async () => {
    const user = userEvent.setup();
    const commands: MotionCommand[] = [];
    render(<App bridge={bridgeFor(withSession(), commands)} now={NOW} />);
    const input = screen.getByLabelText('Message Motion');

    await user.type(input, 'line one{Shift>}{Enter}{/Shift}line two');
    expect(input).toHaveValue('line one\nline two');
    expect(commands).toHaveLength(0);

    await user.clear(input);
    await user.type(input, 'Keep going{Enter}');
    expect(commands).toContainEqual({ type: 'session-message', sessionId: session.id, text: 'Keep going', tabId: null });
  });

  it('goes back to the session list', async () => {
    const user = userEvent.setup();
    const commands: MotionCommand[] = [];
    render(<App bridge={bridgeFor(withSession(), commands)} now={NOW} />);
    await user.click(screen.getByRole('button', { name: /Sessions/ }));
    expect(commands).toContainEqual({ type: 'session-select', sessionId: null });
  });
});
