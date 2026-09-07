import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it } from 'vitest';
import type { DraftReview } from '../core/assist';
import type { Checklist } from '../core/domain';
import type { MotionCommand } from '../sidepanel/bridge';
import { ChecklistView, DraftWorkspace, ReviewBeforeSubmit } from '../sidepanel/views';

const SOURCE = {
  sourceUrl: 'https://lms.example.test/course/1/assignment',
  pageTitle: 'Synthetic assignment instructions',
  platformId: 'test-platform',
  pageType: 'assignment',
  capturedAt: '2026-09-07T12:00:00.000Z',
  extractionVersion: 1,
};

const checklist: Checklist = {
  id: 'checklist-1',
  courseId: 'course-1',
  taskId: null,
  title: 'Assignment requirements',
  items: [
    { id: 'requirement-1', text: 'Discuss functional dependencies.', done: false, provenance: { ...SOURCE, strategy: 'requirement:obligation' }, manual: false },
    { id: 'requirement-2', text: 'Use at least 3 peer-reviewed sources.', done: true, provenance: { ...SOURCE, strategy: 'requirement:constraint' }, manual: false },
  ],
  createdAt: SOURCE.capturedAt,
  updatedAt: SOURCE.capturedAt,
};

const review: DraftReview = {
  stats: { words: 42, sentences: 4, paragraphs: 2 },
  findings: [
    {
      requirementId: 'requirement-1',
      requirement: 'Discuss functional dependencies.',
      coverage: 'addressed',
      evidence: 'This draft discusses functional dependencies.',
      explanation: 'Your draft covers most of the terms this asks for.',
    },
    {
      requirementId: 'requirement-2',
      requirement: 'Use at least 3 peer-reviewed sources.',
      coverage: 'partial',
      evidence: 'The draft uses sources.',
      explanation: 'Some of this appears in your draft, but not all of it. Worth a second look.',
    },
    {
      requirementId: 'requirement-3',
      requirement: 'Explain the limitations of the method.',
      coverage: 'no-evidence',
      evidence: null,
      explanation: 'Motion found nothing in your draft matching this.',
    },
  ],
  constraintChecks: [{ label: 'At least 100 words', satisfied: false, detail: 'Your draft has 42 words, 58 short.' }],
};

function sendSpy() {
  const commands: MotionCommand[] = [];
  return { commands, send: (command: MotionCommand): void => { commands.push(command); } };
}

it('renders a source link for every checklist item and emits its toggle command', async () => {
  const user = userEvent.setup();
  const { commands, send } = sendSpy();
  render(<ChecklistView checklist={checklist} send={send} />);

  expect(screen.getAllByRole('link')).toHaveLength(checklist.items.length);
  expect(screen.getByLabelText('Discuss functional dependencies.')).toBeInTheDocument();
  await user.click(screen.getByLabelText('Discuss functional dependencies.'));
  expect(commands).toContainEqual({
    type: 'toggle-requirement',
    checklistId: checklist.id,
    requirementId: 'requirement-1',
    done: true,
  });
});

it('shows the generated label with every rendered draft and lists each unsupported sentence', () => {
  render(
    <DraftWorkspace
      checklistId={checklist.id}
      result={{
        draft: 'A claim about 40% improvement [needs a source]. Another unsupported claim [needs a source].',
        unsupported: ['A claim about 40% improvement [needs a source].', 'Another unsupported claim [needs a source].'],
      }}
      send={sendSpy().send}
      title="Assignment 2"
    />,
  );

  const result = screen.getByRole('region', { name: 'Write a first draft' });
  expect(result).toContainElement(screen.getByText(/Drafted by Motion from your requirements and notes/));
  expect(result).toContainElement(screen.getAllByText(/A claim about 40% improvement/)[0]!);
  expect(result).toContainElement(screen.getAllByText(/Another unsupported claim/)[0]!);
  expect(screen.getByRole('heading', { name: 'Check these before you use them' })).toBeInTheDocument();
});

it('has no submit, post, or send button in draft or review views', () => {
  const { unmount } = render(
    <DraftWorkspace checklistId={checklist.id} result={{ draft: 'Draft text' }} send={sendSpy().send} title="Assignment 2" />,
  );
  expect(screen.queryAllByRole('button', { name: /submit|post|send/i })).toHaveLength(0);
  unmount();

  render(<ReviewBeforeSubmit review={review} />);
  expect(screen.queryAllByRole('button', { name: /submit|post|send/i })).toHaveLength(0);
});

it('shows the model explanation and disables all drafting buttons when unavailable', () => {
  render(
    <DraftWorkspace
      checklistId={checklist.id}
      modelStatus={{ availability: 'unavailable', explanation: 'This browser does not have an on-device model available.' }}
      send={sendSpy().send}
      title="Assignment 2"
    />,
  );

  expect(screen.getByText('This browser does not have an on-device model available.')).toBeInTheDocument();
  for (const button of screen.getAllByRole('button')) expect(button).toBeDisabled();
});

it('keeps the student draft when generation fails', async () => {
  const user = userEvent.setup();
  render(
    <DraftWorkspace
      checklistId={checklist.id}
      existingDraft="The student's writing stays here."
      onCompose={async () => {
        throw new Error('Model ran out of context.');
      }}
      send={sendSpy().send}
      title="Assignment 2"
    />,
  );

  await user.click(screen.getByRole('button', { name: 'Write a first draft' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Model ran out of context.');
  expect(screen.getByRole('textbox', { name: 'Your draft' })).toHaveValue("The student's writing stays here.");
});

it('does not block paste in the draft textarea', async () => {
  const user = userEvent.setup();
  render(<DraftWorkspace checklistId={checklist.id} send={sendSpy().send} title="Assignment 2" />);
  const textarea = screen.getByRole('textbox', { name: 'Your draft' });
  await user.click(textarea);
  await user.paste('Pasted student writing.');
  expect(textarea).toHaveValue('Pasted student writing.');
});

it('gives every coverage state a text alternative and wording-only copy for no evidence', () => {
  render(<ReviewBeforeSubmit review={review} />);
  expect(screen.getByRole('img', { name: 'Addressed' })).toBeInTheDocument();
  expect(screen.getByRole('img', { name: 'Partial' })).toBeInTheDocument();
  expect(screen.getByRole('img', { name: 'No evidence' })).toBeInTheDocument();
  expect(screen.getByText('Motion compared wording only. Check this requirement yourself.')).toBeInTheDocument();
  expect(screen.getByText('Your draft has 42 words, 58 short.')).toBeInTheDocument();
});

it('offers a clear next action when the checklist is empty without inventing items', () => {
  const { commands, send } = sendSpy();
  render(<ChecklistView checklist={null} send={send} />);
  expect(screen.getByText(/found nothing stated as a requirement/i)).toBeInTheDocument();
  expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  screen.getByRole('button', { name: 'Build from a different page' }).click();
  expect(commands).toEqual([{ type: 'build-checklist' }]);
});
