import { describe, expect, it } from 'vitest';
import { resolveModel, resolveOpenAIRecommended, ANTHROPIC_RECOMMENDED, OPENAI_RECOMMENDED_FALLBACK } from './models';

describe('resolveOpenAIRecommended', () => {
  it('picks the first preferred family present in the listed ids', () => {
    expect(resolveOpenAIRecommended(['gpt-4.1', 'gpt-5'])).toBe('gpt-5');
  });

  it('excludes -mini and -nano variants from the recommended pick', () => {
    expect(resolveOpenAIRecommended(['gpt-5-mini', 'gpt-5-nano', 'gpt-4.1'])).toBe('gpt-4.1');
  });

  it('falls back to the hardcoded default when nothing matches', () => {
    expect(resolveOpenAIRecommended(['some-other-model'])).toBe(OPENAI_RECOMMENDED_FALLBACK);
  });

  it('falls back when no list is supplied', () => {
    expect(resolveOpenAIRecommended()).toBe(OPENAI_RECOMMENDED_FALLBACK);
  });
});

describe('resolveModel', () => {
  it('resolves "recommended" for anthropic to the curated recommended id', () => {
    expect(resolveModel('anthropic', 'recommended').id).toBe(ANTHROPIC_RECOMMENDED);
  });

  it('keeps an explicit known model id as-is', () => {
    const resolved = resolveModel('anthropic', 'claude-opus-5');
    expect(resolved.id).toBe('claude-opus-5');
    expect(resolved.fallbackNotice).toBeUndefined();
  });

  it('falls back with a notice for a deprecated/unknown saved model, never throwing', () => {
    const resolved = resolveModel('anthropic', 'claude-ancient-1');
    expect(resolved.id).toBe(ANTHROPIC_RECOMMENDED);
    expect(resolved.fallbackNotice).toMatch(/no longer available/i);
  });

  it('accepts a listed (non-curated) id for a provider like openai', () => {
    const resolved = resolveModel('openai', 'gpt-6-preview', ['gpt-6-preview']);
    expect(resolved.id).toBe('gpt-6-preview');
    expect(resolved.fallbackNotice).toBeUndefined();
  });
});
