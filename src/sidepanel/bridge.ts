import { z } from 'zod';
import type { PanelState } from '../core/view/state';

export const motionCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('request-permission') }),
  z.object({ type: z.literal('read-page'), url: z.string().url().nullable() }),
  z.object({ type: z.literal('create-note'), pageUrl: z.string().url().nullable() }),
  z.object({
    type: z.literal('decide-approval'),
    approvalId: z.string().min(1),
    approved: z.boolean(),
  }),
  z.object({
    type: z.literal('workflow-command'),
    workflowId: z.string().min(1),
    command: z.enum(['pause', 'resume', 'retry', 'cancel']),
  }),
]);

export type MotionCommand = z.infer<typeof motionCommandSchema>;

/** The only dependency the panel needs from the extension runtime. */
export interface MotionBridge {
  getState: () => PanelState;
  subscribe: (listener: () => void) => () => void;
  send: (command: MotionCommand) => void | Promise<void>;
}

export function sendCommand(bridge: MotionBridge, command: MotionCommand): void {
  bridge.send(motionCommandSchema.parse(command));
}
