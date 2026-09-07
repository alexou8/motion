import { describe, expect, it } from 'vitest';
import { getSupportedHosts, resolveAdapter, supportedHosts } from './registry';

describe('adapter registry', () => {
  it('resolves D2L hosts and rejects unrelated hosts', () => {
    expect(resolveAdapter('https://school.brightspace.com/d2l/home')?.id).toBe('d2l');
    expect(resolveAdapter('https://lms.example.edu/course')).toBeNull();
  });

  it('exposes supported hosts for permissions UI', () => {
    expect(getSupportedHosts()).toEqual(supportedHosts);
    expect(supportedHosts).toEqual(['*.brightspace.com', '*.desire2learn.com', 'mylearningspace.wlu.ca']);
  });
});

