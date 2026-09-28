import { describe, expect, it } from 'vitest';
import { isSupportedTextModel, resolveModel, resolveOpenAIRecommended, ANTHROPIC_RECOMMENDED, OPENAI_RECOMMENDED_FALLBACK } from './models';

describe('resolveOpenAIRecommended', () => {
  it('picks the first preferred family present in the listed ids', () => {
    expect(resolveOpenAIRecommended(['gpt-6-sol', 'gpt-6-luna'])).toBe('gpt-6-luna');
  });

  it('excludes -mini and -nano variants from the recommended pick', () => {
    expect(resolveOpenAIRecommended(['gpt-5.4-mini', 'gpt-5.4-nano', 'gpt-6-sol'])).toBe('gpt-6-sol');
  });

  it('prefers an exact general-purpose id even when specialized variants come first', () => {
    expect(resolveOpenAIRecommended(['gpt-6-cyber', 'gpt-6-astra', 'gpt-6-luna', 'gpt-6-mini'])).toBe('gpt-6-luna');
  });

  it('falls back to the hardcoded default when nothing matches', () => {
    expect(resolveOpenAIRecommended(['some-other-model'])).toBe(OPENAI_RECOMMENDED_FALLBACK);
  });

  it('recognizes the documented GPT-6 Sol id when listed by the account', () => {
    expect(resolveOpenAIRecommended(['gpt-6-sol'])).toBe('gpt-6-sol');
  });

  it('uses an account-listed dated snapshot when only that preferred family is available', () => {
    expect(resolveOpenAIRecommended(['gpt-6-sol-2026-09-21'])).toBe('gpt-6-sol-2026-09-21');
  });

  it('uses a supported GPT-4.1 or GPT-4o account fallback exactly as listed', () => {
    expect(resolveOpenAIRecommended(['gpt-4.1'])).toBe('gpt-4.1');
    expect(resolveOpenAIRecommended(['gpt-4o-mini'])).toBe('gpt-4o-mini');
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
    const resolved = resolveModel('anthropic', 'claude-opus-5-5');
    expect(resolved.id).toBe('claude-opus-5-5');
    expect(resolved.fallbackNotice).toBeUndefined();
  });

  it('blocks a deprecated explicit model instead of silently changing it', () => {
    const resolved = resolveModel('anthropic', 'claude-ancient-1');
    expect(resolved.id).toBe('');
    expect(resolved.unavailable).toBe(true);
    expect(resolved.fallbackNotice).toMatch(/unavailable/i);
  });

  it('accepts a listed (non-curated) id for a provider like openai', () => {
    const resolved = resolveModel('openai', 'gpt-6-preview', ['gpt-6-preview']);
    expect(resolved.id).toBe('gpt-6-preview');
    expect(resolved.fallbackNotice).toBeUndefined();
  });

  it('blocks an unavailable explicit model when the account model list is supplied', () => {
    const resolved = resolveModel('openai', 'gpt-6-sol', ['gpt-6-luna']);
    expect(resolved.id).toBe('');
    expect(resolved.unavailable).toBe(true);
  });

  it('preserves the explicit GPT-6 Luna choice when no account list is available', () => {
    expect(resolveModel('openai', 'gpt-6-luna').id).toBe('gpt-6-luna');
  });

  it('marks a successful account listing with no supported model unavailable', () => {
    const resolved = resolveModel('openai', 'recommended', ['gpt-6-pro', 'gpt-4o-audio-preview']);
    expect(resolved.unavailable).toBe(true);
    expect(resolved.id).toBe('');
  });

  it('does not treat an account-listed but unsupported explicit model as usable', () => {
    const resolved = resolveModel('openai', 'gpt-6-pro', ['gpt-6-pro']);
    expect(resolved.unavailable).toBe(true);
    expect(resolved.id).toBe('');
  });

  it('treats an empty successful account listing differently from a failed listing', () => {
    expect(resolveModel('openai', 'recommended', []).unavailable).toBe(true);
    expect(resolveModel('openai', 'recommended').id).toBe(OPENAI_RECOMMENDED_FALLBACK);
  });
});

describe('isSupportedTextModel', () => {
  it('admits general text models and rejects modality-specific account entries', () => {
    expect(isSupportedTextModel('openai', 'gpt-6-luna')).toBe(true);
    expect(isSupportedTextModel('anthropic', 'claude-opus-5-5')).toBe(true);
    expect(isSupportedTextModel('openai', 'gpt-4o-audio-preview')).toBe(false);
    expect(isSupportedTextModel('openai', 'text-embedding-3-small')).toBe(false);
    expect(isSupportedTextModel('anthropic', 'claude-opus-5-5-vision')).toBe(false);
  });
});
