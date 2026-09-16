/**
 * Provider factory (ARCH D1).
 *
 * The orchestrator wires this into the worker/panel later — kept as a clean
 * factory rather than a singleton so each side (worker vs. panel) can supply
 * the right `chrome-local` implementation (proxy vs. real) without this
 * module needing to know which context it's running in.
 */

import type { AIProvider, ProviderId } from '@/core/ai/types';
import type { SecretStore } from './secrets';
import { OpenAIProvider } from './openai';
import { AnthropicProvider } from './anthropic';
import { ChromeLocalProvider } from './chromeLocal';
import { WorkerChromeLocalProvider } from './chromeLocalWorker';
import type { PortGetter } from './inferenceClient';
import type { FetchLike } from './http';

export interface RegistryDeps {
  secrets: SecretStore;
  fetchImpl?: FetchLike;
  /**
   * How to obtain the local model in this context:
   *
   *   - `'direct'` from a document context that hosts the Prompt API itself
   *     (the side panel's own use, not proxied).
   *   - a `PortGetter` from the worker, which gets the composite
   *     `WorkerChromeLocalProvider` — it prefers a connected panel port but
   *     falls back to running in-context if the worker's own probe of
   *     `globalThis.LanguageModel` answers 'available' in time (see
   *     `chromeLocalWorker.ts`; the Prompt API's presence in the worker
   *     turned out not to be a safe assumption either way, so both paths are
   *     tried rather than one being hard-coded).
   */
  chromeLocal: PortGetter | 'direct';
}

export function createProvider(id: ProviderId, deps: RegistryDeps): AIProvider {
  switch (id) {
    case 'openai':
      return new OpenAIProvider({ secrets: deps.secrets, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) });
    case 'anthropic':
      return new AnthropicProvider({ secrets: deps.secrets, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) });
    case 'chrome-local':
      return deps.chromeLocal === 'direct' ? new ChromeLocalProvider() : new WorkerChromeLocalProvider(deps.chromeLocal);
  }
}
