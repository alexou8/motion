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
  z.object({ type: z.literal('build-checklist') }),
  z.object({
    type: z.literal('toggle-requirement'),
    checklistId: z.string().min(1),
    requirementId: z.string().min(1),
    done: z.boolean(),
  }),
  z.object({
    type: z.literal('compose-draft'),
    kind: z.enum(['outline', 'full-draft', 'section', 'discussion-reply', 'revision']),
    checklistId: z.string().min(1),
    title: z.string().min(1),
    existingDraft: z.string().optional(),
    studentDirection: z.string().optional(),
    targetWords: z.number().int().min(50).max(5_000).optional(),
  }),
  z.object({ type: z.literal('review-draft'), checklistId: z.string().min(1), draft: z.string() }),
  z.object({ type: z.literal('model-status') }),
  z.object({ type: z.literal('get-checklist'), checklistId: z.string().min(1) }),
]);

export type MotionCommand = z.infer<typeof motionCommandSchema>;

/** The only dependency the panel needs from the extension runtime. */
export interface MotionBridge {
  getState: () => PanelState;
  subscribe: (listener: () => void) => () => void;
  send: (command: MotionCommand) => void | Promise<void>;
  /**
   * Like `send`, but for commands whose answer the panel renders — building a
   * checklist, drafting, reviewing a draft. Separate from `send` so a view that
   * only fires an action cannot accidentally depend on a reply that a closed
   * worker may never deliver.
   */
  request?: <T>(command: MotionCommand) => Promise<T | null>;
}

export function sendCommand(bridge: MotionBridge, command: MotionCommand): void {
  bridge.send(motionCommandSchema.parse(command));
}
