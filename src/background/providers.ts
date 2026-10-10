/**
 * Provider resolution for a model turn (ARCH D1/D2/D3 §W5b-2).
 *
 * `resolveSessionProvider` is the single place that turns "the student's
 * saved preferences" into either a ready-to-use `AIProvider` or a typed
 * blocker a session can show and later retry from. No silent fallback: a
 * cloud provider without an accepted disclosure, or without the host
 * permission needed to reach it, is a blocker — never a quiet switch to
 * another provider.
 */

import type { BlockerAction } from '@/core/session/types';
import type { AIProvider, ProviderAvailability, ProviderErrorKind, ProviderId, ProviderStatus } from '@/core/ai/types';
import { ProviderError } from '@/core/ai/types';
import { explainProviderError, explainProviderStatus } from '@/core/ai/explain';
import { isSupportedTextModel, resolveModel } from '@/core/ai/models';
import type { AIPreferences } from '@/core/ai/preferences';
import { createProvider, type RegistryDeps } from '@/platform/ai/registry';
import { E2E_PROVIDER_BASE_URL, type FetchLike } from '@/platform/ai/http';
import { ChromePreferencesStore, type PreferencesStore } from '@/platform/ai/preferencesStore';
import { HybridSecretStore, type SecretStore } from '@/platform/ai/secrets';
import { getInferencePort } from './inferencePort';
import { registerCloudRequest, releaseCloudRequest } from './cloudRequests';

const DISPLAY_NAMES: Record<ProviderId, string> = {
  'chrome-local': 'Chrome’s on-device model',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
};

/**
 * The origin Motion needs host permission for, per cloud provider. The
 * OpenAI origin follows `E2E_PROVIDER_BASE_URL` (see src/platform/ai/http.ts)
 * so this permission check matches the host the e2e provider-hosts build
 * (`MOTION_E2E_PROVIDER_HOSTS=1`) actually declares and calls — a local
 * `http://127.0.0.1` origin — instead of the real OpenAI host, while every
 * other build (including production) keeps the fixed `api.openai.com` origin.
 */
const PROVIDER_ORIGINS: Partial<Record<ProviderId, string>> = {
  openai: `${E2E_PROVIDER_BASE_URL || 'https://api.openai.com'}/*`,
  anthropic: 'https://api.anthropic.com/*',
};

export interface Blocker {
  kind: 'provider' | 'document-context' | 'rate-limit' | 'permission';
  message: string;
  retryAt?: number;
  /** Which control the panel offers; set by the producer, never inferred from `kind`. */
  action?: BlockerAction;
}

export interface ProviderReady {
  kind: 'ready';
  provider: AIProvider;
  providerId: ProviderId;
  model: string;
  displayName: string;
  cloud: boolean;
}

export interface ProviderBlocked {
  kind: 'blocked';
  blocker: Blocker;
}

export type ProviderResolution = ProviderReady | ProviderBlocked;

export interface PermissionsCheck {
  contains(details: { origins: string[] }): Promise<boolean>;
}

export interface ResolveSessionProviderDeps {
  preferencesStore?: PreferencesStore;
  secrets?: SecretStore;
  fetchImpl?: RegistryDeps['fetchImpl'];
  permissions?: PermissionsCheck;
  /** Overridable for tests; defaults to `getInferencePort` from this module. */
  getPort?: () => ReturnType<typeof getInferencePort>;
  now?: () => number;
  /** Panel diagnostics check readiness without fetching the account model catalogue. */
  resolveModelListing?: boolean;
}

function defaultPermissions(): PermissionsCheck {
  return {
    async contains(details) {
      if (typeof chrome === 'undefined' || !chrome.permissions?.contains) return false;
      return chrome.permissions.contains(details);
    },
  };
}

function blockerKindForStatus(status: ProviderStatus | string): Blocker['kind'] {
  if (status === 'needs-document-context') return 'document-context';
  if (status === 'needs-permission') return 'permission';
  if (status === 'rate-limited') return 'rate-limit';
  return 'provider';
}

/**
 * Maps a caught error from a provider call to a typed blocker, using
 * `src/core/ai/explain.ts` for the human-readable text. Any error that
 * isn't a `ProviderError` is treated as a generic provider failure.
 */
export function providerBlockerFromError(error: unknown, providerDisplayName: string): Blocker {
  if (error instanceof ProviderError) {
    const message = explainByKind(error.kind, providerDisplayName, error.retryAfterMs, error.message);
    const kind = blockerKindForStatus(error.kind);
    const blocker: Blocker = { kind, message };
    if (kind === 'permission') blocker.action = 'open-ai-settings';
    if (error.retryAfterMs !== undefined) blocker.retryAt = Date.now() + error.retryAfterMs;
    return blocker;
  }
  return {
    kind: 'provider',
    message: `Motion couldn’t reach ${providerDisplayName}. Try again shortly.`,
  };
}

