/**
 * Human-readable explanations for every `ProviderStatus` (ARCH D1 / VISION
 * §15). Raw HTTP errors never reach a student — this is the single place
 * that translates status into language they can act on.
 */

import type { ProviderAvailability, ProviderErrorKind, ProviderId } from './types';

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
      // Also covers provider overload (HTTP 529), which is retried the same way.
      return availability.retryAfterMs
        ? `${name} is rate limited or overloaded. Retrying in ${seconds(availability.retryAfterMs)}.`
        : `${name} is rate limited or overloaded. Try again shortly.`;
    case 'insufficient-quota':
      return `Your ${name} account is out of quota. Check your billing with ${name}.`;
    case 'network-error':
      return `Motion couldn’t reach ${name}. Check your connection and try again.`;
    case 'model-unavailable':
      return `The selected ${name} model is no longer available. Choose another model in Motion’s settings.`;
  }
}

/** Explains an error whose result may have been processed by a provider. */
export function explainProviderError(providerId: ProviderId, kind: ProviderErrorKind, fallbackMessage = ''): string {
  if (kind === 'outcome-unknown') {
    return `Motion lost contact with ${DISPLAY_NAMES[providerId]}; the request may have been processed and charged. Retry?`;
  }
  if (kind === 'timeout') return timeoutMessage(providerId, false);
  if (kind === 'forbidden') {
    return `Your ${DISPLAY_NAMES[providerId]} API key doesn’t have permission to use this model. Check the key’s access or choose another model in Motion’s settings.`;
  }
  if (kind === 'server-error') return `${DISPLAY_NAMES[providerId]} is having trouble right now. Try again shortly.`;
  if (kind === 'bad-request') {
    return fallbackMessage || `${DISPLAY_NAMES[providerId]} rejected the request. Try a shorter request or another model.`;
  }
  if (kind === 'cancelled' || kind === 'bad-response') return fallbackMessage;
  return explainProviderStatus(providerId, { status: kind, message: fallbackMessage });
}

/**
 * A timeout after a chargeable request was sent is also an unknown outcome:
 * the provider may have processed and billed it before going quiet.
 */
export function timeoutMessage(providerId: ProviderId, outcomeUnknown: boolean): string {
  const base = `${DISPLAY_NAMES[providerId]} took too long to respond.`;
  return outcomeUnknown ? `${base} The request may have been processed and charged. Retry?` : `${base} Try again.`;
}
