/**
 * Curated model lists and resolution (ARCH D4 / VISION §19).
 *
 * Settings show named, exact IDs for students who choose a provider model.
 * A short curated list remains available before an account refresh, and
 * `resolveModel` turns a saved preference into either that exact request or a
 * blocker. An explicit choice is never silently replaced at generation time.
 */

import type { ProviderId } from './types';

export interface CuratedModel {
  id: string;
  label: string;
}

export const CHROME_LOCAL_MODELS: CuratedModel[] = [{ id: 'chrome-on-device', label: 'On-device (Chrome)' }];

export const ANTHROPIC_MODELS: CuratedModel[] = [
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 — routine summaries and checklists' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 — writing and planning' },
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 — complex requests' },
  { id: 'claude-fable-5-1', label: 'Claude Fable 5.1 — most demanding requests' },
];

/**
 * Earlier curated ids. They are no longer offered, but a saved preference for
 * one still resolves while the account listing is unavailable, so an update
 * does not turn into a "model unavailable" blocker.
 */
const ANTHROPIC_LEGACY_MODEL_IDS = ['claude-haiku-4-5-20251001', 'claude-haiku-4-5', 'claude-sonnet-5'];

/**
 * Preference order for resolving Anthropic's "recommended" model. Haiku 5.5 is
 * the default because Motion's routine work (summaries, checklists, short
 * drafts) does not need a larger model and it is the lowest-cost current
 * option; Sonnet 5.5 is the next step up if Haiku is not on the account.
 */
export const ANTHROPIC_RECOMMENDED_PREFERENCE = ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5', 'claude-sonnet-5'];
export const ANTHROPIC_RECOMMENDED = ANTHROPIC_RECOMMENDED_PREFERENCE[0]!;

/** Preference order for resolving OpenAI's "recommended" from `/v1/models`. */
export const OPENAI_RECOMMENDED_PREFERENCE = ['gpt-6-luna', 'gpt-6-sol', 'gpt-6-astra', 'gpt-5.4-mini', 'gpt-5.4-nano', 'gpt-5'];
export const OPENAI_RECOMMENDED_FALLBACK = 'gpt-6-luna';

