import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
  id: 'session-1',
  revision: 0,
  title: 'CP363 · Assignment 2',
  goal: 'Work on Assignment 2',
  courseId: course.id,
  taskId: task.id,
  status: 'working',
  createdAt: NOW.toISOString(),
  updatedAt: NOW.toISOString(),
  workspace: {
    groupId: 1,
    groupTitle: 'CP363',
    sessionKey: 'session-key',
    ownedTabIds: [11],
    adoptedTabIds: [22],
    releasedTabIds: [],
  },
  plan: {
    steps: [
      { id: 'step-1', title: 'Read the instructions', status: 'done' },
      {
        id: 'step-2',
        title: 'Draft an outline',
        status: 'active',
        rationale: 'The rubric weights structure heavily.',
      },
      { id: 'step-3', title: 'Write the draft', status: 'pending' },
    ],
    currentStepId: 'step-2',
  },
  blockers: [],
  context: {
    sources: [
      {
        url: 'https://lms.example.test/course/1/rubric',
        title: 'Rubric',
        kind: 'rubric',
        excluded: false,
        provenance: 'assignment page',
        excerpt: '',
      },
    ],
  },
  artifacts: [
    {
      id: 'artifact-1',
      kind: 'checklist',
      refId: 'checklist-1',
      title: 'Assignment 2 checklist',
      createdAt: NOW.toISOString(),
    },
  ],
  agent: { providerId: 'chrome-local', model: 'chrome-on-device' },
  conversation: [
    { id: 'c1', role: 'student', text: 'Work on Assignment 2', at: NOW.toISOString() },
    { id: 'c2', role: 'motion', text: 'Starting with the rubric.', at: NOW.toISOString() },
  ],
  activity: [
    {
      id: 'a1',
      at: NOW.toISOString(),
      kind: 'plan',
      summary: 'Read the rubric.',
      sourceUrl: 'https://lms.example.test/course/1/rubric',
    },
  ],
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
    send: async (command) => {
      commands.push(command);
      return { ok: true };
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
      bridge={bridgeFor(
        state({
          connection: 'restricted',
          page: { ...state().page, restrictionReason: 'Graded attempt detected.' },
        }),
      )}
      now={NOW}
    />,
  );
  expect(screen.getByText('Graded attempt detected.')).toBeInTheDocument();
  expect(
    screen.queryAllByRole('button').map((button) => button.getAttribute('aria-label')),
  ).toEqual(['Settings']);
  expect(screen.queryAllByRole('textbox')).toHaveLength(0);
});

