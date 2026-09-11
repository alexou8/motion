import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { EMPTY_PANEL_STATE, type PanelState } from '../core/view/state';
import type { MotionBridge, MotionCommand } from './bridge';
import { App } from './App';
import { parseWorkerResult } from './responses';

/**
 * The panel shell: header, tasks, the chat about the page, and the composer.
 * Page content is synthetic.
 */

const SUPPORTED: PanelState = {
  ...EMPTY_PANEL_STATE,
  connection: 'supported',
  page: { ...EMPTY_PANEL_STATE.page, url: 'https://mylearningspace.wlu.ca/d2l/x', title: 'Synthetic Assignment 2', pageType: 'assignment' },
};

const RESTRICTED: PanelState = {
  ...EMPTY_PANEL_STATE,
  connection: 'restricted',
  page: { ...EMPTY_PANEL_STATE.page, restrictionReason: 'This page looks like a graded attempt.' },
};

interface Answers {
  askAboutPage?: (command: Extract<MotionCommand, { type: 'ask-about-page' }>) => unknown;
  model?: { availability: string; explanation: string };
}

function fakeBridge(state: PanelState, answers: Answers = {}) {
  const requested: MotionCommand[] = [];
  const sent: MotionCommand[] = [];
  const bridge: MotionBridge = {
    getState: () => state,
    subscribe: () => () => undefined,
    send: (command) => {
      sent.push(command);
    },
    request: async <T,>(command: MotionCommand) => {
      requested.push(command);
      if (command.type === 'model-status') {
        return parseWorkerResult(command.type, answers.model ?? { availability: 'available', explanation: '' }) as T | null;
      }
      if (command.type === 'ask-about-page') return (answers.askAboutPage?.(command) ?? null) as T;
      return null;
    },
  };
  return { bridge, requested, sent };
}

const questionsAsked = (requested: MotionCommand[]) =>
  requested.filter((command): command is Extract<MotionCommand, { type: 'ask-about-page' }> => command.type === 'ask-about-page');

describe('the composer', () => {
  it('does not exist beside a graded attempt, says why, and offers no tasks', async () => {
    const { bridge, requested } = fakeBridge(RESTRICTED);
    render(<App bridge={bridge} />);

    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send question' })).not.toBeInTheDocument();
    expect(screen.getByText(/Chat is off beside a graded attempt/i)).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Tasks' })).not.toBeInTheDocument();
    // Not even the model is asked about beside an attempt.
    await Promise.resolve();
    expect(requested).toHaveLength(0);
  });

  it('hides an earlier conversation once the tab turns out to be a graded attempt', async () => {
    const user = userEvent.setup();
    let current: PanelState = SUPPORTED;
    const listeners = new Set<() => void>();
    const { bridge } = fakeBridge(SUPPORTED, { askAboutPage: () => ({ answer: 'Chapter 4 covers it.', label: 'Label.' }) });
    bridge.getState = () => current;
    bridge.subscribe = (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    };
    render(<App bridge={bridge} />);
    await user.type(screen.getByLabelText('Ask about this page', { selector: 'textarea' }), 'Where is this covered?{Enter}');
    await screen.findByText('Chapter 4 covers it.');

    current = RESTRICTED;
    act(() => listeners.forEach((listener) => listener()));

    expect(screen.queryByText('Chapter 4 covers it.')).not.toBeInTheDocument();
  });

  it('is off on a page Motion cannot read', () => {
    const { bridge } = fakeBridge({ ...EMPTY_PANEL_STATE, connection: 'unsupported' });
    render(<App bridge={bridge} />);
    expect(screen.getByLabelText('Ask about this page', { selector: 'textarea' })).toBeDisabled();
  });

  it('explains a missing on-device model before the student types', async () => {
    const { bridge } = fakeBridge(SUPPORTED, {
      model: { availability: 'unavailable', explanation: 'This browser does not have an on-device model available.' },
    });
    render(<App bridge={bridge} />);
    const input = screen.getByLabelText('Ask about this page', { selector: 'textarea' });

    // Asserted on the composer itself: the drafting view says the same thing.
    await waitFor(() => expect(input).toHaveAccessibleDescription(/does not have an on-device model/i));
    expect(input).toBeDisabled();
  });

  it('keeps the composer usable when model status is malformed', async () => {
    const { bridge } = fakeBridge(SUPPORTED, {
      model: { availability: 'broken', explanation: 123 as unknown as string },
    });
    render(<App bridge={bridge} />);
    const input = screen.getByLabelText('Ask about this page', { selector: 'textarea' });

    await waitFor(() => expect(input).toBeEnabled());
    expect(screen.queryByText('123')).not.toBeInTheDocument();
  });
});