export const OPENAI_MODELS: CuratedModel[] = [
  { id: 'gpt-6-luna', label: 'GPT-6 Luna — lower-cost coursework help' },
  { id: 'gpt-6-sol', label: 'GPT-6 Sol — writing and planning' },
  { id: 'gpt-6-astra', label: 'GPT-6 Astra — complex requests' },
  { id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini — economical routine work' },
  { id: 'gpt-5.4-nano', label: 'GPT-5.4 Nano — economical short tasks' },
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
 * then its dated snapshots, then any supported account model. This always
 * sends an ID the account listed rather than a hard-coded unavailable alias.
 */
export function resolveOpenAIRecommended(listedIds?: string[]): string {
  if (!listedIds || listedIds.length === 0) return OPENAI_RECOMMENDED_FALLBACK;
  for (const family of OPENAI_RECOMMENDED_PREFERENCE) {
    if (listedIds.includes(family)) return family;
  }
  for (const family of OPENAI_RECOMMENDED_PREFERENCE) {
    const snapshot = listedIds.find((id) =>
      id.startsWith(`${family}-`) &&
      /^\d{4}-\d{2}-\d{2}$/.test(id.slice(family.length + 1)) &&
      isAccessibleGeneralPurposeOpenAIModel(id),
    );
    if (snapshot) return snapshot;
  }
  const accountFallback = listedIds.find(isAccessibleGeneralPurposeOpenAIModel);
  if (accountFallback) return accountFallback;
  return OPENAI_RECOMMENDED_FALLBACK;
}

/**
 * Picks the exact id to use for a `recommended` Anthropic request: the first
 * `ANTHROPIC_RECOMMENDED_PREFERENCE` family the account lists (exact id, then
 * a dated snapshot of it). Only when none is listed does it take another
 * supported model, preferring the cheaper Haiku and Sonnet lines over the
 * first-listed (usually newest and costliest) one.
 */
export function resolveAnthropicRecommended(listedIds?: string[]): string {
  if (!listedIds || listedIds.length === 0) return ANTHROPIC_RECOMMENDED;
  for (const family of ANTHROPIC_RECOMMENDED_PREFERENCE) {
    if (listedIds.includes(family)) return family;
  }
  for (const family of ANTHROPIC_RECOMMENDED_PREFERENCE) {
    const snapshot = listedIds.find((id) =>
      id.startsWith(`${family}-`) && /^\d{8}$/.test(id.slice(family.length + 1)) && isSupportedTextModel('anthropic', id));
    if (snapshot) return snapshot;
  }
  const supported = listedIds.filter((id) => isSupportedTextModel('anthropic', id));
  return supported.find((id) => id.includes('haiku'))
    ?? supported.find((id) => id.includes('sonnet'))
    ?? supported[0]
    ?? ANTHROPIC_RECOMMENDED;
}

export interface ResolvedModel {
  id: string;
  /** Explains why a requested model or account catalogue is unavailable. */
  fallbackNotice?: string;
  /** Set when a successful account model listing contains no supported model. */
  unavailable?: boolean;
}

export function isSupportedTextModel(providerId: ProviderId, id: string): boolean {
  const normalized = id.toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,99}$/.test(normalized)) return false;
  if (/(?:audio|image|embedding|transcri(?:be|ption)|tts|moderation|realtime|vision|codex|search|computer|video|safety|whisper|dall-e|sora|pro)/.test(normalized)) return false;
  if (providerId === 'openai') return /^gpt-(?:6|5|4\.1|4o)(?:[.-][a-z0-9-]+)?$/.test(normalized);
  return providerId === 'anthropic' ? normalized.startsWith('claude-') : normalized === 'chrome-on-device';
}

function isAccessibleGeneralPurposeOpenAIModel(id: string): boolean {
  return isSupportedTextModel('openai', id);
}

/**
 * Resolves a saved model preference (`'recommended'` or an explicit id) to a
 * model id to send in a request. An explicit unavailable choice is blocked;
 * Motion never replaces a student's requested model with a different one.
 */
export function resolveModel(providerId: ProviderId, preference: string, listedIds?: string[]): ResolvedModel {
  const recommended = providerId === 'openai'
    ? resolveOpenAIRecommended(listedIds)
    : providerId === 'anthropic'
      ? resolveAnthropicRecommended(listedIds)
      : listedIds?.find((id) => id === recommendedFor(providerId)) ?? listedIds?.find((id) => isSupportedTextModel(providerId, id)) ?? recommendedFor(providerId);

  const curated = curatedModelsFor(providerId);
  // When `/v1/models` was available, treat it as the account's source of
  // truth. This prevents a curated id that the account cannot access from
  // being sent merely because it remains in the UI catalogue.
  const known = listedIds !== undefined
    ? listedIds.includes(preference) && isSupportedTextModel(providerId, preference)
    : curated.some((m) => m.id === preference) || (providerId === 'anthropic' && ANTHROPIC_LEGACY_MODEL_IDS.includes(preference));
  if (known) return { id: preference };

  if (preference === 'recommended') {
    if (listedIds !== undefined && !listedIds.some((id) => isSupportedTextModel(providerId, id))) {
      return { id: '', unavailable: true, fallbackNotice: `No supported ${providerId === 'openai' ? 'OpenAI' : 'Claude'} text model is available for this account.` };
    }
    return { id: recommended };
  }

  if (listedIds !== undefined) {
    return { id: '', unavailable: true, fallbackNotice: `The selected model "${preference}" is unavailable. Choose another model in Motion’s settings.` };
  }

  return {
    id: '',
    unavailable: true,
    fallbackNotice: `The selected model "${preference}" is unavailable. Choose another model in Motion’s settings.`,
  };
}