describe('Home', () => {
  it('keeps the current-page reader available after saving an undated material', async () => {
    const user = userEvent.setup();
    const commands: MotionCommand[] = [];
    const saved = state({
      tasks: [
        {
          ...task,
          kind: 'content',
          due: { ...task.due, iso: null, raw: '', zoneEvidence: 'none' },
        },
      ],
    });
    const { rerender } = render(<App bridge={bridgeFor(saved, commands)} now={NOW} />);
    const read = screen.getByRole('button', { name: 'Read this page' });
    read.focus();
    await user.keyboard('{Enter}');
    expect(commands).toEqual([{ type: 'read-page', url: saved.page.url }]);
    rerender(<App bridge={bridgeFor({ ...saved, busy: true }, commands)} now={NOW} />);
    expect(screen.getByRole('button', { name: 'Reading page…' })).toBeDisabled();
  });

  it('hides an active session, conversation and sources beside a restricted attempt', () => {
    render(
      <App
        bridge={bridgeFor(state({ connection: 'restricted', activeSession: session }))}
        now={NOW}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Restricted mode' })).toBeInTheDocument();
    expect(screen.queryByText('Starting with the rubric.')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Rubric/ })).not.toBeInTheDocument();
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });
  it('renders deadline buckets, resolving ids against state.tasks, and the session list', () => {
    render(
      <App
        bridge={bridgeFor(
          state({
            tasks: [task],
            deadlines: { today: [], upcoming: [], overdue: [], needsReview: [task.id] },
            sessions: [
              {
                id: session.id,
                title: session.title,
                status: 'working',
                courseId: course.id,
                taskId: task.id,
                updatedAt: NOW.toISOString(),
                needsYou: 1,
                currentStepTitle: 'Draft an outline',
              },
            ],
          }),
        )}
        now={NOW}
      />,
    );
    expect(screen.getAllByText('Needs review').length).toBeGreaterThan(0);
    expect(screen.getByText('Source text: Thursday, maybe at noon')).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /Synthetic assignments.*lms\.example\.test/ }),
    ).toHaveAttribute('href', task.provenance.sourceUrl);
    expect(screen.getByText('CP363 · Assignment 2')).toBeInTheDocument();
    expect(screen.getByText('Needs you · 1')).toBeInTheDocument();
  });

  it('renders a moved date with visible and accessible text', () => {
    const moved = {
      ...task,
      due: {
        ...task.due,
        iso: '2026-09-24T16:00:00.000Z',
        zoneEvidence: 'explicit' as const,
        timeAssumed: false,
        confidence: 'high' as const,
      },
      dueHistory: [
        {
          iso: '2026-09-17T16:00:00.000Z',
          raw: 'Due Sep 17',
          observedAt: NOW.toISOString(),
          provenance: task.provenance,
        },
      ],
      dueChangedAt: NOW.toISOString(),
    };
    render(
      <App
        bridge={bridgeFor(
          state({
            tasks: [moved],
            deadlines: { today: [], upcoming: [moved.id], overdue: [], needsReview: [] },
          }),
        )}
        now={NOW}
      />,
    );

    expect(screen.getByText('Moved')).toBeInTheDocument();
    expect(screen.getByText('Moved from')).toBeInTheDocument();
    expect(screen.getByText('Thu, Sep 17')).toHaveAccessibleName('Previously due Thu, Sep 17');
  });

  it('remembers a deadline view selection in local storage', async () => {
    const user = userEvent.setup();
    const set = vi.fn(async () => undefined);
    vi.stubGlobal('chrome', { storage: { local: { get: vi.fn(async () => ({})), set } } });
    try {
      render(
        <App
          bridge={bridgeFor(
            state({
              tasks: [task],
              deadlines: { today: [], upcoming: [task.id], overdue: [], needsReview: [] },
            }),
          )}
          now={NOW}
        />,
      );
      await user.click(screen.getByRole('button', { name: 'Week' }));
      expect(screen.getByRole('button', { name: 'Week' })).toHaveAttribute('aria-pressed', 'true');
      expect(set).toHaveBeenCalledWith({ 'motion.deadlines.view': 'week' });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does not label a high-confidence later deadline as needing review in Week view', async () => {
    const user = userEvent.setup();
    const laterTask = {
      ...task,
      id: 'later-task',
      due: {
        ...task.due,
        iso: '2026-10-20T12:00:00.000Z',
        confidence: 'high' as const,
        zoneEvidence: 'explicit' as const,
        timeAssumed: false,
      },
    };
    render(
      <App
        bridge={bridgeFor(
          state({
            tasks: [laterTask],
            deadlines: { today: [], upcoming: [], overdue: [], needsReview: [] },
          }),
        )}
        now={NOW}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Week' }));
    expect(screen.getByText(/Later/)).toBeInTheDocument();
    expect(screen.queryByText('Motion is not confident in this date.')).not.toBeInTheDocument();
    expect(screen.queryByText('Needs review')).not.toBeInTheDocument();
  });

  it('shows distant deadlines in List and filters both views by course', async () => {
    const user = userEvent.setup();
    const otherCourse = { ...course, id: 'synthetic-course-2', code: 'TEST 202' };
    const distant = {
      ...task,
      id: 'synthetic-later',
      title: 'Synthetic final project',
      courseId: otherCourse.id,
      due: {
        ...task.due,
        iso: '2026-12-20T16:00:00.000Z',
        timeAssumed: false,
        zoneEvidence: 'explicit' as const,
        confidence: 'high' as const,
      },
    };
    render(
      <App
        bridge={bridgeFor(state({ courses: [course, otherCourse], tasks: [task, distant] }))}
        now={NOW}
      />,
    );
    expect(screen.getByText('Synthetic final project')).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Later' })).toHaveTextContent(
      'Synthetic final project',
    );
    await user.selectOptions(screen.getByLabelText('Filter by course'), otherCourse.id);
    expect(screen.queryByText(task.title)).not.toBeInTheDocument();
    expect(screen.getByText('1 deadline across 1 course')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^Week$/ }));
    expect(screen.getByText('Synthetic final project')).toBeInTheDocument();
    expect(screen.queryByText(task.title)).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Filter by course'), '');
    expect(screen.getByText(task.title)).toBeInTheDocument();
    expect(screen.getByText('Synthetic final project')).toBeInTheDocument();
  });

  it('keeps uncertain dates in Needs review when switching to Week', async () => {
    const user = userEvent.setup();
    render(<App bridge={bridgeFor(state({ tasks: [task] }))} now={NOW} />);
    await user.click(screen.getByRole('button', { name: /^Week$/ }));
    expect(screen.getByRole('list', { name: 'Needs review' })).toHaveTextContent(task.title);
    expect(
      screen.getByText('A time was assumed; the page only stated a date.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: /Next week/ })).not.toBeInTheDocument();
  });

  it.each(['idle', 'unsupported', 'permission-needed', 'signed-out'] as const)(
    'keeps saved deadlines visible while %s without starting a scan',
    (connection) => {
      const commands: MotionCommand[] = [];
      render(<App bridge={bridgeFor(state({ connection, tasks: [task] }), commands)} now={NOW} />);
      expect(screen.getByText(task.title)).toBeInTheDocument();
      expect(screen.getByText(/Saved deadlines/)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Scan all courses' })).not.toBeInTheDocument();
      expect(commands).toEqual([]);
    },
  );

  it('keeps restricted mode free of cached coursework or course actions', () => {
    render(
      <App bridge={bridgeFor(state({ connection: 'restricted', tasks: [task] }))} now={NOW} />,
    );
    expect(screen.queryByText(task.title)).not.toBeInTheDocument();
    expect(
      screen.queryAllByRole('link').filter((link) => link.getAttribute('href') !== '#main-content'),
    ).toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'Week' })).not.toBeInTheDocument();
  });

  it('sends session-create from the composer', async () => {
    const user = userEvent.setup();
    const commands: MotionCommand[] = [];
    render(<App bridge={bridgeFor(state(), commands)} now={NOW} />);

    await user.type(
      screen.getByLabelText('What do you want to work on?'),
      'Work on Assignment 2{Enter}',
    );

    expect(commands).toEqual([
      { type: 'session-create', goal: 'Work on Assignment 2', tabId: null },
    ]);
  });

  it('sends session-create from a suggestion chip', async () => {
    const user = userEvent.setup();
    const commands: MotionCommand[] = [];
    render(
      <App
        bridge={bridgeFor(
          state({
            page: { ...state().page, pageType: 'assignment' },
            deadlines: { today: [], upcoming: [], overdue: [], needsReview: [] },
          }),
          commands,
        )}
        now={NOW}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Work on Synthetic assignments' }));
    expect(commands).toEqual([
      { type: 'session-create', goal: 'Work on Synthetic assignments', tabId: null },
    ]);
  });

  it('opens a session from the list, sending session-select', async () => {
    const user = userEvent.setup();
    const commands: MotionCommand[] = [];
    render(
      <App
        bridge={bridgeFor(
          state({
            sessions: [
              {
                id: session.id,
                title: session.title,
                status: 'working',
                courseId: course.id,
                taskId: task.id,
                updatedAt: NOW.toISOString(),
                needsYou: 0,
                currentStepTitle: null,
              },
            ],
          }),
          commands,
        )}
        now={NOW}
      />,
    );
    await user.click(screen.getByRole('button', { name: /CP363 · Assignment 2/ }));
    expect(commands).toContainEqual({ type: 'session-select', sessionId: session.id });
  });
});

