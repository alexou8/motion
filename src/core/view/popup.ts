import { z } from 'zod';
import { connectionStateSchema } from './state';

/** The small, trusted context needed to launch Motion from the toolbar. */
export const popupActionSchema = z.enum([
  'open-motion',
  'start-workspace',
  'continue-session',
  'read-current-page',
  'scan-deadlines',
]);
export type PopupAction = z.infer<typeof popupActionSchema>;

export const popupLauncherStateSchema = z.object({
  tabId: z.number().int().nonnegative(),
  windowId: z.number().int().nonnegative(),
  connection: connectionStateSchema,
  title: z.string().max(500),
  courseLabel: z.string().max(200).nullable(),
  relevantSessionId: z.string().nullable(),
  relevantSessionTitle: z.string().max(500).nullable(),
});
export type PopupLauncherState = z.infer<typeof popupLauncherStateSchema>;

/**
 * Keep the popup compact and derive its controls from durable worker facts.
 * The popup itself never decides that a page is safe to read or group.
 */
export function popupActionsFor(state: PopupLauncherState): PopupAction[] {
  switch (state.connection) {
    case 'restricted':
    case 'unsupported':
    case 'signed-out':
    case 'permission-needed':
    case 'idle':
      return ['open-motion'];
    case 'supported':
      return state.relevantSessionId
        ? ['continue-session', 'open-motion', 'read-current-page']
        : ['start-workspace', 'open-motion', 'read-current-page'];
  }
}
