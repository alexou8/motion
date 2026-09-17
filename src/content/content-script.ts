/**
 * Motion's content script entry point.
 *
 * Wires together the observer (`observer.ts`, read-only) and the actor
 * (`actor.ts`, the only code here that ever changes a page) behind a single
 * validated message listener. See ARCH D7 / VISION §8.
 */
import { act, buildSnapshot } from '@/content/actor';
import { extract, initObserver, readContent } from '@/content/observer';
import { contentRequestSchema } from '@/core/messaging';
import { ACTOR_PORT_NAME, actorPortRequestSchema, actorPortResponseSchema, type ActRequest } from '@/core/actor/contracts';
import { discoverAllCourses } from './d2lDiscovery';
import { resolveAdapter } from '@/core/adapters';

const consumedActorNonces = new Set<string>();

/**
 * Handles a request sent to the page-adjacent content script.
 *
 * Shape validation is not authentication: only the extension's own service
 * worker may send inward requests, and a message carrying a tab sender is
 * treated as page-adjacent traffic rather than privileged worker traffic.
 */
export function handleContentRequest(
  raw: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void,
): boolean | undefined {
  if (sender.id !== chrome.runtime.id || sender.tab !== undefined) return undefined;

  // The only instructions this script accepts, validated rather than cast.
  // Untrusted page content never reaches this parse — it only ever flows
  // outward, from the content script to the worker.
  const parsed = contentRequestSchema.safeParse(raw);
  if (!parsed.success) return undefined;

  switch (parsed.data.type) {
    case 'motion:extract':
      extract(parsed.data.requestId ?? crypto.randomUUID());
      return undefined;
    case 'motion:extract-content':
      sendResponse(readContent());
      return undefined;
    case 'motion:snapshot':
      sendResponse(buildSnapshot());
      return undefined;
    case 'motion:discover-deadlines':
      {
        const url = window.location.href;
        const adapter = resolveAdapter(url);
        const pageType = adapter?.detectPage({ url, document, now: new Date(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone })?.pageType ?? 'unsupported';
        void discoverAllCourses({ origin: window.location.origin, page: { url, pageType, title: document.title, text: document.body?.innerText ?? '' }, now: () => new Date(), timeZone: () => Intl.DateTimeFormat().resolvedOptions().timeZone, fetch: window.fetch.bind(window) }).then(sendResponse);
      }
      return true;
    default:
      return undefined;
  }
}

chrome.runtime.onMessage.addListener((raw: unknown, sender, sendResponse) => {
  return handleContentRequest(raw, sender, sendResponse);
});

initObserver();

/**
 * D-ACTOR-2 (SOL-1): the actor channel is opened by the worker, never by
 * this content script.
 *
 * A content-script-initiated `chrome.runtime.connect` port is delivered to
 * every extension context listening for `runtime.onConnect`, not only the
 * worker. A compromised or malicious extension page could therefore receive
 * a caller-chosen capability. The content script never opens that channel.
 *
 * Instead this script only accepts a port the worker opens toward this
 * specific tab with `chrome.tabs.connect(tabId, {name: ACTOR_PORT_NAME})`.
 * Extension pages can also open tabs.connect, so this script verifies the
 * browser-provided `sender` before accepting it:
 *   - `sender.id === chrome.runtime.id` (this extension, not another one)
 *   - `sender.tab === undefined` (the worker has no tab; a spoofed sender
 *     claiming to be a tab would prove it is not the service worker)
 *   - `sender.url` equals this extension's built service-worker URL,
 *     resolved from the manifest at runtime rather than hardcoded, so a
 *     renamed or moved build output can't silently disable the check.
 * A port failing any of these is disconnected immediately and never wired
 * to `act()`.
 */
const background = chrome.runtime.getManifest().background;
const workerServiceWorkerPath = background && 'service_worker' in background ? background.service_worker : undefined;
const workerSenderUrl = workerServiceWorkerPath ? chrome.runtime.getURL(workerServiceWorkerPath) : undefined;

function isAuthenticWorkerPort(port: chrome.runtime.Port): boolean {
  const sender = port.sender;
  return (
    port.name === ACTOR_PORT_NAME &&
    sender !== undefined &&
    sender.id === chrome.runtime.id &&
    sender.tab === undefined &&
    workerSenderUrl !== undefined &&
    sender.url === workerSenderUrl
  );
}

if (typeof chrome.runtime.onConnect?.addListener === 'function') {
  chrome.runtime.onConnect.addListener((port: chrome.runtime.Port) => {
    if (!isAuthenticWorkerPort(port)) {
      port.disconnect();
      return;
    }
    port.onMessage.addListener((raw: unknown) => {
      const parsed = actorPortRequestSchema.safeParse(raw);
      if (!parsed.success || consumedActorNonces.has(parsed.data.request.authorization.nonce)) return;
      consumedActorNonces.add(parsed.data.request.authorization.nonce);
      const { requestId, request } = parsed.data;
      const { authorization, ...action } = request;
      Promise.resolve().then(() => act(action as ActRequest, {
        consequentialCapability: authorization.consequentialCapability !== undefined,
      })).catch(() => ({
        ok: false as const,
        error: 'internal-error' as const,
        message: 'The page action could not be completed.',
      })).then((value) => {
        const response = actorPortResponseSchema.parse({ type: 'motion:act-result', requestId, result: value });
        port.postMessage(response);
        try { port.disconnect(); } catch { /* already disconnected */ }
      });
    });
  });
}
