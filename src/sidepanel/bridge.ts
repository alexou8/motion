import { z } from 'zod';
import type { PanelState } from '../core/view/state';
import {
  sessionCreateSchema,
  sessionMessageSchema,
  sessionCommandSchema,
  sessionSelectSchema,
  sessionSourceSchema,
  sessionTabSchema,
  aiStatusSchema,
  setProviderKeySchema,
  forgetProviderKeySchema,
  testProviderSchema,
  setAiPreferencesSchema,
  acceptCloudDisclosureSchema,
  deleteLocalDataSchema,
} from '../core/messaging/sessionContracts';
import { scanAllCoursesSchema, setDeadlineDiscoveryOptInSchema } from '../core/messaging/contracts';

export const motionCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('open-settings') }),
  z.object({ type: z.literal('request-permission') }),
  z.object({ type: z.literal('read-page'), url: z.string().url().nullable() }),
  z.object({ type: z.literal('create-note'), pageUrl: z.string().url().nullable() }),
  z.object({
    type: z.literal('decide-approval'),
    approvalId: z.string().min(1),
    approved: z.boolean(),
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
  z.object({ type: z.literal('get-checklist'), checklistId: z.string().min(1) }),
  scanAllCoursesSchema,
  setDeadlineDiscoveryOptInSchema,
  // Session vocabulary — these already match the worker message shape 1:1
  // (`src/core/messaging/sessionContracts.ts`), so the runtime bridge mostly
  // passes them through rather than translating.
  sessionCreateSchema,
  sessionMessageSchema,
  sessionCommandSchema,
  sessionSelectSchema,
  sessionSourceSchema,
  sessionTabSchema,
  aiStatusSchema,
  setProviderKeySchema,
  forgetProviderKeySchema,
  testProviderSchema,
  setAiPreferencesSchema,
  acceptCloudDisclosureSchema,
  deleteLocalDataSchema,
  // Convenience command: resolves to a `session-tab` adopt of whichever tab
  // is active right now. Kept separate from `session-tab` because only the
  // runtime bridge — never a view — may decide which tab id that is.
  z.object({ type: z.literal('session-adopt-current-tab'), sessionId: z.string().min(1) }),
]);

export type MotionCommand = z.infer<typeof motionCommandSchema>;

/**
 * Every interactive command has an observable outcome. `transport-*` codes
 * mean the runtime boundary failed; all other codes are worker/domain
 * refusals that can be shown beside the control that initiated them.
 */
export type UiCommandResult<T = undefined> =
  | { ok: true; data?: T }
  | { ok: false; code: string; message: string; recoverable?: boolean };

/** The only dependency the panel needs from the extension runtime. */
export interface MotionBridge {
  getState: () => PanelState;
  subscribe: (listener: () => void) => () => void;
  send: (command: MotionCommand) => Promise<UiCommandResult>;
  /**
   * Like `send`, but for commands whose answer the panel renders — building a
   * checklist, drafting, reviewing a draft, provider diagnostics. Separate
   * from `send` so a view that only fires an action cannot accidentally
   * depend on a reply that a closed worker may never deliver.
   */
  request?: <T>(command: MotionCommand) => Promise<UiCommandResult<T>>;
}

export function sendCommand(bridge: MotionBridge, command: MotionCommand): Promise<UiCommandResult> {
  return bridge.send(motionCommandSchema.parse(command));
}
