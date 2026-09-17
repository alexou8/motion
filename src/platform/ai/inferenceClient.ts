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

function randomRequestId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export class InferenceClientProvider implements AIProvider {
  readonly id = 'chrome-local' as const;
  readonly displayName = 'Chrome built-in';
  private readonly getPort: PortGetter;

  constructor(getPort: PortGetter) {
    this.getPort = getPort;
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
    return { status: 'available', message: 'Chrome’s on-device model is ready.' };
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
      else events.push({ kind: 'error', errorKind: frame.kind, message: frame.message });
      wake();
    };
    port.onMessage.addListener(onMessage);

    const onAbort = () => {
      const cancel: ClientFrame = { type: 'cancel', requestId };
      port.postMessage(clientFrameSchema.parse(cancel));
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
      port.postMessage(clientFrameSchema.parse(generateFrame));

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
      req.signal?.removeEventListener('abort', onAbort);
    }
  }
}
