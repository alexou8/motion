/**
 * Curated model lists and resolution (ARCH D4 / VISION §19).
 *
 * Students should never need to understand model IDs. Each provider exposes
 * a short, labelled list plus a `recommended` default; `resolveModel` maps a
 * saved preference back to something usable even after a model is deprecated
 * or renamed, without ever throwing (a bad saved id must not corrupt a
 * session — it just falls back with a notice the caller can surface).
 */

import type { ProviderId } from './types';

export interface CuratedModel {
  id: string;
  label: string;
}

export const CHROME_LOCAL_MODELS: CuratedModel[] = [{ id: 'chrome-on-device', label: 'On-device (Chrome)' }];

export const ANTHROPIC_MODELS: CuratedModel[] = [
  { id: 'claude-sonnet-5', label: 'Balanced' },
  { id: 'claude-opus-5', label: 'Most capable' },
  { id: 'claude-haiku-4-5-20251001', label: 'Fastest' },
];

export const ANTHROPIC_RECOMMENDED = 'claude-sonnet-5';

/** Preference order for resolving OpenAI's "recommended" from `/v1/models`. */
export const OPENAI_RECOMMENDED_PREFERENCE = ['gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6', 'gpt-5.5', 'gpt-5', 'gpt-4.1'];
export const OPENAI_RECOMMENDED_FALLBACK = 'gpt-5';

export const OPENAI_MODELS: CuratedModel[] = [
  { id: 'gpt-5.6-terra', label: 'Balanced' },
  { id: 'gpt-5.6-luna', label: 'Fastest' },
];

export function curatedModelsFor(providerId: ProviderId): CuratedModel[] {
  switch (providerId) {
    case 'chrome-local':
      return CHROME_LOCAL_MODELS;
    case 'anthropic':
      return ANTHROPIC_MODELS;
    case 'openai':
      return OPENAI_MODELS;
  }
}

function recommendedFor(providerId: ProviderId): string {
  switch (providerId) {
    case 'chrome-local':
      return 'chrome-on-device';
    case 'anthropic':
      return ANTHROPIC_RECOMMENDED;
    case 'openai':
      return OPENAI_RECOMMENDED_FALLBACK;
  }
}

/**
 * Picks the exact family id to use for a `recommended` OpenAI request:
 * first entry in `OPENAI_RECOMMENDED_PREFERENCE` present in `listedIds`
 * (exact matches only, so specialized variants such as cyber/pro/mini/nano
 * cannot become the default by sharing a prefix), falling back to a known
 * general-purpose id when none match or no list was supplied.
 */
export function resolveOpenAIRecommended(listedIds?: string[]): string {
  if (!listedIds || listedIds.length === 0) return OPENAI_RECOMMENDED_FALLBACK;
  for (const family of OPENAI_RECOMMENDED_PREFERENCE) {
    if (listedIds.includes(family)) return family;
  }
  const accountFallback = listedIds.find(isAccessibleGeneralPurposeOpenAIModel);
  if (accountFallback) return accountFallback;
  return OPENAI_RECOMMENDED_FALLBACK;
}

export interface ResolvedModel {
  id: string;
  /** Set when the requested/saved model wasn't usable and Motion fell back. */
  fallbackNotice?: string;
  /** Set when a successful account model listing contains no supported model. */
  unavailable?: boolean;
}

function isAccessibleGeneralPurposeOpenAIModel(id: string): boolean {
  if (OPENAI_RECOMMENDED_PREFERENCE.includes(id)) return true;
  return /^(?:gpt-5\.6-(?:terra|luna|sol)|gpt-5\.6|gpt-5\.5|gpt-5|gpt-4\.1)-\d{4}-\d{2}-\d{2}$/.test(id);
}

function accountHasSupportedOpenAIModel(listedIds: string[]): boolean {
  return listedIds.some((id) => OPENAI_RECOMMENDED_PREFERENCE.includes(id) || isAccessibleGeneralPurposeOpenAIModel(id));
}

/**
 * Resolves a saved model preference (`'recommended'` or an explicit id) to a
 * model id to send in a request. Never throws: an unknown or deprecated
 * saved id silently falls back to the provider's recommended model, with a
 * human-readable notice the caller may show once.
 */
export function resolveModel(providerId: ProviderId, preference: string, listedIds?: string[]): ResolvedModel {
  const recommended =
    providerId === 'openai' ? resolveOpenAIRecommended(listedIds) : recommendedFor(providerId);

  const curated = curatedModelsFor(providerId);
  // When `/v1/models` was available, treat it as the account's source of
  // truth. This prevents a curated id that the account cannot access from
  // being sent merely because it remains in the UI catalogue. The historical
  // gpt-5.6 alias remains valid when no account list was available.
  const known = listedIds !== undefined
    ? listedIds.includes(preference) || (preference === 'gpt-5.6' && listedIds.includes('gpt-5.6-sol'))
    : curated.some((m) => m.id === preference) || preference === 'gpt-5.6';
  if (known) return { id: preference };

  if (preference === 'recommended') {
    if (providerId === 'openai' && listedIds !== undefined && !accountHasSupportedOpenAIModel(listedIds)) {
      return { id: '', unavailable: true, fallbackNotice: 'No supported general-purpose OpenAI model is available for this account.' };
    }
    return { id: recommended };
  }

  if (providerId === 'openai' && listedIds !== undefined && !accountHasSupportedOpenAIModel(listedIds)) {
    return { id: '', unavailable: true, fallbackNotice: 'No supported general-purpose OpenAI model is available for this account.' };
  }

  return {
    id: recommended,
    fallbackNotice: `The saved model "${preference}" is no longer available, so Motion used its recommended model instead.`,
  };
}
