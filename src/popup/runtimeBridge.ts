import { z } from 'zod';
import {
  popupActionSchema,
  popupLauncherStateSchema,
  type PopupAction,
  type PopupLauncherState,
} from '@/core/view';
import type { UiCommandResult } from '@/sidepanel/bridge';

const workerResponseSchema = z.union([
  z.object({ ok: z.literal(true), result: z.unknown().optional() }),
  z.object({ ok: z.literal(false), code: z.string().optional(), error: z.string().optional(), recoverable: z.boolean().optional() }),
]);

function outcome<T>(raw: unknown, schema: z.ZodType<T>): UiCommandResult<T> {
  const envelope = workerResponseSchema.safeParse(raw);
  if (!envelope.success)
    return { ok: false, code: 'transport-malformed-response', message: 'Motion received an invalid response. Try again.' };
  if (!envelope.data.ok)
    return {
      ok: false,
      code: envelope.data.code ?? 'command-refused',
      message: envelope.data.error ?? 'Motion could not complete that action. Try again.',
      ...(envelope.data.recoverable === undefined ? {} : { recoverable: envelope.data.recoverable }),
    };
  const parsed = schema.safeParse(envelope.data.result);
  return parsed.success
    ? { ok: true, data: parsed.data }
    : { ok: false, code: 'transport-invalid-result', message: 'Motion received an invalid response. Try again.' };
}

async function ask(message: unknown): Promise<unknown> {
  try {
    return await chrome.runtime.sendMessage(message) ?? { ok: false, code: 'transport-no-response', error: 'Motion’s background worker did not respond.' };
  } catch (error) {
    return {
      ok: false,
      code: 'transport-unavailable',
      error: error instanceof Error ? error.message : 'Motion could not reach its background worker.',
    };
  }
}

const popupCommandResultSchema = z.object({
  action: popupActionSchema,
  workflowId: z.string().optional(),
  sessionId: z.string().optional(),
  requested: z.boolean().optional(),
});

export interface PopupBridge {
  getContext(): Promise<UiCommandResult<PopupLauncherState>>;
  run(action: PopupAction, state: PopupLauncherState): Promise<UiCommandResult<z.infer<typeof popupCommandResultSchema>>>;
  openSettings(): Promise<UiCommandResult>;
}

export function createPopupBridge(): PopupBridge {
  return {
    async getContext() {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id === undefined)
        return { ok: false, code: 'tab-unavailable', message: 'Motion could not find the current tab. Try again.' };
      return outcome(await ask({ type: 'popup-context', tabId: tab.id }), popupLauncherStateSchema);
    },
    async run(action, state) {
      return outcome(
        await ask({
          type: 'popup-command',
          action,
          tabId: state.tabId,
          sessionId: action === 'continue-session' ? state.relevantSessionId : null,
        }),
        popupCommandResultSchema,
      );
    },
    async openSettings() {
      try {
        await chrome.runtime.openOptionsPage();
        return { ok: true };
      } catch (error) {
        return { ok: false, code: 'settings-unavailable', message: error instanceof Error ? error.message : 'Motion could not open Settings.' };
      }
    },
  };
}
