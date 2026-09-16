import { describe, expect, it } from 'vitest';
import { aiPreferencesSchema, parseAIPreferences, DEFAULT_AI_PREFERENCES } from './preferences';

describe('aiPreferencesSchema', () => {
  it('accepts a full valid preferences object', () => {
    const result = aiPreferencesSchema.safeParse({
      providerId: 'anthropic',
      model: 'claude-opus-5',
      cloudDisclosureAccepted: ['anthropic'],
      autoOpenRelatedTabs: true,
      allowedConfigurableActions: ['edit-draft', 'toggle-control'],
    });
    expect(result.success).toBe(true);
  });

  it('rejects an unknown provider id', () => {
    expect(aiPreferencesSchema.safeParse({ providerId: 'made-up' }).success).toBe(false);
  });

  it('rejects a configurable action id outside the declared tier', () => {
    const result = aiPreferencesSchema.safeParse({
      providerId: 'chrome-local',
      allowedConfigurableActions: ['submit-assignment'],
    });
    expect(result.success).toBe(false);
  });

  it('defaults optional fields', () => {
    const result = aiPreferencesSchema.parse({ providerId: 'chrome-local' });
    expect(result.model).toBe('recommended');
    expect(result.cloudDisclosureAccepted).toEqual([]);
    expect(result.autoOpenRelatedTabs).toBe(false);
    expect(result.allowedConfigurableActions).toEqual([]);
  });
});

describe('parseAIPreferences', () => {
  it('falls back to defaults on invalid stored data', () => {
    expect(parseAIPreferences({ providerId: 'nonsense' })).toEqual(DEFAULT_AI_PREFERENCES);
    expect(parseAIPreferences(undefined)).toEqual(DEFAULT_AI_PREFERENCES);
    expect(parseAIPreferences('a string')).toEqual(DEFAULT_AI_PREFERENCES);
  });
});
