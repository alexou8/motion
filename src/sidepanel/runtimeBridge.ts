import { EMPTY_PANEL_STATE, panelStateSchema, type PanelState } from '@/core/view';
import { originPatternFor } from '@/platform/permissions';
import { resolveAdapter } from '@/core/adapters';
import type { MotionBridge, MotionCommand } from './bridge';

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

interface WorkerResponse {
  ok: boolean;
  result?: unknown;
  error?: string;
}

async function ask(message: unknown): Promise<WorkerResponse> {
  try {
    const response = (await chrome.runtime.sendMessage(message)) as WorkerResponse | undefined;
    return response ?? { ok: false, error: 'The background worker did not respond.' };
  } catch (error) {
    // A rejected sendMessage usually means the worker was asleep and is now
    // starting; the caller refreshes, so this is not surfaced as an error.
    return { ok: false, error: error instanceof Error ? error.message : 'Message failed' };
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
    case 'prepare-workspace': {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      return tab?.id === undefined ? null : { type: 'prepare-workspace', tabId: tab.id };
    }
    case 'ask-about-page': {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      return tab?.id === undefined ? null : { type: 'ask-about-page', tabId: tab.id, question: command.question, history: command.history };
    }
    case 'close-workspace': return { type: 'close-workspace', workflowId: command.workflowId };
    case 'build-checklist': {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id === undefined) return null;
      return { type: 'build-checklist', tabId: tab.id, taskId: null };
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
    case 'model-status':
      return { type: 'model-status' };
    default:
      return null;
  }
}

export function createRuntimeBridge(): MotionBridge {
  let state: PanelState = EMPTY_PANEL_STATE;
  const listeners = new Set<Listener>();

  const emit = () => {
    for (const listener of listeners) listener();
  };

  const refresh = async (): Promise<void> => {
    const response = await ask({ type: 'get-state' });
    if (!response.ok) return;
    const parsed = panelStateSchema.safeParse(response.result);
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
  const request = async <T,>(command: MotionCommand): Promise<T | null> => {
    const payload = await toWorkerMessage(command, state);
    if (!payload) return null;
    const response = await ask(payload);
    if (!response.ok) return null;
    await refresh();
    return (response.result as T) ?? null;
  };

  return {
    getState: () => state,
    request,

    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    send: async (command: MotionCommand) => {
      switch (command.type) {
        case 'open-settings':
          await chrome.runtime.openOptionsPage();
          return;
        case 'request-permission': {
          // Must run inside the click that produced it: `chrome.permissions
          // .request` needs a live user gesture and loses it at the first
          // await. This is why the panel asks directly rather than routing the
          // request through the worker (docs/THREAT_MODEL.md T10).
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const origin = tab?.url ? originPatternFor(tab.url) : null;
          if (!origin) return;
          await chrome.permissions.request({ origins: [origin] });
          await refresh();
          return;
        }

        case 'read-page': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (tab?.id === undefined) return;
          await ask({ type: 'request-extraction', tabId: tab.id });
          await refresh();
          return;
        }

        case 'create-note': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (!tab?.url || !command.pageUrl) return;
          await ask({
            type: 'create-note',
            title: tab.title?.slice(0, 200) ?? 'Note',
            courseId: state.course?.id ?? null,
            taskId: null,
            capturedText: '',
            sourceUrl: command.pageUrl,
            pageTitle: tab.title ?? '',
            pageType: state.page.pageType ?? 'unsupported',
          });
          await refresh();
          return;
        }

        case 'decide-approval': {
          await ask({
            type: 'decide-approval',
            approvalId: command.approvalId,
            approved: command.approved,
          });
          await refresh();
          return;
        }

        case 'workflow-command': {
          await ask({
            type: 'workflow-command',
            workflowId: command.workflowId,
            command: command.command,
          });
          await refresh();
          return;
        }

        case 'close-workspace': {
          await ask({ type: 'close-workspace', workflowId: command.workflowId });
          await refresh();
          return;
        }

        case 'prepare-workspace': {
          const payload = await toWorkerMessage(command, state);
          if (payload) await ask(payload);
          await refresh();
          return;
        }
      }
    },
  };
}
