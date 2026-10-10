import { EMPTY_PANEL_STATE, panelStateSchema, type PanelState } from '@/core/view';
import { originPatternFor } from '@/platform/permissions';
import { resolveAdapter } from '@/core/adapters';
import { evaluateAssessmentContext } from '@/core/policy';
import { z } from 'zod';
import type { MotionBridge, MotionCommand, UiCommandResult } from './bridge';
import { parseWorkerResult } from './responses';
import { ChromeLocalProvider } from '@/platform/ai/chromeLocal';
import { attachInferenceHost } from '@/platform/ai/inferenceHost';
import { INFERENCE_PORT_NAME } from '@/platform/ai/inferenceFrames';
import { createDocumentImporter } from './documentBridge';
import { toUiCommandResult } from './commandResult';
export { toUiCommandResult } from './commandResult';

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
const ACTIVE_SESSION_KEY = 'motion.activeSessionId';
const STREAMING_KEY = 'motion.streaming';

const workerResponseSchema = z.union([
  z.object({ ok: z.literal(true), result: z.unknown().optional() }),
  z.object({
    ok: z.literal(false),
    code: z.string().optional(),
    error: z.string().optional(),
    recoverable: z.boolean().optional(),
  }),
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
    return (
      response ?? {
        ok: false,
        code: 'transport-no-response',
        error: 'The background worker did not respond.',
      }
    );
  } catch (error) {
    return {
      ok: false,
      code: 'transport-unavailable',
      error:
        error instanceof Error ? error.message : 'Motion could not reach its background worker.',
    };
  }
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
    case 'get-document-sources': {
      const tab = await resolveLmsTab();
      return tab?.id === undefined ? null : { type: 'get-document-sources', tabId: tab.id };
    }
    case 'get-documents':
    case 'get-document':
    case 'delete-document':
      return command;
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

/** How long a supported tab may stay unobserved before the panel suggests a reload. */
const RELOAD_HINT_GRACE_MS = 600;

/**
 * The assessment verdict for a tab Motion has not observed, from its URL and
 * title alone. Returns the restriction reason, or null when the page type is
 * not an assessment.
 */
function restrictionFromUrl(url: string, title?: string): string | null {
  const pageType = resolveAdapter(url)?.classifyUrl(url);
  if (!pageType) return null;
  const verdict = evaluateAssessmentContext({ pageType, url, ...(title ? { pageTitle: title } : {}) });
  return verdict.restricted ? verdict.reason : null;
}

export function createRuntimeBridge(): MotionBridge {
  let state: PanelState = EMPTY_PANEL_STATE;
  let refreshSequence = 0;
  const listeners = new Set<Listener>();
  const documentListeners = new Set<Listener>();

  const emit = () => {
    for (const listener of listeners) listener();
  };

  /**
   * Reads the worker's state. A failure keeps the last good state but marks it
   * with `workerError`, so the panel can say so and offer Retry instead of
   * silently showing Idle forever. Returns the error message, or null.
   */
  const refresh = async (): Promise<string | null> => {
    const sequence = ++refreshSequence;
    const response = await ask({ type: 'get-state' });
    const envelope = workerResponseSchema.safeParse(response);
    const fail = (message: string): string => {
      if (sequence === refreshSequence) {
        state = { ...state, workerError: message };
        emit();
      }
      return message;
    };
    if (!envelope.success)
      return fail('Motion received an invalid response from its background worker.');
    if (!envelope.data.ok)
      return fail(envelope.data.error ?? 'Motion could not reach its background worker.');
    const parsed = panelStateSchema.safeParse(envelope.data.result);
    // The worker is our own code, but it is still a boundary: a shape we do not
    // recognise is dropped rather than rendered.
    if (!parsed.success)
      return fail(
        "Motion's background worker sent a state this panel does not recognise. Reload Motion from the Extensions page.",
      );

    const next = await withActiveTabContext(parsed.data);
    if (sequence !== refreshSequence) return null;
    state = next;
    emit();
    return null;
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
  // A tab that just finished loading has not had time for its content script
  // to report in; offering "Reload this tab" immediately would flash on every
  // navigation. Remember when each tab was first seen unobserved and only show
  // the hint once that has lasted a moment.
  const unobservedSince = new Map<number, number>();
  const withActiveTabContext = async (base: PanelState): Promise<PanelState> => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = tab?.url;
    if (!url) return { ...base, connection: 'idle', tabNeedsReload: false };

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
      // The worker has no observation for a tab it cannot read, so its page
      // url is null; "Request page permission" needs the tab's own url.
      if (!granted)
        return {
          ...base,
          connection: 'permission-needed',
          page: { ...base.page, url, title: base.page.title || (tab.title ?? '') },
        };
    }

    if (tab.status === 'loading' && tab.id !== undefined) unobservedSince.delete(tab.id);

    // A supported, permitted tab the worker has never heard from has no
    // content script: it was open before Motion was installed or updated.
    // With no observation there is no restriction verdict either, so the URL
    // alone decides: an attempt in progress is never offered a reload.
    if (base.connection === 'idle' && !base.page.observedAt && tab.status !== 'loading' && tab.id !== undefined) {
      const restriction = restrictionFromUrl(url, tab.title);
      if (restriction) return { ...base, connection: 'restricted', page: { ...base.page, url, restrictionReason: restriction } };
      const now = Date.now();
      const since = unobservedSince.get(tab.id) ?? now;
      unobservedSince.set(tab.id, since);
      if (now - since >= RELOAD_HINT_GRACE_MS) return { ...base, tabNeedsReload: true };
      setTimeout(() => void refresh(), RELOAD_HINT_GRACE_MS - (now - since) + 50);
      return base;
    }
    if (tab.id !== undefined) unobservedSince.delete(tab.id);

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
    if (changes['motion.documentRevision'] || changes['motion.documentLifecycle'])
      for (const listener of documentListeners) listener();
    if (
      changes[STREAMING_KEY] ||
      changes[ACTIVE_SESSION_KEY] ||
      changes['motion.courseworkRevision'] ||
      Object.keys(changes).some((key) => key.startsWith('observation:'))
    )
      void refresh();
  });

  /** Sends a command and returns the worker's answer for the panel to render. */
  const request = async <T>(command: MotionCommand): Promise<UiCommandResult<T>> => {
    if (command.type === 'index-document-source') {
      const result = await documents.indexSource(command.handle);
      await refresh();
      return result as UiCommandResult<T>;
    }
    const payload = await toWorkerMessage(command, state);
    if (!payload)
      return {
        ok: false,
        code: 'target-unavailable',
        message: 'Motion could not find a supported page for that action.',
      };
    const result = toUiCommandResult<T>(
      await ask(payload),
      (raw) => parseWorkerResult(command.type, raw) as T | null,
    );
    if (!result.ok) return result;
    if (!['get-documents', 'get-document', 'get-document-sources'].includes(command.type))
      await refresh();
    // The worker is a boundary too: version skew or a worker defect must not
    // turn an unexpected result into rendered panel data.
    return result;
  };

  const documents = createDocumentImporter(
    ask,
    async () => (await resolveLmsTab())?.id,
    () => {
      state = { ...state };
      emit();
    },
  );

  return {
    getState: () => state,
    request,
    importDocument: async (file, courseId) => {
      const result = await documents.importFile(file, courseId);
      await refresh();
      return result;
    },
    cancelDocumentImport: documents.cancel,
    documentImportStatus: documents.status,
    subscribeDocuments: (listener) => {
      documentListeners.add(listener);
      return () => documentListeners.delete(listener);
    },

    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    send: async (command: MotionCommand): Promise<UiCommandResult> => {
      if (command.type === 'index-document-source') {
        const result = await documents.indexSource(command.handle);
        await refresh();
        return result.ok ? { ok: true } : result;
      }
      switch (command.type) {
        case 'open-settings':
          await chrome.runtime.openOptionsPage();
          return { ok: true };
        case 'refresh': {
          const error = await refresh();
          return error === null
            ? { ok: true }
            : { ok: false, code: 'transport-unavailable', message: error, recoverable: true };
        }
        case 'reload-tab': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (tab?.id === undefined || !tab.url || !resolveAdapter(tab.url))
            return {
              ok: false,
              code: 'target-unavailable',
              message: 'Motion could not find a Brightspace tab to reload.',
            };
          // Reloading a graded, timed or proctored attempt could end it.
          if (restrictionFromUrl(tab.url, tab.title))
            return {
              ok: false,
              code: 'restricted',
              message: 'Motion will not reload this tab: it looks like an assessment in progress.',
            };
          await chrome.tabs.reload(tab.id);
          return { ok: true };
        }
        case 'request-permission': {
          // Must run inside the click that produced it: `chrome.permissions
          // .request` needs a live user gesture and loses it at the first
          // await. This is why the panel asks directly rather than routing the
          // request through the worker (docs/THREAT_MODEL.md T10).
          const origin = state.page.url ? originPatternFor(state.page.url) : null;
          if (!origin)
            return {
              ok: false,
              code: 'permission-unavailable',
              message: 'Motion could not identify this page to request access.',
            };
          // Do not await before this call: Chrome consumes the popup/panel click
          // gesture at the first async boundary.
          const permission = chrome.permissions.request({ origins: [origin] });
          const granted = await permission;
          await refresh();
          return granted
            ? { ok: true }
            : {
                ok: false,
                code: 'permission-denied',
                message: 'Browser access was not granted. You can try again from this page.',
                recoverable: true,
              };
        }

        case 'read-page': {
          const tab = await resolveLmsTab();
          if (tab?.id === undefined)
            return {
              ok: false,
              code: 'target-unavailable',
              message: 'Motion could not find the current page.',
            };
          const result = toUiCommandResult(
            await ask({ type: 'request-extraction', tabId: tab.id }),
          );
          await refresh();
          // No content script in the tab: show the reload guidance in place.
          if (!result.ok && result.code === 'content-script-missing') {
            state = { ...state, tabNeedsReload: true };
            emit();
          }
          return result;
        }

        case 'create-note': {
          const tab = await resolveLmsTab();
          if (!tab?.url || !command.pageUrl)
            return {
              ok: false,
              code: 'target-unavailable',
              message: 'Motion could not find the page for this note.',
            };
          const result = toUiCommandResult(
            await ask({
              type: 'create-note',
              title: tab.title?.slice(0, 200) ?? 'Note',
              courseId: state.course?.id ?? null,
              taskId: null,
              capturedText: '',
              sourceUrl: command.pageUrl,
              pageTitle: tab.title ?? '',
              pageType: state.page.pageType ?? 'unsupported',
            }),
          );
          await refresh();
          return result;
        }

        case 'decide-approval': {
          const result = toUiCommandResult(
            await ask({
              type: 'decide-approval',
              approvalId: command.approvalId,
              approved: command.approved,
            }),
          );
          await refresh();
          return result;
        }

        case 'session-create':
        case 'get-document-sources':
        case 'get-documents':
        case 'get-document':
        case 'delete-document':
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
          if (!payload)
            return {
              ok: false,
              code: 'target-unavailable',
              message: 'Motion could not find a supported page for that action.',
            };
          const result = toUiCommandResult(
            await ask(payload),
            command.type === 'session-select'
              ? (raw) => (parseWorkerResult('session-select', raw) === null ? null : undefined)
              : undefined,
          );
          await refresh();
          return result;
        }
      }
      return {
        ok: false,
        code: 'unsupported-command',
        message: 'Motion does not recognise that action.',
      };
    },
  };
}
