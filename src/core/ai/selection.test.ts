import { describe, expect, it } from 'vitest';
import { selectProvider } from './selection';
import { DEFAULT_AI_PREFERENCES } from './preferences';

describe('selectProvider', () => {
  it('selects chrome-local without needing a disclosure', () => {
    expect(selectProvider(DEFAULT_AI_PREFERENCES)).toEqual({ kind: 'selected', providerId: 'chrome-local' });
  });

  it('blocks a cloud provider without an accepted disclosure, rather than falling back', () => {
    const prefs = { ...DEFAULT_AI_PREFERENCES, providerId: 'openai' as const };
    expect(selectProvider(prefs)).toEqual({ kind: 'blocked', reason: 'disclosure-required', providerId: 'openai' });
  });

  it('selects a cloud provider once its disclosure is accepted', () => {
    const prefs = { ...DEFAULT_AI_PREFERENCES, providerId: 'anthropic' as const, cloudDisclosureAccepted: ['anthropic' as const] };
    expect(selectProvider(prefs)).toEqual({ kind: 'selected', providerId: 'anthropic' });
  });

  it('never silently substitutes a different provider', () => {
    const prefs = { ...DEFAULT_AI_PREFERENCES, providerId: 'openai' as const, cloudDisclosureAccepted: ['anthropic' as const] };
    const result = selectProvider(prefs);
    expect(result.kind).toBe('blocked');
    if (result.kind === 'blocked') expect(result.providerId).toBe('openai');
  });
});
