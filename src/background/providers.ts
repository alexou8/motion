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

import type { AIProvider, ProviderAvailability, ProviderId, ProviderStatus } from '@/core/ai/types';
import { ProviderError } from '@/core/ai/types';
import { explainProviderStatus } from '@/core/ai/explain';
import { resolveModel } from '@/core/ai/models';
import type { AIPreferences } from '@/core/ai/preferences';
import { createProvider, type RegistryDeps } from '@/platform/ai/registry';
import { ChromePreferencesStore, type PreferencesStore } from '@/platform/ai/preferencesStore';
import { SessionSecretStore, type SecretStore } from '@/platform/ai/secrets';
import { getInferencePort } from './inferencePort';

const DISPLAY_NAMES: Record<ProviderId, string> = {
  'chrome-local': 'Chrome’s on-device model',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
};

/** The origin Motion needs host permission for, per cloud provider. */
const PROVIDER_ORIGINS: Partial<Record<ProviderId, string>> = {
  openai: 'https://api.openai.com/*',
  anthropic: 'https://api.anthropic.com/*',
};

export interface Blocker {
  kind: 'provider' | 'document-context' | 'rate-limit' | 'permission';
  message: string;
  retryAt?: number;
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
    if (error.retryAfterMs !== undefined) blocker.retryAt = Date.now() + error.retryAfterMs;
    return blocker;
  }
  return {
    kind: 'provider',
    message: `Motion couldn’t reach ${providerDisplayName}. Try again shortly.`,
  };
}

function explainByKind(
  kind: ProviderStatus | 'cancelled' | 'bad-response',
  providerDisplayName: string,
  retryAfterMs: number | undefined,
  fallbackMessage: string,
): string {
  const providerId = (Object.entries(DISPLAY_NAMES).find(([, name]) => name === providerDisplayName)?.[0] ?? null) as ProviderId | null;
  if (providerId && kind !== 'cancelled' && kind !== 'bad-response') {
    return explainProviderStatus(providerId, {
      status: kind,
      message: fallbackMessage,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    });
  }
  return fallbackMessage || `Motion couldn’t reach ${providerDisplayName}. Try again shortly.`;
}

function cloudOriginFor(providerId: ProviderId): string | undefined {
  return PROVIDER_ORIGINS[providerId];
}

/**
 * Resolves the provider the current session should use for a model turn:
 * reads saved preferences, enforces the cloud-disclosure and host-permission
 * gates, checks time-bounded availability, and never falls back silently to
 * a different provider.
 */
export async function resolveSessionProvider(deps: ResolveSessionProviderDeps = {}): Promise<ProviderResolution> {
  const preferencesStore = deps.preferencesStore ?? new ChromePreferencesStore();
  const secrets = deps.secrets ?? new SessionSecretStore();
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
          },
        };
      }
    }
  }

  const registryDeps: RegistryDeps = {
    secrets,
    chromeLocal: deps.getPort ?? getInferencePort,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
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
    if (availability.retryAfterMs !== undefined) blocker.retryAt = now() + availability.retryAfterMs;
    return { kind: 'blocked', blocker };
  }

  const listedIds = providerId === 'openai' && 'listModels' in provider
    ? await (provider as unknown as { listModels(): Promise<string[]> }).listModels().catch(() => undefined)
    : undefined;
  const resolved = resolveModel(providerId, preferences.model, listedIds);

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
