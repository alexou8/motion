import { EMPTY_PANEL_STATE, panelStateSchema, type PanelState } from '@/core/view';
import { originPatternFor } from '@/platform/permissions';
import { resolveAdapter } from '@/core/adapters';
import { z } from 'zod';
import type { MotionBridge, MotionCommand, UiCommandResult } from './bridge';
import { parseWorkerResult } from './responses';
import { ChromeLocalProvider } from '@/platform/ai/chromeLocal';
import { attachInferenceHost } from '@/platform/ai/inferenceHost';
import { INFERENCE_PORT_NAME } from '@/platform/ai/inferenceFrames';

/**
 * Connects the panel to the service worker.
 *
 * This is the only file in `src/sidepanel/` allowed to touch `chrome.*`. The
 * views take a `MotionBridge` and know nothing about extension messaging, which
 * is what lets the whole UI render in tests against a fake.
 *
 * The panel holds no database handle and no repository: it asks the worker for
 * state and sends it narrow commands. If the panel is ever XSS'd, that is the
 * entire surface an attacker inherits (docs/THREAT_MODEL.md T3).
 */

type Listener = () => void;

const workerResponseSchema = z.union([
  z.object({ ok: z.literal(true), result: z.unknown().optional() }),
  z.object({ ok: z.literal(false), code: z.string().optional(), error: z.string().optional(), recoverable: z.boolean().optional() }),
]);

/**
 * Resolves the LMS tab to act on, ignoring tabs that cannot host an LMS page
 * (the panel's own `chrome-extension://` page, `chrome://` pages, etc.).
 *
 * The active tab is preferred when it qualifies. Side panels stay open across
 * tab switches, and the panel document itself is briefly the "active" tab at
 * click time from Chrome's perspective, so falling back to the most recently
 * accessed qualifying tab in the window keeps "scan" and "build checklist"
 * targeting the LMS tab the student actually meant.
 */
export async function resolveLmsTab(): Promise<chrome.tabs.Tab | null> {
  const isQualifying = (tab: chrome.tabs.Tab) =>
    typeof tab.url === 'string' && /^https?:\/\//.test(tab.url);

  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (active && isQualifying(active)) return active;

  const tabs = await chrome.tabs.query({ currentWindow: true });
  const qualifying = tabs.filter(isQualifying);
  if (qualifying.length === 0) return null;

  qualifying.sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
  return qualifying[0] ?? null;
}

async function ask(message: unknown): Promise<unknown> {
  try {
    const response = await chrome.runtime.sendMessage(message);
    return response ?? { ok: false, code: 'transport-no-response', error: 'The background worker did not respond.' };
  } catch (error) {
    return { ok: false, code: 'transport-unavailable', error: error instanceof Error ? error.message : 'Motion could not reach its background worker.' };
  }
}

export function toUiCommandResult<T = undefined>(raw: unknown, parser?: (value: unknown) => T | null): UiCommandResult<T> {
  const envelope = workerResponseSchema.safeParse(raw);
  if (!envelope.success)
    return { ok: false, code: 'transport-malformed-response', message: 'Motion received an invalid response from its background worker. Try again.' };
  if (!envelope.data.ok)
    return {
      ok: false,
      code: envelope.data.code ?? 'command-refused',
      message: envelope.data.error ?? 'Motion could not complete that action. Try again.',
      ...(envelope.data.recoverable === undefined ? {} : { recoverable: envelope.data.recoverable }),
    };
  // A transport success only says the worker answered. Commands also carry
  // explicit domain no-ops (closed workspace tab, terminal session, declined
  // extraction). Do not clear UI feedback or report success for those results.
  const result = envelope.data.result;
  if (typeof result === 'object' && result !== null) {
    const domain = result as { updated?: unknown; requested?: unknown; session?: unknown; refusal?: unknown; reason?: unknown };
    const refusal = typeof domain.refusal === 'object' && domain.refusal !== null
      ? (domain.refusal as { message?: unknown }).message
      : undefined;
    const message = typeof refusal === 'string'
      ? refusal
      : typeof domain.reason === 'string'
        ? domain.reason
        : 'Motion could not complete that action. Try again.';
    if (domain.updated === false || domain.requested === false || domain.session === null || typeof refusal === 'string')
      return { ok: false, code: 'command-refused', message };
  }
  if (parser) {
    const parsed = parser(envelope.data.result);
    return parsed === null
      ? { ok: false, code: 'transport-invalid-result', message: 'Motion received an invalid result. Refresh and try again.' }
      : { ok: true, data: parsed };
  }
  return { ok: true };
}

