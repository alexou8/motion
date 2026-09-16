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

chrome.runtime.onMessage.addListener((raw: unknown, _sender, sendResponse) => {
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
});

initObserver();
