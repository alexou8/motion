import { describe, expect, it } from 'vitest';
import { createProvider } from './registry';
import { OpenAIProvider } from './openai';
import { AnthropicProvider } from './anthropic';
import { ChromeLocalProvider } from './chromeLocal';
import { WorkerChromeLocalProvider } from './chromeLocalWorker';
import type { SecretStore } from './secrets';

const secrets: SecretStore = {
  persistence: 'session',
  async get() {
    return null;
  },
  async set() {},
  async forget() {},
  async has() {
    return false;
  },
};

describe('createProvider', () => {
  it('builds each cloud provider', () => {
    expect(createProvider('openai', { secrets, chromeLocal: 'direct' })).toBeInstanceOf(OpenAIProvider);
    expect(createProvider('anthropic', { secrets, chromeLocal: 'direct' })).toBeInstanceOf(AnthropicProvider);
  });

  it('builds a direct ChromeLocalProvider in a document context', () => {
    expect(createProvider('chrome-local', { secrets, chromeLocal: 'direct' })).toBeInstanceOf(ChromeLocalProvider);
  });

  it('builds the worker composite when given a port getter', () => {
    expect(createProvider('chrome-local', { secrets, chromeLocal: () => null })).toBeInstanceOf(WorkerChromeLocalProvider);
  });
});