/**
 * Translates a panel command into the worker's message vocabulary.
 *
 * The two are kept separate on purpose: the panel speaks in terms of what the
 * student did, and the worker in terms of what it will do. Anything requiring a
 * tab id is resolved here from the live active tab rather than trusted from the
 * command, so a view cannot name a tab it has no business touching.
 */
async function toWorkerMessage(
  command: MotionCommand,
  state: PanelState,
): Promise<Record<string, unknown> | null> {
  switch (command.type) {
    case 'session-create': {
      if (command.tabId !== null) return command;
      const tab = await resolveLmsTab();
      return { ...command, tabId: tab?.id ?? null };
    }
    case 'session-message': {
      if (command.tabId !== null) return command;
      const tab = await resolveLmsTab();
      return { ...command, tabId: tab?.id ?? null };
    }
    case 'session-adopt-current-tab': {
      const tab = await resolveLmsTab();
      if (tab?.id === undefined) return null;
      return { type: 'session-tab', sessionId: command.sessionId, tabId: tab.id, op: 'adopt' };
    }
    case 'session-command':
    case 'set-deadline-discovery-opt-in':
    case 'session-select':
    case 'session-source':
    case 'session-tab':
    case 'ai-status':
    case 'set-provider-key':
    case 'forget-provider-key':
    case 'test-provider':
    case 'set-ai-preferences':
    case 'accept-cloud-disclosure':
    case 'delete-local-data':
      return command;
    case 'build-checklist': {
      const tab = await resolveLmsTab();
      if (tab?.id === undefined) return null;
      return { type: 'build-checklist', tabId: tab.id, taskId: null };
    }
    case 'scan-all-courses': {
      const tab = await resolveLmsTab();
      return tab?.id === undefined ? null : { type: 'scan-all-courses', tabId: tab.id };
    }
    case 'toggle-requirement':
      return {
        type: 'toggle-requirement',
        checklistId: command.checklistId,
        requirementId: command.requirementId,
        done: command.done,
      };
    case 'compose-draft':
      return {
        type: 'compose-draft',
        kind: command.kind,
        checklistId: command.checklistId ?? null,
        title: command.title || state.page.title || 'Coursework',
        ...(command.existingDraft ? { existingDraft: command.existingDraft } : {}),
        ...(command.studentDirection ? { studentDirection: command.studentDirection } : {}),
        ...(command.targetWords ? { targetWords: command.targetWords } : {}),
      };
    case 'review-draft':
      return { type: 'review-draft', checklistId: command.checklistId, draft: command.draft };
    case 'get-checklist':
      return { type: 'get-checklist', checklistId: command.checklistId };
    default:
      return null;
  }
}

/**
 * Hosts Chrome's on-device model for the worker (ARCH D2): the Prompt API
 * only runs in an extension document, never the MV3 service worker, so the
 * side panel connects a `motion-inference` port outward — which the worker's
 * own `onConnect` listener receives — and serves generate/cancel frames over
 * it via {@link attachInferenceHost}. This is platform wiring, not a React
 * concern, so it is called once from `main.tsx`, never from a component.
 *
 * Reconnects with capped exponential backoff whenever the port drops (the
 * worker can restart at any time; MV3 service workers are ephemeral), so the
 * panel keeps offering local inference for as long as it stays open.
 */
