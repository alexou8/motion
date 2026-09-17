/**
 * Panel-side inference host (ARCH D2).
 *
 * The Prompt API only runs in an extension document, not the MV3 service
 * worker, so the side panel serves a `motion-inference` runtime port and
 * delegates to `ChromeLocalProvider` on the worker's behalf. Every inbound
 * frame is Zod-validated before use — a port is still an extension
 * messaging boundary.
 */

import type { AIProvider } from '@/core/ai/types';
import { ProviderError } from '@/core/ai/types';
import { clientFrameSchema, hostFrameSchema, INFERENCE_PORT_NAME, type HostFrame } from './inferenceFrames';

/** The slice of `chrome.runtime.Port` this module needs, for faking in tests. */
export interface PortLike {
  name: string;
  postMessage(message: unknown): void;
  onMessage: { addListener(fn: (message: unknown) => void): void; removeListener(fn: (message: unknown) => void): void };
  onDisconnect: { addListener(fn: () => void): void };
}

function send(port: PortLike, frame: HostFrame): void {
  port.postMessage(hostFrameSchema.parse(frame));
}

/**
 * Wires one already-connected port to `provider`. Exported separately from
 * `startInferenceHost` so tests can drive it with a fake port and never
 * touch `chrome.runtime`.
 */
export function attachInferenceHost(port: PortLike, provider: AIProvider): () => void {
  const controllers = new Map<string, AbortController>();

  const onMessage = (raw: unknown) => {
    const parsed = clientFrameSchema.safeParse(raw);
    if (!parsed.success) return;
    const frame = parsed.data;

    if (frame.type === 'cancel') {
      controllers.get(frame.requestId)?.abort();
      return;
    }

    const controller = new AbortController();
    controllers.set(frame.requestId, controller);

    void (async () => {
      try {
        for await (const delta of provider.stream({ ...frame.request, signal: controller.signal })) {
          send(port, { type: 'delta', requestId: frame.requestId, text: delta });
        }
        send(port, { type: 'done', requestId: frame.requestId });
      } catch (err) {
        const kind = err instanceof ProviderError ? err.kind : 'bad-response';
        const message = err instanceof Error ? err.message : 'Something went wrong.';
        send(port, { type: 'error', requestId: frame.requestId, kind, message });
      } finally {
        controllers.delete(frame.requestId);
      }
    })();
  };

  port.onMessage.addListener(onMessage);
  port.onDisconnect.addListener(() => {
    for (const controller of controllers.values()) controller.abort();
    controllers.clear();
    port.onMessage.removeListener(onMessage);
  });

  return () => port.onMessage.removeListener(onMessage);
}

/** The slice of `chrome.runtime` this module needs to accept connections. */
export interface RuntimeLike {
  onConnect: { addListener(fn: (port: PortLike) => void): void };
}

/** Registers the host against real `chrome.runtime` connections from the panel. */
export function startInferenceHost(provider: AIProvider, runtime: RuntimeLike = chrome.runtime as unknown as RuntimeLike): void {
  runtime.onConnect.addListener((port) => {
    if (port.name !== INFERENCE_PORT_NAME) return;
    attachInferenceHost(port, provider);
  });
}
