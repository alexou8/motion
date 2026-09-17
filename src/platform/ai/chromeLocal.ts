/**
 * Chrome's built-in on-device model, as an `AIProvider` (ARCH D2 / VISION
 * §13).
 *
 * Feature-detected: `globalThis.LanguageModel` is missing entirely on most
 * Chromium browsers (Brave, older Chrome, non-Chrome), and this must degrade
 * to `unavailable` without throwing rather than assuming "Chromium" implies
 * "has the Prompt API".
 *
 * A live probe on Chromium 153 (see orchestrator notes) found `typeof
 * LanguageModel === 'function'` in BOTH the service worker and extension
 * document contexts, but `LanguageModel.availability()` never resolves when
 * the underlying model component is absent — it just hangs. So the
 * feature-detect above is not enough on its own: every call into the real
 * API here is wrapped in a bounded timeout and treated as `unavailable` if
 * it doesn't answer in time, rather than awaited unbounded. See
 * `chromeLocalWorker.ts` for the worker-side composite that decides between
 * running here in-context vs. proxying to a side panel over a port.
 */

import { ProviderError, type AIProvider, type GenerateRequest, type ProviderAvailability, type ProviderCapabilities } from '@/core/ai/types';

export type ChromeLocalAvailability = 'unavailable' | 'downloadable' | 'downloading' | 'available';

interface LanguageModelSession {
  prompt(input: string, options?: { signal?: AbortSignal }): Promise<string>;
  promptStreaming(input: string, options?: { signal?: AbortSignal }): AsyncIterable<string>;
  destroy(): void;
}

interface LanguageModelGlobal {
  availability(options?: { expectedInputs?: { type: string; languages?: string[] }[]; expectedOutputs?: { type: string; languages?: string[] }[] }): Promise<ChromeLocalAvailability>;
  create(options?: {
    initialPrompts?: { role: 'system' | 'user' | 'assistant'; content: string }[];
    signal?: AbortSignal;
  }): Promise<LanguageModelSession>;
}

export function languageModelGlobal(): LanguageModelGlobal | undefined {
  const withModel = globalThis as unknown as { LanguageModel?: LanguageModelGlobal };
  return typeof withModel.LanguageModel === 'undefined' ? undefined : withModel.LanguageModel;
}

function toProviderStatus(state: ChromeLocalAvailability): ProviderAvailability['status'] {
  switch (state) {
    case 'available':
      return 'available';
    case 'downloadable':
      return 'downloadable';
    case 'downloading':
      return 'downloading';
    case 'unavailable':
      return 'unavailable';
  }
}

const EXPECTED_IO = [{ type: 'text', languages: ['en'] }];

/** Bound on `LanguageModel.availability()`/`.create()`, which can hang forever rather than reject. */
export const CHROME_LOCAL_PROBE_TIMEOUT_MS = 5_000;
const HUNG_MESSAGE = 'Chrome’s on-device AI did not respond in this browser.';

class ProbeTimeout extends Error {}

/** Races `run()` against a timer; resolves to the timeout sentinel rather than hanging forever. */
async function withTimeout<T>(run: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ProbeTimeout()), timeoutMs);
  });
  try {
    return await Promise.race([run(), timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

export class ChromeLocalProvider implements AIProvider {
  readonly id = 'chrome-local' as const;
  readonly displayName = 'Chrome built-in';
  private readonly timeoutMs: number;

  constructor(timeoutMs: number = CHROME_LOCAL_PROBE_TIMEOUT_MS) {
    this.timeoutMs = timeoutMs;
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
    const model = languageModelGlobal();
    if (!model) {
      return { status: 'unavailable', message: 'This browser does not have an on-device model available.' };
    }
    try {
      const state = await withTimeout(
        () => model.availability({ expectedInputs: EXPECTED_IO, expectedOutputs: EXPECTED_IO }),
        this.timeoutMs,
      );
      const status = toProviderStatus(state);
      const message =
        status === 'available'
          ? 'Chrome’s on-device model is ready.'
          : status === 'downloadable'
            ? 'Chrome needs to download its on-device model before Motion can draft. This happens once.'
            : status === 'downloading'
              ? 'Chrome is downloading its on-device model. Drafting will work once it finishes.'
              : 'This browser does not have an on-device model available.';
      return { status, message };
    } catch (err) {
      if (err instanceof ProbeTimeout) {
        return { status: 'unavailable', message: HUNG_MESSAGE };
      }
      return { status: 'unavailable', message: 'This browser does not have an on-device model available.' };
    }
  }

  private async session(req: GenerateRequest): Promise<{ session: LanguageModelSession; lastInput: string }> {
    const model = languageModelGlobal();
    if (!model) {
      throw new ProviderError('unavailable', 'This browser does not have an on-device model available.');
    }
    const conversation = req.messages;
    const lastInput = conversation.length > 0 ? conversation[conversation.length - 1]!.content : '';
    const initialPrompts: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
      { role: 'system', content: req.system },
      ...conversation.slice(0, -1),
    ];
    try {
      const session = await withTimeout(
        () =>
          model.create({
            initialPrompts,
            ...(req.signal ? { signal: req.signal } : {}),
          }),
        this.timeoutMs,
      );
      return { session, lastInput };
    } catch (err) {
      if (err instanceof ProbeTimeout) {
        throw new ProviderError('unavailable', HUNG_MESSAGE);
      }
      throw err;
    }
  }

  async generate(req: GenerateRequest): Promise<string> {
    const { session, lastInput } = await this.session(req);
    try {
      return await session.prompt(lastInput, req.signal ? { signal: req.signal } : {});
    } finally {
      session.destroy();
    }
  }

  async *stream(req: GenerateRequest): AsyncIterable<string> {
    const { session, lastInput } = await this.session(req);
    try {
      yield* session.promptStreaming(lastInput, req.signal ? { signal: req.signal } : {});
    } finally {
      session.destroy();
    }
  }
}
