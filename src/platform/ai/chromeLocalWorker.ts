/**
 * Worker-side `chrome-local` provider (ARCH D2, revised).
 *
 * An earlier version of this file assumed the Prompt API never runs in the
 * MV3 service worker. A live probe on Chromium 153 found `typeof
 * LanguageModel === 'function'` in BOTH the service worker and extension
 * document contexts — but `LanguageModel.availability()` hangs forever when
 * the model component is absent, so `ChromeLocalProvider` already bounds
 * every call to it with a timeout (`CHROME_LOCAL_PROBE_TIMEOUT_MS`).
 *
 * This provider composes the two ways `chrome-local` can actually run from
 * the worker, in preference order:
 *
 *   1. A side panel has a `motion-inference` port open — proxy to it. This
 *      is preferred when available because a panel staying open for the
 *      session is the reliable path VISION §13 describes.
 *   2. No panel connected, but the Prompt API answers 'available' in-context
 *      within the timeout — run it directly in the worker.
 *   3. Neither: report `needs-document-context` if a panel could plausibly
 *      help (i.e. the worker's own in-context probe isn't a hard
 *      `unavailable`), otherwise the real (dis)availability status.
 *
 * `capabilities().backgroundExecution` reflects path (2) at call time — it
 * is only true when this context can run inference without a panel.
 */

import { ProviderError, type AIProvider, type GenerateRequest, type ProviderAvailability, type ProviderCapabilities } from '@/core/ai/types';
import { ChromeLocalProvider, languageModelGlobal } from './chromeLocal';
import { InferenceClientProvider, type PortGetter } from './inferenceClient';

const NEEDS_CONTEXT_MESSAGE = 'Open Motion to continue with Chrome’s on-device AI.';

export class WorkerChromeLocalProvider implements AIProvider {
  readonly id = 'chrome-local' as const;
  readonly displayName = 'Chrome built-in';
  private readonly getPort: PortGetter;
  private readonly local: ChromeLocalProvider;

  constructor(getPort: PortGetter, local: ChromeLocalProvider = new ChromeLocalProvider()) {
    this.getPort = getPort;
    this.local = local;
  }

  private portProvider(): InferenceClientProvider | null {
    const port = this.getPort();
    return port ? new InferenceClientProvider(() => port) : null;
  }

  /** Whether the Prompt API is directly usable in this context right now. */
  private async inContextAvailability(): Promise<ProviderAvailability | null> {
    if (typeof languageModelGlobal() === 'undefined') return null;
    return this.local.availability();
  }

  async capabilities(): Promise<ProviderCapabilities> {
    const inContext = await this.inContextAvailability();
    return {
      streaming: true,
      cancellation: true,
      backgroundExecution: inContext?.status === 'available',
      cloud: false,
      requiresKey: false,
      structuredOutput: false,
    };
  }

  async availability(): Promise<ProviderAvailability> {
    const portProvider = this.portProvider();
    if (portProvider) return portProvider.availability();

    const inContext = await this.inContextAvailability();
    if (inContext && inContext.status === 'available') return inContext;
    if (inContext) return inContext; // downloadable / downloading / unavailable — the real status

    // No panel, and the API isn't present in this context at all.
    return { status: 'needs-document-context', message: NEEDS_CONTEXT_MESSAGE };
  }

  private async pickProvider(): Promise<AIProvider> {
    const portProvider = this.portProvider();
    if (portProvider) return portProvider;

    const inContext = await this.inContextAvailability();
    if (inContext?.status === 'available') return this.local;

    return portProvider ?? this.local; // falls through to a typed error from whichever ran
  }

  async generate(req: GenerateRequest): Promise<string> {
    const availability = await this.availability();
    if (availability.status !== 'available') {
      throw new ProviderError(availability.status, availability.message, availability.retryAfterMs);
    }
    const provider = await this.pickProvider();
    return provider.generate(req);
  }

  async *stream(req: GenerateRequest): AsyncIterable<string> {
    const availability = await this.availability();
    if (availability.status !== 'available') {
      throw new ProviderError(availability.status, availability.message, availability.retryAfterMs);
    }
    const provider = await this.pickProvider();
    yield* provider.stream(req);
  }
}
