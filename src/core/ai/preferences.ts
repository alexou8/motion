/**
 * Non-secret AI preferences (ARCH D3 / VISION §19).
 *
 * Lives in `chrome.storage.local` under `motion.preferences` (see
 * `src/platform/ai/preferencesStore.ts`). Never holds a raw API key — see
 * `src/platform/ai/secrets.ts` for that.
 */

import { z } from 'zod';

export const PROVIDER_IDS = ['chrome-local', 'openai', 'anthropic'] as const;

/**
 * The configurable-tier action ids a student can flip to "automatic" (ARCH
 * D5). Policy owns the canonical list; this is declared locally so this
 * schema doesn't reach across worker boundaries. Keep in sync by hand.
 */
export const CONFIGURABLE_ACTION_IDS = [
  'edit-draft',
  'fill-form-field',
  'select-option',
  'toggle-control',
  'save-remote-draft',
  'prepare-upload',
  'prepare-discussion-response',
  'add-calendar-event',
  'prepare-message',
  'click-element',
] as const;

export type ConfigurableActionId = (typeof CONFIGURABLE_ACTION_IDS)[number];

export const aiPreferencesSchema = z.object({
  providerId: z.enum(PROVIDER_IDS),
  model: z.string().min(1).default('recommended'),
  /** Providers whose cloud-processing disclosure the student has accepted. */
  cloudDisclosureAccepted: z.array(z.enum(PROVIDER_IDS)).default([]),
  autoOpenRelatedTabs: z.boolean().default(false),
  allowedConfigurableActions: z.array(z.enum(CONFIGURABLE_ACTION_IDS)).default([]),
});

export type AIPreferences = z.infer<typeof aiPreferencesSchema>;

export const DEFAULT_AI_PREFERENCES: AIPreferences = {
  providerId: 'chrome-local',
  model: 'recommended',
  cloudDisclosureAccepted: [],
  autoOpenRelatedTabs: false,
  allowedConfigurableActions: [],
};

/** Parses stored preferences, falling back to defaults on anything invalid. */
export function parseAIPreferences(value: unknown): AIPreferences {
  const result = aiPreferencesSchema.safeParse(value);
  return result.success ? result.data : DEFAULT_AI_PREFERENCES;
}