describe('agent presence feedback', () => {
  it('keeps a failed message in the composer and exposes the error', async () => {
    const user = userEvent.setup();
    const panelState = state({ activeSession: session });
    const bridge: MotionBridge = {
      getState: () => panelState,
      subscribe: () => () => undefined,
      send: async () => {
        throw new Error('Synthetic send failed.');
      },
    };
    render(<App bridge={bridge} now={NOW} />);
    const composer = screen.getByLabelText('Message Motion');
    await user.type(composer, 'Keep this draft');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Synthetic send failed.');
    expect(composer).toHaveValue('Keep this draft');
  });

  it('does not erase edits made while a message is pending', async () => {
    const user = userEvent.setup();
    let resolveSend!: (value: { ok: true }) => void;
    const panelState = state({ activeSession: session });
    const bridge: MotionBridge = {
      getState: () => panelState,
      subscribe: () => () => undefined,
      send: () =>
        new Promise<{ ok: true }>((resolve) => {
          resolveSend = resolve;
        }),
    };
    render(<App bridge={bridge} now={NOW} />);
    const composer = screen.getByLabelText('Message Motion');
    await user.type(composer, 'Original');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await user.type(composer, ' edited');
    resolveSend({ ok: true });
    await waitFor(() => expect(composer).toHaveValue('Original edited'));
  });

  it('makes the current focus and compact plan visible in a session', () => {
    render(<App bridge={bridgeFor(state({ activeSession: session }))} now={NOW} />);
    expect(screen.getByRole('heading', { name: 'Now' })).toBeInTheDocument();
    expect(screen.getByText('Focused on Draft an outline.')).toBeInTheDocument();
    expect(screen.getByText('1/3 complete')).toBeInTheDocument();
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
    // The session stores two tab ids, but no live tab rows: count live tabs only.
    expect(screen.getByText('Workspace · 0 tabs')).toBeInTheDocument();
    expect(screen.getByText(/No workspace tabs open yet/)).toBeInTheDocument();
    expect(screen.queryByText(/Workspace details are loading/)).not.toBeInTheDocument();
    expect(screen.getByText('Needs you')).toBeInTheDocument();
  });

  it('renders workspace metadata and focuses or releases by handle without exposing ids', async () => {
    const user = userEvent.setup();
    const commands: MotionCommand[] = [];
    render(
      <App
        bridge={bridgeFor(
          withSession({
            workspaceTabs: [
              {
                tabId: 11,
                title: 'Synthetic rubric',
                host: 'lms.example.test',
                ownership: 'motion',
                current: false,
              },
              {
                tabId: 22,
                title: 'Draft workspace',
                host: 'lms.example.test',
                ownership: 'student',
                current: true,
              },
            ],
          }),
          commands,
        )}
        now={NOW}
      />,
    );
    expect(screen.getByText('Workspace · 2 tabs')).toBeInTheDocument();
    expect(screen.getByText('Synthetic rubric')).toBeInTheDocument();
    expect(screen.getByText('Motion tab · lms.example.test')).toBeInTheDocument();
    expect(screen.getByText('Your tab · lms.example.test · current')).toBeInTheDocument();
    expect(screen.queryByText(/#11|#22/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Focus' }));
    await user.click(screen.getByRole('button', { name: 'Release' }));
    expect(commands).toContainEqual({
      type: 'session-tab',
      sessionId: session.id,
      tabId: 11,
      op: 'focus',
    });
    expect(commands).toContainEqual({
      type: 'session-tab',
      sessionId: session.id,
      tabId: 22,
      op: 'release',
    });
  });

  it('shows the provider chip, marking a cloud provider', () => {
    render(
      <App
        bridge={bridgeFor(
          withSession({
            ai: {
              providerId: 'openai',
              displayName: 'OpenAI',
              cloud: true,
              status: 'available',
              message: 'Ready.',
            },
          }),
        )}
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
    expect(commands).toContainEqual({
      type: 'decide-approval',
      approvalId: approval.id,
      approved: true,
    });
  });

  it('sends stop-generation while streaming', async () => {
    const user = userEvent.setup();
    const commands: MotionCommand[] = [];
    render(
      <App
        bridge={bridgeFor(
          withSession({
            streaming: { sessionId: session.id, text: '{"reply":"Drafting the outline…"' },
          }),
          commands,
        )}
        now={NOW}
      />,
    );
    expect(screen.getByRole('log')).toHaveTextContent('Drafting the outline…');
    await user.click(screen.getByRole('button', { name: 'Stop' }));
    expect(commands).toContainEqual({
      type: 'session-command',
      sessionId: session.id,
      command: 'stop-generation',
    });
  });

  it('shows Stop for a claimed model turn before the first streamed delta', async () => {
    const user = userEvent.setup();
    const commands: MotionCommand[] = [];
    const pendingSession = {
      ...session,
      status: 'working' as const,
      pendingModelRequest: {
        key: 'request-1',
        providerId: 'openai' as const,
        startedAt: NOW.toISOString(),
        generation: 1,
      },
    };
    render(
      <App
        bridge={bridgeFor(withSession({ activeSession: pendingSession }), commands)}
        now={NOW}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Stop' }));
    expect(commands).toContainEqual({
      type: 'session-command',
      sessionId: session.id,
      command: 'stop-generation',
    });
  });

  it('announces streaming text in the live log', () => {
    render(
      <App
        bridge={bridgeFor(
          withSession({
            streaming: { sessionId: session.id, text: '{"reply":"Drafting the outline…"' },
          }),
        )}
        now={NOW}
      />,
    );
    const log = screen.getByRole('log');
    expect(log).toHaveAttribute('aria-live', 'polite');
    // Busy while streaming so partial chunks are not re-announced; the text is
    // in the content, never hidden behind an aria-label.
    expect(log).toHaveAttribute('aria-busy', 'true');
    expect(within(log).getByText('Drafting the outline…')).toBeInTheDocument();
    expect(log.querySelector('[aria-label]')).toBeNull();
  });

  it('marks the log idle once the reply completes', () => {
    render(<App bridge={bridgeFor(withSession())} now={NOW} />);
    expect(screen.getByRole('log')).toHaveAttribute('aria-busy', 'false');
  });

  it('shows only the partial top-level reply and decodes JSON escapes', () => {
    const raw =
      '{"plan":[{"id":"synthetic-secret-step","action":"submit-assignment"}],"reply":"I can explain \\"why\\" and \\u00A9';
    render(
      <App
        bridge={bridgeFor(withSession({ streaming: { sessionId: session.id, text: raw } }))}
        now={NOW}
      />,
    );

    const log = screen.getByRole('log');
    expect(log).toHaveTextContent('I can explain "why" and ©');
    expect(
      within(log).queryByText(/synthetic-secret-step|submit-assignment|"plan"/),
    ).not.toBeInTheDocument();
  });

  it('keeps partial trailing escapes hidden and shows status before the reply field arrives', () => {
    const { rerender } = render(
      <App
        bridge={bridgeFor(withSession({ streaming: { sessionId: session.id, text: '' } }))}
        now={NOW}
      />,
    );
    expect(screen.getByRole('log')).toHaveTextContent('Motion is responding…');

    rerender(
      <App
        bridge={bridgeFor(
          withSession({
            streaming: {
              sessionId: session.id,
              text: '{"plan":[],"reply":"Text \\"quoted\\" and partial \\u00A',
            },
          }),
        )}
        now={NOW}
      />,
    );
    const log = screen.getByRole('log');
    expect(log).toHaveTextContent('Text "quoted" and partial');
    expect(within(log).queryByText(/"plan"|\\u00A/)).not.toBeInTheDocument();
  });

  it('shows the model identifier alongside the selected provider', () => {
    const activeSession = {
      ...session,
      agent: { providerId: 'openai' as const, model: 'gpt-synthetic-model' },
    };
    render(
      <App
        bridge={bridgeFor(
          withSession({
            activeSession,
            ai: {
              providerId: 'openai',
              displayName: 'OpenAI',
              cloud: true,
              status: 'available',
              message: 'Ready.',
            },
          }),
        )}
        now={NOW}
      />,
    );
    expect(screen.getByText('AI · OpenAI')).toBeInTheDocument();
    expect(screen.getByText('Model · gpt-synthetic-model')).toBeInTheDocument();
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
    expect(commands).toContainEqual({
      type: 'session-message',
      sessionId: session.id,
      text: 'Keep going',
      tabId: null,
    });
  });

  it('goes back to the session list', async () => {
    const user = userEvent.setup();
    const commands: MotionCommand[] = [];
    render(<App bridge={bridgeFor(withSession(), commands)} now={NOW} />);
    await user.click(screen.getByRole('button', { name: /Sessions/ }));
    expect(commands).toContainEqual({ type: 'session-select', sessionId: null });
  });
});

describe('session blockers', () => {
  function blocked(blocker: AgentSession['blockers'][number]) {
    return state({
      activeSession: { ...session, status: 'waiting', blockers: [blocker] },
      tasks: [task],
    });
  }

  it.each([
    ['open-ai-settings', 'Open AI settings', { type: 'open-settings' }],
    [
      'retry-model',
      'Retry',
      { type: 'session-command', sessionId: session.id, command: 'retry-model' },
    ],
    ['page-permission', 'Allow access', { type: 'request-permission' }],
  ] as const)('offers the producer-named %s action', async (action, label, command) => {
    const user = userEvent.setup();
    const commands: MotionCommand[] = [];
    render(
      <App
        bridge={bridgeFor(
          blocked({ id: 'b1', kind: 'permission', message: 'Synthetic blocker.', action }),
          commands,
        )}
        now={NOW}
      />,
    );
    await user.click(screen.getByRole('button', { name: label }));
    expect(commands).toEqual([command]);
  });

  it.each(['permission', 'provider', 'error'] as const)(
    'falls back to settings, never a page permission request, for a %s blocker without an action',
    async (kind) => {
      const user = userEvent.setup();
      const commands: MotionCommand[] = [];
      render(
        <App
          bridge={bridgeFor(blocked({ id: 'b1', kind, message: 'Synthetic blocker.' }), commands)}
          now={NOW}
        />,
      );
      expect(screen.queryByRole('button', { name: 'Allow access' })).not.toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Open settings' }));
      expect(commands).toEqual([{ type: 'open-settings' }]);
    },
  );

  it('counts a rate-limit retry down without waiting for a worker update', () => {
    vi.useFakeTimers();
    try {
      const start = new Date('2026-09-16T12:00:00.000Z');
      vi.setSystemTime(start);
      render(
        <App
          bridge={bridgeFor(
            blocked({
              id: 'b1',
              kind: 'rate-limit',
              message: 'The provider is busy.',
              retryAt: new Date(start.getTime() + 10_000).toISOString(),
            }),
          )}
        />,
      );
      expect(screen.getByRole('button', { name: 'Retrying in 10s' })).toBeDisabled();
      act(() => vi.advanceTimersByTime(3_000));
      expect(screen.getByRole('button', { name: 'Retrying in 7s' })).toBeDisabled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('approval decline', () => {
  it('records an explicit decline from the confirmation dialog', async () => {
    const user = userEvent.setup();
    const commands: MotionCommand[] = [];
    render(
      <App
        bridge={bridgeFor(
          state({ activeSession: session, tasks: [task], approvals: [approval] }),
          commands,
        )}
        now={NOW}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Review' }));
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Decline' }));
    expect(commands).toEqual([
      { type: 'decide-approval', approvalId: approval.id, approved: false },
    ]);
  });
});

describe('session composer limits', () => {
  it('caps the message at the schema limit and shows the remaining count near it', () => {
    render(<App bridge={bridgeFor(state({ activeSession: session, tasks: [task] }))} now={NOW} />);
    const input = screen.getByLabelText('Message Motion');
    expect(input).toHaveAttribute('maxLength', '4000');
    expect(screen.queryByText(/characters left/)).not.toBeInTheDocument();
    fireEvent.change(input, { target: { value: 'a'.repeat(3_700) } });
    expect(screen.getByText('300 characters left')).toBeInTheDocument();
  });

  it('shows a validation failure as feedback and keeps the draft', async () => {
    const commands: MotionCommand[] = [];
    render(
      <App bridge={bridgeFor(state({ activeSession: session, tasks: [task] }), commands)} now={NOW} />,
    );
    const input = screen.getByLabelText('Message Motion');
    // A programmatic value can exceed maxLength; the schema must still be heard.
    fireEvent.change(input, { target: { value: 'a'.repeat(4_100) } });
    fireEvent.submit(input.closest('form')!);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Messages can be up to 4,000 characters',
    );
    expect(commands).toHaveLength(0);
    expect(input).toHaveValue('a'.repeat(4_100));
  });
});

describe('command feedback', () => {
  function failingBridge(panelState: PanelState): MotionBridge {
    return {
      ...bridgeFor(panelState),
      send: async () => ({ ok: false, code: 'command-refused', message: 'Synthetic refusal.' }),
    };
  }

  it('can be dismissed', async () => {
    const user = userEvent.setup();
    render(<App bridge={failingBridge(state())} now={NOW} />);
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Synthetic refusal.');
    await user.click(screen.getByRole('button', { name: 'Dismiss message' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('clears when the student changes view', async () => {
    const user = userEvent.setup();
    render(<App bridge={failingBridge(state())} now={NOW} />);
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Synthetic refusal.');
    await user.click(screen.getByRole('button', { name: /Coursework/ }));
    expect(screen.queryByText('Synthetic refusal.')).not.toBeInTheDocument();
  });
});

describe('first-run and recovery guidance', () => {
  it.each(['idle', 'unsupported'] as const)(
    'names the supported Brightspace sites on %s and offers settings instead of a failing note',
    async (connection) => {
      const user = userEvent.setup();
      const commands: MotionCommand[] = [];
      render(<App bridge={bridgeFor(state({ connection }), commands)} now={NOW} />);
      expect(screen.getByText(/\*\.brightspace\.com, \*\.desire2learn\.com/)).toBeInTheDocument();
      expect(screen.getByText(/mylearningspace\.wlu\.ca/)).toBeInTheDocument();
      expect(
        screen.getByText('Open your Brightspace course, then reopen Motion.'),
      ).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Add a note' })).not.toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Open settings' }));
      expect(commands).toEqual([{ type: 'open-settings' }]);
    },
  );

  it('asks for a reload when a supported tab has no content script', async () => {
    const user = userEvent.setup();
    const commands: MotionCommand[] = [];
    render(
      <App bridge={bridgeFor(state({ connection: 'idle', tabNeedsReload: true }), commands)} now={NOW} />,
    );
    expect(
      screen.getByRole('heading', { name: 'Reload this tab so Motion can read it' }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reload tab' }));
    expect(commands).toEqual([{ type: 'reload-tab' }]);
  });

  it('shows a worker failure with Retry instead of a silent idle state', async () => {
    const user = userEvent.setup();
    const commands: MotionCommand[] = [];
    render(
      <App
        bridge={bridgeFor(
          state({ connection: 'idle', workerError: 'The background worker did not respond.' }),
          commands,
        )}
        now={NOW}
      />,
    );
    expect(screen.getByText('The background worker did not respond.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(commands).toEqual([{ type: 'refresh' }]);
  });
});