function explainByKind(
  kind: ProviderErrorKind,
  providerDisplayName: string,
  retryAfterMs: number | undefined,
  fallbackMessage: string,
): string {
  const providerId = (Object.entries(DISPLAY_NAMES).find(([, name]) => name === providerDisplayName)?.[0] ?? null) as ProviderId | null;
  if (providerId) {
    if (kind === 'outcome-unknown' || kind === 'timeout' || kind === 'forbidden' || kind === 'server-error' || kind === 'bad-request') {
      return explainProviderError(providerId, kind, fallbackMessage);
    }
    if (kind !== 'cancelled' && kind !== 'bad-response') {
      return explainProviderStatus(providerId, {
        status: kind,
        message: fallbackMessage,
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      });
    }
  }
  return fallbackMessage || `Motion couldn’t reach ${providerDisplayName}. Try again shortly.`;
}

/** Listing failures that mean the account cannot be used, as opposed to a passing outage. */
// `forbidden` is deliberately absent: a restricted key may lack model-listing
// scope yet still answer requests, so the curated list is used instead.
const LISTING_BLOCKING_KINDS: ReadonlySet<ProviderErrorKind> = new Set<ProviderErrorKind>(['invalid-key', 'insufficient-quota']);

function cloudOriginFor(providerId: ProviderId): string | undefined {
  return PROVIDER_ORIGINS[providerId];
}

/** Recheck mutable consent after setup I/O, immediately before a cloud effect. */
export async function assertCurrentProviderConsent(
  providerId: ProviderId,
  deps: Pick<ResolveSessionProviderDeps, 'preferencesStore' | 'permissions'> = {},
  requireSelected = true,
): Promise<void> {
  if (providerId === 'chrome-local') return;
  const preferences = await (deps.preferencesStore ?? new ChromePreferencesStore()).get();
  if (requireSelected && preferences.providerId !== providerId)
    throw new ProviderError('cancelled', 'The selected provider changed. Start a new turn.');
  if (!preferences.cloudDisclosureAccepted.includes(providerId))
    throw new ProviderError('needs-permission', `Accept the ${DISPLAY_NAMES[providerId]} cloud-processing disclosure before connecting.`);
  const origin = cloudOriginFor(providerId);
  if (!origin || !await (deps.permissions ?? defaultPermissions()).contains({ origins: [origin] }))
    throw new ProviderError('needs-permission', `Grant Motion permission to reach ${DISPLAY_NAMES[providerId]} before connecting.`);
}

/** Enforces consent at the actual network boundary, after credential reads. */
export function guardedProviderFetch(
  providerId: ProviderId,
  deps: Pick<ResolveSessionProviderDeps, 'preferencesStore' | 'permissions' | 'fetchImpl'> = {},
  requireSelected = true,
): FetchLike {
  const fetchImpl = deps.fetchImpl ?? fetch.bind(globalThis);
  return async (input, init) => {
    const key = `network:${crypto.randomUUID()}`;
    const controller = registerCloudRequest(key, providerId);
    const onAbort = () => controller.abort(init?.signal?.reason);
    if (init?.signal?.aborted) onAbort();
    else init?.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      await assertCurrentProviderConsent(providerId, deps, requireSelected);
      if (controller.signal.aborted) throw new DOMException('Request cancelled.', 'AbortError');
      return await fetchImpl(input, { ...init, signal: controller.signal });
    } finally {
      init?.signal?.removeEventListener('abort', onAbort);
      releaseCloudRequest(key, controller);
    }
  };
}

/**
 * Resolves the provider the current session should use for a model turn:
 * reads saved preferences, enforces the cloud-disclosure and host-permission
 * gates, checks time-bounded availability, and never falls back silently to
 * a different provider.
 */
