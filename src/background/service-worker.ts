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
import { handleMessage } from './router';
import { recoverWorkflows, scheduleRetryAlarm, RETRY_ALARM_PREFIX } from './recovery';

// --- Registered synchronously. Do not move these into an async function. ---

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
chrome.action.onClicked.addListener(async (tab) => {
  if (tab.windowId === undefined) return;
  try {
    await chrome.sidePanel.open({ windowId: tab.windowId });
  } catch (error) {
    console.warn(
      'Motion: could not open the side panel —',
      error instanceof Error ? error.message : error,
    );
  }
});

chrome.runtime.onStartup.addListener(() => {
  void recoverWorkflows();
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
    console.warn('Motion: rejected a message —', authorized.reason);
    sendResponse({ ok: false, error: authorized.reason });
    return false;
  }

  void (async () => {
    try {
      const result = await handleMessage(authorized.message, authorized.tabId);
      sendResponse({ ok: true, result });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unexpected error';
      console.warn('Motion: message handling failed —', message);
      sendResponse({ ok: false, error: message });
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
chrome.alarms.onAlarm.addListener((alarm) => {
  if (!alarm.name.startsWith(RETRY_ALARM_PREFIX)) return;
  const workflowId = alarm.name.slice(RETRY_ALARM_PREFIX.length);
  void recoverWorkflows(workflowId);
});

/**
 * A tab finishing navigation is a chance to notice work that stalled while the
 * worker was asleep. Stored state does not wake a worker on its own, so every
 * relevant inbound event doubles as a recovery trigger.
 */
chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
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
