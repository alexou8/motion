/**
 * Non-secret AI preferences storage (ARCH D3).
 *
 * `chrome.storage.local` under a single `motion.preferences` key,
 * Zod-validated on the way out so a corrupt or pre-migration value never
 * reaches the rest of Motion — it falls back to defaults instead.
 */

import { aiPreferencesSchema, DEFAULT_AI_PREFERENCES, type AIPreferences } from '@/core/ai/preferences';
import type { StorageArea } from './secrets';

const STORAGE_KEY = 'motion.preferences';

export interface PreferencesStore {
  get(): Promise<AIPreferences>;
  set(preferences: AIPreferences): Promise<void>;
  update(patch: Partial<AIPreferences>): Promise<AIPreferences>;
}

export class ChromePreferencesStore implements PreferencesStore {
  private readonly area: StorageArea;

  constructor(area: StorageArea = chrome.storage.local as unknown as StorageArea) {
    this.area = area;
  }

  async get(): Promise<AIPreferences> {
    const result = await this.area.get(STORAGE_KEY);
    const raw = result[STORAGE_KEY];
    if (raw === undefined) return DEFAULT_AI_PREFERENCES;
    const parsed = aiPreferencesSchema.safeParse(raw);
    return parsed.success ? parsed.data : DEFAULT_AI_PREFERENCES;
  }

  async set(preferences: AIPreferences): Promise<void> {
    const validated = aiPreferencesSchema.parse(preferences);
    await this.area.set({ [STORAGE_KEY]: validated });
  }

  async update(patch: Partial<AIPreferences>): Promise<AIPreferences> {
    const current = await this.get();
    const next = aiPreferencesSchema.parse({ ...current, ...patch });
    await this.area.set({ [STORAGE_KEY]: next });
    return next;
  }
}