describe('asking about the page', () => {
  it('sends the question, then shows the answer with its label and the page it was about', async () => {
    const user = userEvent.setup();
    const { bridge, requested } = fakeBridge(SUPPORTED, {
      askAboutPage: () => ({ answer: 'It is due on Friday.', label: 'Answered by Motion from this page.' }),
    });
    render(<App bridge={bridge} />);

    await user.type(screen.getByLabelText('Ask about this page', { selector: 'textarea' }), 'When is it due?{Enter}');

    const log = await screen.findByRole('log');
    expect(await within(log).findByText('It is due on Friday.')).toBeInTheDocument();
    expect(within(log).getByText(/About “Synthetic Assignment 2”\. Answered by Motion/)).toBeInTheDocument();
    expect(questionsAsked(requested)).toEqual([{ type: 'ask-about-page', question: 'When is it due?', history: [] }]);
  });

  it('sends earlier turns as history, but not Motion declining', async () => {
    const user = userEvent.setup();
    const replies = [
      { answer: null, reason: 'The page changed while Motion was reading it.' },
      { answer: 'Three sections.', label: 'Label.' },
      { answer: 'Yes.', label: 'Label.' },
    ];
    const { bridge, requested } = fakeBridge(SUPPORTED, { askAboutPage: () => replies.shift() });
    render(<App bridge={bridge} />);
    const input = screen.getByLabelText('Ask about this page', { selector: 'textarea' });

    await user.type(input, 'First?{Enter}');
    expect(await screen.findByText(/page changed/i)).toBeInTheDocument();
    await user.type(input, 'How many sections?{Enter}');
    await screen.findByText('Three sections.');
    await user.type(input, 'Is there a rubric?{Enter}');
    await screen.findByText('Yes.');

    expect(questionsAsked(requested)[2]?.history).toEqual([
      { role: 'student', text: 'First?' },
      { role: 'student', text: 'How many sections?' },
      { role: 'motion', text: 'Three sections.' },
    ]);
  });

  it('does not render an answer the worker sent in a shape the panel does not recognise', async () => {
    const user = userEvent.setup();
    const { bridge } = fakeBridge(SUPPORTED, { askAboutPage: () => ({ answer: { html: '<b>injected</b>' } }) });
    render(<App bridge={bridge} />);

    await user.type(screen.getByLabelText('Ask about this page', { selector: 'textarea' }), 'Q?{Enter}');

    expect(await screen.findByText('Motion could not answer that. Try again.')).toBeInTheDocument();
    expect(screen.queryByText(/injected/)).not.toBeInTheDocument();
  });

  it('keeps a newline on Shift+Enter instead of sending', async () => {
    const user = userEvent.setup();
    const { bridge, requested } = fakeBridge(SUPPORTED);
    render(<App bridge={bridge} />);
    const input = screen.getByLabelText('Ask about this page', { selector: 'textarea' });

    await user.type(input, 'line one{Shift>}{Enter}{/Shift}line two');

    expect(input).toHaveValue('line one\nline two');
    expect(questionsAsked(requested)).toHaveLength(0);
  });
});

describe('the header', () => {
  it('starts a new chat, forgetting the conversation', async () => {
    const user = userEvent.setup();
    const { bridge } = fakeBridge(SUPPORTED, { askAboutPage: () => ({ answer: 'An answer.', label: 'Label.' }) });
    render(<App bridge={bridge} />);
    const newChat = screen.getByRole('button', { name: 'New chat' });
    expect(newChat).toBeDisabled();

    await user.type(screen.getByLabelText('Ask about this page', { selector: 'textarea' }), 'Q?{Enter}');
    await screen.findByText('An answer.');
    await user.click(newChat);

    expect(screen.queryByText('An answer.')).not.toBeInTheDocument();
    expect(screen.queryByRole('log')).not.toBeInTheDocument();
  });

  it('opens the settings page', async () => {
    const user = userEvent.setup();
    const { bridge, sent } = fakeBridge(SUPPORTED);
    render(<App bridge={bridge} />);

    await user.click(screen.getByRole('button', { name: 'Settings' }));

    expect(sent).toContainEqual({ type: 'open-settings' });
  });
});

describe('tasks', () => {
  it('opens each task’s view from its button', async () => {
    const user = userEvent.setup();
    const { bridge } = fakeBridge(SUPPORTED);
    render(<App bridge={bridge} />);
    const tasks = screen.getByRole('group', { name: 'Tasks' });

    await user.click(within(tasks).getByRole('button', { name: 'Workspace' }));
    expect(within(tasks).getByRole('button', { name: 'Workspace' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Prepare workspace' })).toBeInTheDocument();

    await user.click(within(tasks).getByRole('button', { name: 'Checklist' }));
    expect(screen.queryByRole('button', { name: 'Prepare workspace' })).not.toBeInTheDocument();
  });
});