export function startLocalInferenceHost(
  connect: () => chrome.runtime.Port = () => chrome.runtime.connect({ name: INFERENCE_PORT_NAME }),
): () => void {
  let stopped = false;
  let detach: (() => void) | null = null;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const MAX_BACKOFF_MS = 30_000;
  const backoffMs = () => Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** attempt);

  const connectOnce = () => {
    if (stopped) return;
    let port: chrome.runtime.Port;
    try {
      port = connect();
    } catch {
      scheduleReconnect();
      return;
    }
    attempt = 0;
    detach = attachInferenceHost(port, new ChromeLocalProvider());
    port.onDisconnect.addListener(() => {
      detach = null;
      scheduleReconnect();
    });
  };

  const scheduleReconnect = () => {
    if (stopped) return;
    attempt += 1;
    timer = setTimeout(connectOnce, backoffMs());
  };

  connectOnce();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    detach?.();
  };
}

export function createRuntimeBridge(): MotionBridge {
  let state: PanelState = EMPTY_PANEL_STATE;
  const listeners = new Set<Listener>();

  const emit = () => {
    for (const listener of listeners) listener();
  };

  const refresh = async (): Promise<void> => {
    const response = await ask({ type: 'get-state' });
    const envelope = workerResponseSchema.safeParse(response);
    if (!envelope.success || !envelope.data.ok) return;
    const parsed = panelStateSchema.safeParse(envelope.data.result);
    // The worker is our own code, but it is still a boundary: a shape we do not
    // recognise is dropped rather than rendered.
    if (!parsed.success) return;

    const next = await withActiveTabContext(parsed.data);
    state = next;
    emit();
  };

  /**
   * The worker knows what was last observed; the panel knows which tab is in
   * front of the student right now. Combining them is what makes the panel
   * show "you are on an unsupported page" instead of stale course data.
   *
   * Only the facts the panel alone holds are applied here — that there is no
   * active tab, that the tab is on a host no adapter claims, that the host
   * permission has not been granted. The worker's own verdict is otherwise
   * returned untouched.
   *
   * It used to end by recomputing the connection as `page.url ? 'supported' :
   * 'idle'`, which threw away exactly the states the worker had worked out from
   * the page type: an unrecognised D2L route and an expired session both still
   * carry a URL, so both rendered the coursework workspace — the panel offering
   * a workspace for a page it had already decided it could not read, and never
   * telling a signed-out student to sign in again.
   */
  const withActiveTabContext = async (base: PanelState): Promise<PanelState> => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = tab?.url;
    if (!url) return { ...base, connection: 'idle' };

    if (base.page.restrictionReason) return { ...base, connection: 'restricted' };

    if (!resolveAdapter(url)) {
      return {
        ...base,
        connection: 'unsupported',
        page: { ...base.page, url: base.page.url, title: tab.title ?? '' },
      };
    }

    const origin = originPatternFor(url);
    if (origin) {
      const granted = await chrome.permissions.contains({ origins: [origin] });
      if (!granted) return { ...base, connection: 'permission-needed' };
    }

    return base;
  };

  // The worker cannot push to a panel that may be closed, so the panel asks.
  // Refresh on open, on tab change, and when a supported page finishes loading.
  void refresh();
  chrome.tabs.onActivated.addListener(() => void refresh());
  chrome.tabs.onUpdated.addListener((_id, changeInfo) => {
    if (changeInfo.status === 'complete' || changeInfo.url) void refresh();
  });

  /**
   * A page reports itself after the tab events have already fired -- the
   * content script loads asynchronously, so on a same-tab navigation the panel
   * would otherwise still be showing the previous page when the new one turns
   * out to be a graded attempt. Observations are written to session storage, so
   * watching that is watching the fact itself rather than a proxy for it.
   */
  chrome.storage.session.onChanged.addListener((changes) => {
    if (Object.keys(changes).some((key) => key.startsWith('observation:'))) void refresh();
  });

  /** Sends a command and returns the worker's answer for the panel to render. */
  const request = async <T,>(command: MotionCommand): Promise<UiCommandResult<T>> => {
    const payload = await toWorkerMessage(command, state);
    if (!payload)
      return { ok: false, code: 'target-unavailable', message: 'Motion could not find a supported page for that action.' };
    const result = toUiCommandResult<T>(await ask(payload), (raw) => parseWorkerResult(command.type, raw) as T | null);
    if (!result.ok) return result;
    await refresh();
    // The worker is a boundary too: version skew or a worker defect must not
    // turn an unexpected result into rendered panel data.
    return result;
  };

  return {
    getState: () => state,
    request,

    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    send: async (command: MotionCommand): Promise<UiCommandResult> => {
      switch (command.type) {
        case 'open-settings':
          await chrome.runtime.openOptionsPage();
          return { ok: true };
        case 'request-permission': {
          // Must run inside the click that produced it: `chrome.permissions
          // .request` needs a live user gesture and loses it at the first
          // await. This is why the panel asks directly rather than routing the
          // request through the worker (docs/THREAT_MODEL.md T10).
          const origin = state.page.url ? originPatternFor(state.page.url) : null;
          if (!origin) return { ok: false, code: 'permission-unavailable', message: 'Motion could not identify this page to request access.' };
          // Do not await before this call: Chrome consumes the popup/panel click
          // gesture at the first async boundary.
          const permission = chrome.permissions.request({ origins: [origin] });
          const granted = await permission;
          await refresh();
          return granted
            ? { ok: true }
            : { ok: false, code: 'permission-denied', message: 'Browser access was not granted. You can try again from this page.', recoverable: true };
        }

        case 'read-page': {
          const tab = await resolveLmsTab();
          if (tab?.id === undefined) return { ok: false, code: 'target-unavailable', message: 'Motion could not find the current page.' };
          const result = toUiCommandResult(await ask({ type: 'request-extraction', tabId: tab.id }));
          await refresh();
          return result;
        }

        case 'create-note': {
          const tab = await resolveLmsTab();
          if (!tab?.url || !command.pageUrl) return { ok: false, code: 'target-unavailable', message: 'Motion could not find the page for this note.' };
          const result = toUiCommandResult(await ask({
            type: 'create-note',
            title: tab.title?.slice(0, 200) ?? 'Note',
            courseId: state.course?.id ?? null,
            taskId: null,
            capturedText: '',
            sourceUrl: command.pageUrl,
            pageTitle: tab.title ?? '',
            pageType: state.page.pageType ?? 'unsupported',
          }));
          await refresh();
          return result;
        }

        case 'decide-approval': {
          const result = toUiCommandResult(await ask({
            type: 'decide-approval',
            approvalId: command.approvalId,
            approved: command.approved,
          }));
          await refresh();
          return result;
        }

        case 'session-create':
        case 'session-message':
        case 'session-command':
        case 'session-select':
        case 'session-source':
        case 'session-tab':
        case 'session-adopt-current-tab':
        case 'set-deadline-discovery-opt-in':
        case 'set-provider-key':
        case 'forget-provider-key':
        case 'set-ai-preferences':
        case 'accept-cloud-disclosure':
        case 'delete-local-data':
        case 'build-checklist':
        case 'scan-all-courses': {
          const payload = await toWorkerMessage(command, state);
          if (!payload) return { ok: false, code: 'target-unavailable', message: 'Motion could not find a supported page for that action.' };
          const result = toUiCommandResult(
            await ask(payload),
            command.type === 'session-select'
              ? (raw) => parseWorkerResult('session-select', raw) === null ? null : undefined
              : undefined,
          );
          await refresh();
          return result;
        }
      }
      return { ok: false, code: 'unsupported-command', message: 'Motion does not recognise that action.' };
    },
  };
}
