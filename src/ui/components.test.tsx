import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { ApprovalRequest } from '../core/policy';
import type { CourseTask, Course } from '../core/domain';
import type { PanelState } from '../core/view/state';
import type { Workflow } from '../core/workflows';
import { App } from '../sidepanel/App';
import type { MotionBridge, MotionCommand } from '../sidepanel/bridge';
import { SourceLink, StatusMarker } from './components';

const NOW = new Date('2026-09-07T12:00:00.000Z');

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
    iso: '2026-09-10T16:00:00.000Z',
    raw: 'Thursday, maybe at noon',
    zoneEvidence: 'assumed-local',
    timeAssumed: true,
    confidence: 'low',
  },
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

const workflow: Workflow = {
  id: 'workflow-1',
  definitionId: 'read-course',
  definitionVersion: 1,
  title: 'Prepare a reading list',
  courseId: course.id,
  params: {},
  steps: [
    {
      id: 'step-1',
      title: 'Read the page',
      action: 'read-page',
      risk: 'low',
      input: {},
      status: 'running',
      attempt: 1,
      result: null,
      error: null,
      sourcesVisited: [],
      approvalId: null,
      intent: null,
      startedAt: NOW.toISOString(),
      finishedAt: null,
    },
  ],
  status: 'running',
  currentStepId: 'step-1',
  lease: null,
  retryAt: null,
  tabGroupId: null,
  warnings: [],
  createdAt: NOW.toISOString(),
  updatedAt: NOW.toISOString(),
};

const approval: ApprovalRequest = {
  id: 'approval-1',
  workflowId: workflow.id,
  stepId: 'step-1',
  action: 'post-discussion',
  risk: 'high',
  summary: 'Prepare a discussion post',
  target: 'Synthetic discussion board',
  effect: 'Creates a prepared post for you to review.',
  reversible: true,
  payload: { body: 'Synthetic payload' },
  status: 'pending',
  requestedAt: NOW.toISOString(),
  decidedAt: null,
  expiresAt: '2026-09-07T12:02:00.000Z',
};

function state(overrides: Partial<PanelState> = {}): PanelState {
  return {
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
    tasks: [],
    workflows: [],
    approvals: [],
    corruptedRecords: 0,
    busy: false,
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

describe('connection views', () => {
  it.each([
    ['idle', 'Motion organizes coursework'],
    ['unsupported', 'Synthetic assignments'],
    ['permission-needed', 'Let Motion read Synthetic assignments'],
    ['restricted', 'Restricted mode'],
  ] as const)('renders the %s view', (connection, heading) => {
    const panelState = state({ connection });
    render(<App bridge={bridgeFor(panelState)} now={NOW} />);
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

  // Assert on CONTROLS, not on prose: the copy legitimately uses these words to
  // say what Motion will not do, and a bare text match would forbid explaining
  // the restriction at all.
  for (const label of [/extract/i, /workflow/i, /draft/i, /note/i, /read/i]) {
    expect(screen.queryByRole('button', { name: label })).not.toBeInTheDocument();
  }

  // No control that touches this page may exist -- not reading it, and not
  // capturing a note from it. Capturing text during a graded attempt is the
  // behaviour the policy exists to prevent, so the button must not be there to
  // click; a button that silently does nothing would teach the student that
  // Motion helps here.
  expect(screen.queryAllByRole('button')).toHaveLength(0);
  expect(screen.getByText(/will not read this page/i)).toBeInTheDocument();
});

it('flags a low-confidence deadline and keeps its raw source text', () => {
  render(<App bridge={bridgeFor( state({ tasks: [task] }))} now={NOW} />);
  expect(screen.getByText('Needs review')).toBeInTheDocument();
  expect(screen.getByText('Source text: Thursday, maybe at noon')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: /Synthetic assignments.*lms\.example\.test/ })).toHaveAttribute('href', task.provenance.sourceUrl);
});

it('opens a high-risk approval dialog, cancels on Escape, and confirms once', async () => {
  const user = userEvent.setup();
  const commands: MotionCommand[] = [];
  render(<App bridge={bridgeFor(state({ approvals: [approval] }), commands)} now={NOW} />);

  await user.click(screen.getByRole('button', { name: 'Approve' }));
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(commands).toHaveLength(0);

  await user.click(screen.getByRole('button', { name: 'Approve' }));
  await user.click(screen.getByRole('dialog').querySelector('button:last-child') as HTMLButtonElement);
  expect(commands).toEqual([{ type: 'decide-approval', approvalId: approval.id, approved: true }]);
});

it('activates the permission action from the keyboard', async () => {
  const user = userEvent.setup();
  const commands: MotionCommand[] = [];
  render(<App bridge={bridgeFor(state({ connection: 'permission-needed' }), commands)} now={NOW} />);
  await user.tab();
  await user.keyboard('{Enter}');
  expect(commands).toEqual([{ type: 'request-permission' }]);
});

it.each(['done', 'active', 'pending', 'skipped', 'blocked', 'failed'] as const)('gives %s markers a text alternative', (markerState) => {
  render(<StatusMarker state={markerState} />);
  expect(screen.getByRole('img')).toHaveAccessibleName();
});

it('does not render a non-https source link', () => {
  render(<SourceLink href="http://lms.example.test/course" pageTitle="Insecure source" />);
  expect(screen.queryByRole('link')).not.toBeInTheDocument();
});
