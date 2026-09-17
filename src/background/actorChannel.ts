import { ACTOR_PORT_NAME } from '@/core/actor/contracts';

/**
 * D-ACTOR-2 (SOL-1): the worker is the only party that opens the actor
 * channel. It calls `chrome.tabs.connect(tabId, {name: ACTOR_PORT_NAME})`,
 * which only a tab's own content scripts can receive — never an extension
 * page. The content script (`src/content/content-script.ts`) is the one
 * that authenticates the resulting port, by checking `port.sender` before
 * wiring it to `act()`. This module intentionally does not accept inbound
 * `chrome.runtime.onConnect` ports on this name: there is nothing for the
 * worker to authenticate about a caller connecting to *it*, since the
 * caller-controlled direction is exactly the one that let a forged
 * consequential capability through before this fix.
 */
export { ACTOR_PORT_NAME };

/**
 * Opens a fresh, single-use port to the tab's content script for one actor
 * request. A fresh port per call (rather than a cached, reused one) avoids
 * ever replaying a request against a stale content-script instance after a
 * navigation, and keeps each capability's lifetime bounded to a single
 * round trip.
 */
export function connectActorPort(tabId: number): chrome.runtime.Port {
  return chrome.tabs.connect(tabId, { name: ACTOR_PORT_NAME });
}
