/**
 * Human-readable explanations for every `ProviderStatus` (ARCH D1 / VISION
 * §15). Raw HTTP errors never reach a student — this is the single place
 * that translates status into language they can act on.
 */

import type { ProviderAvailability, ProviderId } from './types';

const DISPLAY_NAMES: Record<ProviderId, string> = {
  'chrome-local': 'Chrome’s on-device model',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
};

function seconds(ms: number): string {
  return `${Math.max(1, Math.round(ms / 1000))} seconds`;
}

export function explainProviderStatus(providerId: ProviderId, availability: ProviderAvailability): string {
  const name = DISPLAY_NAMES[providerId];
  switch (availability.status) {
    case 'available':
      return `${name} is ready.`;
    case 'downloadable':
      return `${name} needs to download before it can be used. This happens once.`;
    case 'downloading':
      return `${name} is downloading. This will work once it finishes.`;
    case 'unavailable':
      return `${name} is not available in this browser.`;
    case 'not-configured':
      return `${name} isn’t set up yet. Add an API key in Motion’s settings to use it.`;
    case 'needs-document-context':
      return 'Open Motion to continue with Chrome’s on-device AI.';
    case 'needs-permission':
      return `Motion needs permission to reach ${name}. Grant it in Motion’s settings.`;
    case 'invalid-key':
      return `Your ${name} API key is no longer valid. Reconnect.`;
    case 'rate-limited':
      return availability.retryAfterMs
        ? `${name} is rate limited. Retrying in ${seconds(availability.retryAfterMs)}.`
        : `${name} is rate limited. Try again shortly.`;
    case 'insufficient-quota':
      return `Your ${name} account is out of quota. Check your billing with ${name}.`;
    case 'network-error':
      return `Motion couldn’t reach ${name}. Check your connection and try again.`;
    case 'model-unavailable':
      return `The selected ${name} model is no longer available. Motion will use its recommended model instead.`;
  }
}
