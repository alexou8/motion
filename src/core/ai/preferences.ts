/**
 * Non-secret AI preferences (ARCH D3 / VISION §19).
 *
 * Lives in `chrome.storage.local` under `motion.preferences` (see
 * `src/platform/ai/preferencesStore.ts`). Never holds a raw API key — see
 * `src/platform/ai/secrets.ts` for that.
 */

import { z } from 'zod';
import {
  CONFIGURABLE_ACTION_IDS,
  configurableActionIdSchema,
  type ConfigurableActionId,
} from '../policy/actions';

export const PROVIDER_IDS = ['chrome-local', 'openai', 'anthropic'] as const;

export { CONFIGURABLE_ACTION_IDS, type ConfigurableActionId };

export const aiPreferencesSchema = z.object({
  providerId: z.enum(PROVIDER_IDS),
  model: z.string().min(1).default('recommended'),
  /** Providers whose cloud-processing disclosure the student has accepted. */
  cloudDisclosureAccepted: z.array(z.enum(PROVIDER_IDS)).default([]),
  autoOpenRelatedTabs: z.boolean().default(false),
  allowedConfigurableActions: z.array(configurableActionIdSchema).default([]),
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
