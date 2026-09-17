import { describe, expect, it } from 'vitest';
import { resolveModel, resolveOpenAIRecommended, ANTHROPIC_RECOMMENDED, OPENAI_RECOMMENDED_FALLBACK } from './models';

describe('resolveOpenAIRecommended', () => {
  it('picks the first preferred family present in the listed ids', () => {
    expect(resolveOpenAIRecommended(['gpt-4.1', 'gpt-5'])).toBe('gpt-5');
  });

  it('excludes -mini and -nano variants from the recommended pick', () => {
    expect(resolveOpenAIRecommended(['gpt-5-mini', 'gpt-5-nano', 'gpt-4.1'])).toBe('gpt-4.1');
  });

  it('prefers an exact general-purpose id even when specialized variants come first', () => {
    expect(resolveOpenAIRecommended(['gpt-5.6-cyber', 'gpt-5.6-pro', 'gpt-5.6-luna', 'gpt-5.6-mini'])).toBe('gpt-5.6-luna');
  });

  it('falls back to the hardcoded default when nothing matches', () => {
    expect(resolveOpenAIRecommended(['some-other-model'])).toBe(OPENAI_RECOMMENDED_FALLBACK);
  });

  it('recognizes the documented sol alias when listed by the account', () => {
    expect(resolveOpenAIRecommended(['gpt-5.6-sol'])).toBe('gpt-5.6-sol');
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

  it('does not accept an unavailable curated id when the account model list is supplied', () => {
    const resolved = resolveModel('openai', 'gpt-5.6-terra', ['gpt-4.1']);
    expect(resolved.id).toBe('gpt-4.1');
    expect(resolved.fallbackNotice).toMatch(/no longer available/i);
  });

  it('preserves the documented gpt-5.6 alias when no account list is available', () => {
    expect(resolveModel('openai', 'gpt-5.6').id).toBe('gpt-5.6');
  });

  it('marks a successful account listing with no supported model unavailable', () => {
    const resolved = resolveModel('openai', 'recommended', ['gpt-5.6-cyber', 'gpt-5.6-mini']);
    expect(resolved.unavailable).toBe(true);
    expect(resolved.id).toBe('');
  });

  it('treats an empty successful account listing differently from a failed listing', () => {
    expect(resolveModel('openai', 'recommended', []).unavailable).toBe(true);
    expect(resolveModel('openai', 'recommended').id).toBe(OPENAI_RECOMMENDED_FALLBACK);
  });
});