export async function resolveSessionProvider(deps: ResolveSessionProviderDeps = {}): Promise<ProviderResolution> {
  const preferencesStore = deps.preferencesStore ?? new ChromePreferencesStore();
  const secrets = deps.secrets ?? new HybridSecretStore();
  const now = deps.now ?? (() => Date.now());
  const preferences: AIPreferences = await preferencesStore.get();
  const providerId = preferences.providerId;
  const displayName = DISPLAY_NAMES[providerId];
  const cloud = providerId !== 'chrome-local';

  if (cloud) {
    if (!preferences.cloudDisclosureAccepted.includes(providerId)) {
      return {
        kind: 'blocked',
        blocker: {
          kind: 'permission',
          message: `${displayName} processes the content you send using its cloud service. Accept the disclosure in Motion’s settings to use it.`,
          action: 'open-ai-settings',
        },
      };
    }

    const origin = cloudOriginFor(providerId);
    if (origin) {
      const permissions = deps.permissions ?? defaultPermissions();
      const granted = await permissions.contains({ origins: [origin] });
      if (!granted) {
        return {
          kind: 'blocked',
          blocker: {
            kind: 'permission',
            message: `Motion needs permission to reach ${displayName}. Grant it in Motion’s settings.`,
            action: 'open-ai-settings',
          },
        };
      }
    }
  }

  const registryDeps: RegistryDeps = {
    secrets,
    chromeLocal: deps.getPort ?? getInferencePort,
    fetchImpl: guardedProviderFetch(providerId, { preferencesStore, ...(deps.permissions ? { permissions: deps.permissions } : {}),
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) }),
  };
  const provider = createProvider(providerId, registryDeps);

  let availability: ProviderAvailability;
  try {
    availability = await timeBounded(() => provider.availability(), 5_500);
  } catch (error) {
    return { kind: 'blocked', blocker: providerBlockerFromError(error, displayName) };
  }

  if (availability.status !== 'available') {
    const message = availability.message || explainProviderStatus(providerId, availability);
    const blocker: Blocker = { kind: blockerKindForStatus(availability.status), message };
    if (blocker.kind === 'permission') blocker.action = 'open-ai-settings';
    if (availability.retryAfterMs !== undefined) blocker.retryAt = now() + availability.retryAfterMs;
    return { kind: 'blocked', blocker };
  }

  if (deps.resolveModelListing === false) {
    return {
      kind: 'ready',
      provider,
      providerId,
      // This result is used only for panel diagnostics. An account-specific
      // saved ID cannot be judged unavailable until a model-turn/listing
      // request explicitly checks the account catalogue.
      model: preferences.model,
      displayName,
      cloud,
    };
  }

  if (cloud) {
    try { await assertCurrentProviderConsent(providerId, { preferencesStore, ...(deps.permissions ? { permissions: deps.permissions } : {}) }); }
    catch (error) { return { kind: 'blocked', blocker: providerBlockerFromError(error, displayName) }; }
  }
  let listedIds: string[] | undefined;
  if (cloud && provider.listModels) {
    const requestKey = `models:${crypto.randomUUID()}`;
    const controller = registerCloudRequest(requestKey, providerId);
    let listingError: ProviderError | undefined;
    try {
      listedIds = await provider.listModels({ signal: controller.signal }).catch((error: unknown) => {
        // A rejected key or exhausted account will fail the turn anyway; report it
        // now instead of quietly sending against the curated list. Transient
        // failures (network, rate limits) still fall back to the curated ids.
        if (error instanceof ProviderError && LISTING_BLOCKING_KINDS.has(error.kind)) listingError = error;
        return undefined;
      });
    }
    finally { releaseCloudRequest(requestKey, controller); }
    if (listingError && !controller.signal.aborted) return { kind: 'blocked', blocker: providerBlockerFromError(listingError, displayName) };
    if (controller.signal.aborted)
      return { kind: 'blocked', blocker: { kind: 'permission', message: 'The provider connection was revoked. Connect again to continue.' } };
    try { await assertCurrentProviderConsent(providerId, { preferencesStore, ...(deps.permissions ? { permissions: deps.permissions } : {}) }); }
    catch (error) { return { kind: 'blocked', blocker: providerBlockerFromError(error, displayName) }; }
  }
  const resolved = resolveModel(
    providerId,
    preferences.model,
    listedIds?.filter((id) => isSupportedTextModel(providerId, id)),
  );
  if (resolved.unavailable) {
    return {
      kind: 'blocked',
      blocker: {
        kind: 'provider',
        message: resolved.fallbackNotice ?? `No supported ${displayName} model is available for this account.`,
      },
    };
  }

  return {
    kind: 'ready',
    provider,
    providerId,
    model: resolved.id,
    displayName,
    cloud,
  };
}

/** Availability probes are allowed to fail closed; a dead browser API must not hang a turn. */
async function timeBounded<T>(run: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ProviderError('unavailable', 'The selected provider did not respond in time.')), timeoutMs);
  });
  try {
    return await Promise.race([run(), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export const providerDisplayNames = DISPLAY_NAMES;
export const providerOrigins = PROVIDER_ORIGINS;
