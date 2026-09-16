/**
 * Provider selection (ARCH D1 / VISION §18).
 *
 * Pure: picks the provider a session should use from preferences alone.
 * Never falls back silently — a cloud provider without accepted disclosure
 * is a typed blocker, not a switch to another provider, because a fallback
 * that quietly starts sending coursework off-device is exactly what VISION
 * §18 forbids.
 */

import type { ProviderId } from './types';
import type { AIPreferences } from './preferences';

export interface ProviderSelected {
  kind: 'selected';
  providerId: ProviderId;
}

export interface ProviderBlocked {
  kind: 'blocked';
  reason: 'disclosure-required';
  providerId: ProviderId;
}

export type ProviderSelection = ProviderSelected | ProviderBlocked;

export function selectProvider(preferences: AIPreferences): ProviderSelection {
  const { providerId } = preferences;

  if (providerId === 'chrome-local') return { kind: 'selected', providerId };

  const accepted = preferences.cloudDisclosureAccepted.includes(providerId);
  if (!accepted) return { kind: 'blocked', reason: 'disclosure-required', providerId };

  return { kind: 'selected', providerId };
}
