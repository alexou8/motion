import { describe, expect, it } from 'vitest';
import { redactSecrets } from './redact';

const CANARY = 'sk-test-CANARY1234567890';

describe('redactSecrets', () => {
  it('removes a known secret value wherever it appears', () => {
    const out = redactSecrets(`Request failed with key ${CANARY} in header`, [CANARY]);
    expect(out).not.toContain(CANARY);
    expect(out).toContain('[redacted]');
  });

  it('removes an OpenAI-shaped key even when not passed as a known secret', () => {
    const out = redactSecrets('error: invalid key sk-abcdefghijklmno1234567890');
    expect(out).not.toContain('sk-abcdefghijklmno1234567890');
  });

  it('removes an Anthropic-shaped key', () => {
    const out = redactSecrets('bad key sk-ant-abcdefghijklmno1234567890');
    expect(out).not.toContain('sk-ant-abcdefghijklmno1234567890');
  });

  it('removes an Authorization Bearer header', () => {
    const out = redactSecrets('Authorization: Bearer abcdefghij1234567890');
    expect(out).not.toContain('abcdefghij1234567890');
  });

  it('removes an x-api-key header', () => {
    const out = redactSecrets('x-api-key: abcdefghij1234567890');
    expect(out).not.toContain('abcdefghij1234567890');
  });

  it('leaves ordinary text untouched', () => {
    expect(redactSecrets('OpenAI is rate limited.')).toBe('OpenAI is rate limited.');
  });

  it('never throws on empty or odd input', () => {
    expect(() => redactSecrets('')).not.toThrow();
    expect(() => redactSecrets('a'.repeat(5))).not.toThrow();
  });
});
