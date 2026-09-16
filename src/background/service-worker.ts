/**
 * Motion's service worker: the only privileged context.
 *
 * Two MV3 rules shape this file and are easy to get wrong:
 *
 *   1. **Listeners must be registered synchronously at the top level.** A
 *      worker woken by an event only receives it if the handler was attached
 *      during the initial evaluation. Registering inside an async bootstrap
 *      loses events silently.
 *   2. **No state lives in module scope.** The worker is killed after ~30s
 *      idle. Anything that matters is read from storage on each event. The
 *      objects built below are stateless wiring, not caches.
 */
import { authorizeMessage, type SenderFacts } from '@/core/messaging';
import { resolveAdapter, supportedHosts } from '@/core/adapters';
import { evaluateAssessmentContext } from '@/core/policy';
import { openDatabase } from '@/core/storage/db';
import { IndexedDbWorkflowStore } from '@/core/storage/workflowStore';
import { handleMessage, forgetTab, handleActionClick } from './router';
import { recoverWorkflows, scheduleRetryAlarm, RETRY_ALARM_PREFIX, LEASE_ALARM_PREFIX } from './recovery';
import { registerInferencePort } from './inferencePort';
import { onTabRemoved, onTabUpdated } from './workspaceEvents';
import { warn } from './log';
import { MODEL_RETRY_ALARM_PREFIX } from './modelTurn';
import { recoverStaleModelRequests } from './sessions';

// --- Registered synchronously. Do not move these into an async function. ---

registerInferencePort();

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'update') {
    // An update can change workflow definitions; recovery decides per version
    // whether an in-flight workflow is upgraded or cancelled.
    void recoverWorkflows();
  }
});

// Register the action directly instead of relying on setPanelBehavior state
// written during installation. Development reloads can replace the worker
// without replaying onInstalled, while this listener exists on every start.
chrome.action.onClicked.addListener((tab) => {
  // This must stay synchronous: Chrome only accepts the user gesture before
  // the first await, so open the panel before starting tab grouping.
  if (tab.windowId !== undefined) {
    void chrome.sidePanel.open({ windowId: tab.windowId }).catch((error) => {
      void warn('Motion: could not open the side panel', error);
    });
  }
  void handleActionClick(tab).catch((error) => {
    void warn('Motion: toolbar grouping failed', error);
  });
});

chrome.runtime.onStartup.addListener(() => {
  void recoverWorkflows();
  void recoverStaleModelRequests();
});

chrome.runtime.onMessage.addListener((raw, sender, sendResponse) => {
  const facts: SenderFacts = {
    extensionId: sender.id,
    runtimeId: chrome.runtime.id,
    tabId: sender.tab?.id,
    senderUrl: sender.tab?.url ?? sender.url,
    frameId: sender.frameId,
  };

  const authorized = authorizeMessage(raw, facts, {
    isSupportedHost: (url) => resolveAdapter(url) !== null,
    extensionOrigin: `chrome-extension://${chrome.runtime.id}`,
  });

  if (!authorized.ok) {
    // Refusals are logged without the payload: a rejected message may contain
    // hostile or personal page content.
    void warn('Motion: rejected a message', authorized.reason);
    sendResponse({ ok: false, error: authorized.reason });
    return false;
  }

  void (async () => {
    try {
      const result = await handleMessage(authorized.message, authorized.tabId);
      sendResponse({ ok: true, result });
    } catch (error) {
      void warn('Motion: message handling failed', error);
      sendResponse({ ok: false, error: error instanceof Error ? error.message : 'Unexpected error' });
    }
  })();

  // Keeps the response channel open for the async work above.
  return true;
});

/**
 * Retries are scheduled with alarms, never setTimeout: a timer dies with the
 * worker, and a workflow that quietly stops retrying is worse than one that
 * fails loudly.
 */
export function handleAlarm(
  alarm: chrome.alarms.Alarm,
  recover: (workflowId?: string) => Promise<void> = recoverWorkflows,
): void {
  if (alarm.name.startsWith(LEASE_ALARM_PREFIX)) {
    const workflowId = alarm.name.slice(LEASE_ALARM_PREFIX.length);
    void recover(workflowId);
  }
  if (alarm.name.startsWith(RETRY_ALARM_PREFIX)) {
    const workflowId = alarm.name.slice(RETRY_ALARM_PREFIX.length);
    void recover(workflowId);
  }
  if (alarm.name.startsWith(MODEL_RETRY_ALARM_PREFIX)) {
    // A rate-limit alarm only makes the session retryable. It must not make a
    // new chargeable provider request without a fresh student retry gesture.
    void recoverStaleModelRequests();
  }
}

chrome.alarms.onAlarm.addListener(handleAlarm);

/** A closed tab has no page for the panel to describe. */
chrome.tabs.onRemoved.addListener((tabId) => {
  void onTabRemoved(tabId).catch((error) => {
    void warn('Motion: workspace tab removal handling failed', error);
  });
  void forgetTab(tabId);
});

/**
 * A tab finishing navigation is a chance to notice work that stalled while the
 * worker was asleep. Stored state does not wake a worker on its own, so every
 * relevant inbound event doubles as a recovery trigger.
 */
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  void onTabUpdated(tabId, changeInfo, tab).catch((error) => {
    void warn('Motion: workspace tab update handling failed', error);
  });
  // A tab that has started going somewhere else is no longer showing what it
  // reported. Drop it now rather than describing the old page — including its
  // URL, which a note would otherwise be filed against — until the new page
  // reports itself.
  if (changeInfo.url !== undefined) void forgetTab(tabId);

  if (changeInfo.status !== 'complete' || !tab.url) return;
  if (!resolveAdapter(tab.url)) return;
  void recoverWorkflows();
});

// --- Helpers used by the handlers above. Stateless by construction. ---

export async function openStore() {
  const db = await openDatabase();
  return new IndexedDbWorkflowStore(db);
}

export { scheduleRetryAlarm, supportedHosts, evaluateAssessmentContext };
