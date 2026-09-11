import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it } from 'vitest';
import { EMPTY_PANEL_STATE } from '../../core/view/state';
import type { MotionBridge, MotionCommand } from '../bridge';
import { WorkspaceView } from './WorkspaceView';

function fakeBridge(answer: unknown) {
  const requested: MotionCommand[] = [];
  const bridge: MotionBridge = {
    getState: () => EMPTY_PANEL_STATE,
    subscribe: () => () => undefined,
    send: () => undefined,
    request: async <T,>(command: MotionCommand) => {
      requested.push(command);
      return answer as T;
    },
  };
  return { bridge, requested };
}

it('asks the worker to prepare a workspace without naming a tab itself', async () => {
  const user = userEvent.setup();
  const { bridge, requested } = fakeBridge({ workflowId: 'wf-1' });
  render(<WorkspaceView bridge={bridge} />);

  await user.click(screen.getByRole('button', { name: 'Prepare workspace' }));

  expect(requested).toEqual([{ type: 'prepare-workspace' }]);
});

it('says why Motion declined rather than doing nothing', async () => {
  const user = userEvent.setup();
  const { bridge } = fakeBridge({
    workflowId: null,
    reason: 'Motion cannot prepare a workspace on a graded attempt.',
  });
  render(<WorkspaceView bridge={bridge} />);

  await user.click(screen.getByRole('button', { name: 'Prepare workspace' }));

  expect(await screen.findByText(/graded attempt/i)).toBeInTheDocument();
});

it('says so when the workspace is already open', async () => {
  const user = userEvent.setup();
  const { bridge } = fakeBridge({ workflowId: 'wf-1', reused: true });
  render(<WorkspaceView bridge={bridge} />);

  await user.click(screen.getByRole('button', { name: 'Prepare workspace' }));

  expect(await screen.findByText(/already open/i)).toBeInTheDocument();
});
