import { describe, expect, it } from 'vitest';
import { explainProviderError, explainProviderStatus } from './explain';
import type { ProviderStatus } from './types';

const ALL_STATUSES: ProviderStatus[] = [
  'available',
  'downloadable',
  'downloading',
  'unavailable',
  'not-configured',
  'needs-document-context',
  'needs-permission',
  'invalid-key',
  'rate-limited',
  'insufficient-quota',
  'network-error',
  'model-unavailable',
];

describe('explainProviderStatus', () => {
  it('produces non-empty human text for every status', () => {
    for (const status of ALL_STATUSES) {
      const message = explainProviderStatus('openai', { status, message: '' });
      expect(message.length).toBeGreaterThan(0);
      expect(message).not.toMatch(/undefined/);
    }
  });

  it('includes a retry time for rate limiting when given', () => {
    const message = explainProviderStatus('openai', { status: 'rate-limited', message: '', retryAfterMs: 24_000 });
    expect(message).toMatch(/rate limited/i);
    expect(message).toMatch(/24 seconds/);
  });

  it('tells the student to reconnect on an invalid key, matching provider naming', () => {
    expect(explainProviderStatus('anthropic', { status: 'invalid-key', message: '' })).toMatch(
      /Your Anthropic API key is no longer valid\. Reconnect\./,
    );
  });

  it('never leaks a secret-shaped string regardless of provider status', () => {
    for (const status of ALL_STATUSES) {
      const message = explainProviderStatus('openai', { status, message: '' });
      expect(message).not.toMatch(/sk-[A-Za-z0-9]{10,}/);
    }
  });
});

describe('explainProviderError', () => {
  it('warns when a chargeable request may have been processed', () => {
    expect(explainProviderError('openai', 'outcome-unknown')).toBe(
      'Motion lost contact with OpenAI; the request may have been processed and charged. Retry?',
    );
  });
});
