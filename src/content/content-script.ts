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
): undefined {
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
    case 'click':
    case 'fill':
    case 'select':
    case 'toggle':
    case 'scrollTo':
    case 'focus':
      sendResponse(act(parsed.data));
      return undefined;
    default:
      return undefined;
  }
}

chrome.runtime.onMessage.addListener((raw: unknown, sender, sendResponse) => {
  handleContentRequest(raw, sender, sendResponse);
});

initObserver();
