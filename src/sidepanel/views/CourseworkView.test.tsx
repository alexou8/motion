import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it } from 'vitest';
import { courseTaskSchema } from '../../core/domain';
import { EMPTY_PANEL_STATE, type PanelState } from '../../core/view/state';
import { App } from '../App';
import type { MotionBridge, MotionCommand } from '../bridge';

const NOW = new Date('2026-10-01T12:00:00Z');
const material = courseTaskSchema.parse({
  id: 'lecture',
  courseId: 'test-course',
  title: 'Synthetic lecture slides',
  kind: 'content',
  due: { iso: null, raw: '', confidence: 'low', zoneEvidence: 'none' },
  provenance: {
    sourceUrl: 'https://lms.example.test/content',
    pageTitle: 'Synthetic module',
    platformId: 'synthetic',
    pageType: 'content-module',
    capturedAt: NOW.toISOString(),
    extractionVersion: 1,
  },
  createdAt: NOW.toISOString(),
  updatedAt: NOW.toISOString(),
});
const assignment = {
  ...material,
  id: 'assignment',
  title: 'Synthetic essay',
  kind: 'assignment' as const,
  status: 'submitted' as const,
};
const panelState: PanelState = {
  ...EMPTY_PANEL_STATE,
  connection: 'unsupported',
  tasks: [material, assignment],
  courses: [
    {
      id: 'test-course',
      platformId: 'synthetic',
      name: 'Synthetic writing',
      code: 'TEST 101',
      archived: false,
      lastVerifiedAt: NOW.toISOString(),
    },
  ],
};
function bridge(state: PanelState, commands: MotionCommand[] = []): MotionBridge {
  return {
    getState: () => state,
    subscribe: () => () => undefined,
    send: async (command) => {
      commands.push(command);
      return { ok: true };
    },
  };
}

it('browses saved coursework away from the LMS using keyboard-accessible filters', async () => {
  const user = userEvent.setup();
  const commands: MotionCommand[] = [];
  render(<App bridge={bridge(panelState, commands)} now={NOW} />);
  const nav = screen.getByRole('navigation', { name: 'Workspace' });
  const browse = within(nav).getByRole('button', { name: /Coursework/ });
  browse.focus();
  await user.keyboard('{Enter}');
  expect(browse).toHaveAttribute('aria-current', 'page');
  expect(screen.getByRole('main')).toHaveFocus();
  expect(screen.getByRole('heading', { name: 'Your coursework' })).toBeInTheDocument();
  expect(screen.getByText('No deadline')).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: assignment.title })).not.toBeInTheDocument();
  expect(screen.getByRole('link', { name: /Synthetic module/ })).toHaveAttribute(
    'href',
    material.provenance.sourceUrl,
  );
  await user.selectOptions(screen.getByLabelText('Status'), 'completed');
  expect(screen.getByRole('heading', { name: assignment.title })).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Reset filters' }));
  await user.type(screen.getByLabelText('Search coursework'), 'missing');
  expect(screen.getByRole('status')).toHaveTextContent('0 items');
  expect(screen.getByText(/No coursework matches/)).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Reset filters' }));
  await user.click(screen.getByRole('button', { name: 'Materials' }));
  expect(screen.getByRole('status')).toHaveTextContent('1 item');
  expect(commands).toEqual([]);
});

it('keeps coursework and its source links out of a restricted attempt', () => {
  render(<App bridge={bridge({ ...panelState, connection: 'restricted' })} now={NOW} />);
  expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  expect(screen.queryByText(material.title)).not.toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Restricted mode' })).toBeInTheDocument();
});
