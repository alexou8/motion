/**
 * Worker-side proxy for Chrome's on-device model (ARCH D2).
 *
 * The service worker cannot run the Prompt API itself, so this `AIProvider`
 * forwards requests over the `motion-inference` port to whichever side panel
 * currently has one open (via an injected getter, since the worker doesn't
 * own the port's lifecycle). With no host connected, callers get a typed
 * `needs-document-context` blocker rather than an error — the workflow can
 * pause and resume once a panel connects, per VISION §13.
 */

import { ProviderError, type AIProvider, type GenerateRequest, type ProviderAvailability, type ProviderCapabilities } from '@/core/ai/types';
import { clientFrameSchema, hostFrameSchema, type ClientFrame } from './inferenceFrames';
import type { PortLike } from './inferenceHost';

export type PortGetter = () => PortLike | null;

const NEEDS_CONTEXT_MESSAGE = 'Open Motion to continue with Chrome’s on-device AI.';
/** Kept below the 5.5 s bound the provider resolver applies to availability. */
const AVAILABILITY_TIMEOUT_MS = 4_000;

function randomRequestId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export class InferenceClientProvider implements AIProvider {
  readonly id = 'chrome-local' as const;
  readonly displayName = 'Chrome built-in';
  private readonly getPort: PortGetter;
  private readonly availabilityTimeoutMs: number;

  constructor(getPort: PortGetter, availabilityTimeoutMs = AVAILABILITY_TIMEOUT_MS) {
    this.getPort = getPort;
    this.availabilityTimeoutMs = availabilityTimeoutMs;
  }

  async capabilities(): Promise<ProviderCapabilities> {
    return {
      streaming: true,
      cancellation: true,
      backgroundExecution: false,
      cloud: false,
      requiresKey: false,
      structuredOutput: false,
    };
  }

  async availability(): Promise<ProviderAvailability> {
    const port = this.getPort();
    if (!port) return { status: 'needs-document-context', message: NEEDS_CONTEXT_MESSAGE };
    return this.panelAvailability(port);
  }

  /**
   * A connected port only proves a panel is open, not that its
   * `LanguageModel` can run, so ask the panel. A panel that disconnects or
   * stays silent resolves to a typed status instead of a hang.
   */
  private panelAvailability(port: PortLike): Promise<ProviderAvailability> {
    return new Promise((resolve) => {
      const requestId = randomRequestId();
      let settled = false;
      const timer = setTimeout(
        () => finish({ status: 'unavailable', message: 'Chrome’s on-device model didn’t respond. Reopen Motion and try again.' }),
        this.availabilityTimeoutMs,
      );
      const finish = (result: ProviderAvailability) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        port.onMessage.removeListener(onMessage);
        port.onDisconnect.removeListener?.(onDisconnect);
        resolve(result);
      };
      const onMessage = (raw: unknown) => {
        const parsed = hostFrameSchema.safeParse(raw);
        if (!parsed.success || parsed.data.requestId !== requestId) return;
        const frame = parsed.data;
        if (frame.type === 'availability') {
          finish({
            status: frame.status,
            message: frame.message,
            ...(frame.retryAfterMs !== undefined ? { retryAfterMs: frame.retryAfterMs } : {}),
          });
        } else if (frame.type === 'error') {
          finish({ status: 'unavailable', message: frame.message });
        }
      };
      const onDisconnect = () => finish({ status: 'needs-document-context', message: NEEDS_CONTEXT_MESSAGE });
      port.onMessage.addListener(onMessage);
      port.onDisconnect.addListener(onDisconnect);
      try {
        port.postMessage(clientFrameSchema.parse({ type: 'availability', requestId } satisfies ClientFrame));
      } catch {
        onDisconnect();
      }
    });
  }

  async generate(req: GenerateRequest): Promise<string> {
    let out = '';
    for await (const delta of this.stream(req)) out += delta;
    return out;
  }

  async *stream(req: GenerateRequest): AsyncIterable<string> {
    const port = this.getPort();
    if (!port) throw new ProviderError('needs-document-context', NEEDS_CONTEXT_MESSAGE);

    const requestId = randomRequestId();

    type Event = { kind: 'delta'; text: string } | { kind: 'done' } | { kind: 'error'; errorKind: string; message: string };
    const events: Event[] = [];
    let resolveNext: (() => void) | null = null;
    const wake = () => {
      resolveNext?.();
      resolveNext = null;
    };

    const onMessage = (raw: unknown) => {
      const parsed = hostFrameSchema.safeParse(raw);
      if (!parsed.success) return;
      const frame = parsed.data;
      if (frame.requestId !== requestId) return;
      if (frame.type === 'delta') events.push({ kind: 'delta', text: frame.text });
      else if (frame.type === 'done') events.push({ kind: 'done' });
      else if (frame.type === 'error') events.push({ kind: 'error', errorKind: frame.kind, message: frame.message });
      else return;
      wake();
    };
    port.onMessage.addListener(onMessage);

    // A panel that closes mid-stream never sends `done`/`error`; without this
    // the generator would wait forever. Surface it as the same typed blocker as
    // "no panel connected" so the workflow can pause and resume.
    const onDisconnect = () => {
      events.push({ kind: 'error', errorKind: 'needs-document-context', message: NEEDS_CONTEXT_MESSAGE });
      wake();
    };
    port.onDisconnect.addListener(onDisconnect);

    const onAbort = () => {
      const cancel: ClientFrame = { type: 'cancel', requestId };
      try {
        port.postMessage(clientFrameSchema.parse(cancel));
      } catch {
        // The port is already gone; there is no host left to cancel.
      }
      // Wake a generator parked waiting for the next frame — abort itself is
      // the next event, and nothing from the host is guaranteed to arrive.
      wake();
    };
    req.signal?.addEventListener('abort', onAbort);

    try {
      const generateFrame: ClientFrame = {
        type: 'generate',
        requestId,
        request: {
          system: req.system,
          messages: req.messages,
          ...(req.maxOutputTokens ? { maxOutputTokens: req.maxOutputTokens } : {}),
          ...(req.model ? { model: req.model } : {}),
          ...(req.json !== undefined ? { json: req.json } : {}),
        },
      };
      try {
        port.postMessage(clientFrameSchema.parse(generateFrame));
      } catch {
        throw new ProviderError('needs-document-context', NEEDS_CONTEXT_MESSAGE);
      }

      for (;;) {
        if (events.length === 0) {
          if (req.signal?.aborted) throw new ProviderError('cancelled', 'Request cancelled.');
          await new Promise<void>((resolve) => {
            resolveNext = resolve;
          });
          continue;
        }
        const event = events.shift()!;
        if (event.kind === 'delta') {
          yield event.text;
        } else if (event.kind === 'done') {
          return;
        } else {
          throw new ProviderError(
            (event.errorKind as ProviderError['kind']) ?? 'bad-response',
            event.message,
          );
        }
      }
    } finally {
      port.onMessage.removeListener(onMessage);
      port.onDisconnect.removeListener?.(onDisconnect);
      req.signal?.removeEventListener('abort', onAbort);
    }
  }
}
