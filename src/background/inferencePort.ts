/**
 * The currently connected, trusted side-panel inference port.
 *
 * The service worker only keeps this live connection while it exists. A
 * worker restart loses the reference by design; the panel reconnects and the
 * next provider resolution observes the new port.
 */

let inferencePort: chrome.runtime.Port | null = null;

/** Registers the worker-side listener synchronously during service-worker startup. */
export function registerInferencePort(): void {
  if (typeof chrome === 'undefined' || !chrome.runtime?.onConnect) return;
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'motion-inference') return;
    const sender = port.sender;
    const extensionOrigin = `chrome-extension://${chrome.runtime.id}`;
    if (
      sender?.id !== chrome.runtime.id
      || !sender.url?.startsWith(`${extensionOrigin}/`)
      || sender.tab !== undefined
    ) {
      port.disconnect();
      return;
    }
    inferencePort = port;
    port.onDisconnect.addListener(() => {
      if (inferencePort === port) inferencePort = null;
    });
  });
}

export function getInferencePort(): chrome.runtime.Port | null {
  return inferencePort;
}
