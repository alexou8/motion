import { afterEach, describe, expect, it, vi } from 'vitest';
import { KeychainFailure, NativeKeychainAdapter, type NativePort } from './keychain';

// All key strings and host responses in this file are synthetic fixtures.
function fakePort() {
  const messages = new Set<(value: unknown) => void>();
  const disconnects = new Set<(value: NativePort) => void>();
  const port = {
    onMessage: { addListener: (fn: (value: unknown) => void) => messages.add(fn), removeListener: (fn: (value: unknown) => void) => messages.delete(fn) },
    onDisconnect: { addListener: (fn: (value: NativePort) => void) => disconnects.add(fn), removeListener: (fn: (value: NativePort) => void) => disconnects.delete(fn) },
    postMessage: vi.fn((request: { operation: string }) => {
      if (request.operation === 'get') queueMicrotask(() => [...messages].forEach((fn) => fn({ version: 1, ok: true, backend: 'macos-keychain', key: 'sk-test-CANARY1234567890', present: true })));
    }),
    disconnect: vi.fn(),
    emit: (value: unknown) => [...messages].forEach((fn) => fn(value)),
    drop: () => [...disconnects].forEach((fn) => fn(port)),
  };
  return port;
}

afterEach(() => vi.unstubAllGlobals());

describe('NativeKeychainAdapter boundary', () => {
  it('rejects malformed envelopes without exposing host fields', async () => {
    const port = fakePort();
    port.postMessage.mockImplementation(() => queueMicrotask(() => port.emit({ version: 1, ok: true, backend: 'macos-keychain', key: 'sk-test-CANARY1234567890', present: true, detail: 'private host detail' })));
    const adapter = new NativeKeychainAdapter({ hasPermission: async () => true, connect: () => port, timeoutMs: 20 });
    await expect(adapter.get('openai')).rejects.toMatchObject({ name: 'KeychainFailure', message: 'The operating system keychain is unavailable.' });
  });

  it('maps host failures to a typed, non-secret error', async () => {
    const port = fakePort();
    port.postMessage.mockImplementation(() => queueMicrotask(() => port.emit({ version: 1, ok: false, code: 'vault-locked' })));
    const adapter = new NativeKeychainAdapter({ hasPermission: async () => true, connect: () => port });
    await expect(adapter.get('openai')).rejects.toBeInstanceOf(KeychainFailure);
    await expect(adapter.get('openai')).rejects.toMatchObject({ code: 'vault-locked' });
  });

  it('handles disconnect and timeout as generic unavailability and disconnects timed-out ports', async () => {
    const disconnected = fakePort();
    const first = new NativeKeychainAdapter({ hasPermission: async () => true, connect: () => disconnected, timeoutMs: 20 });
    vi.stubGlobal('chrome', { runtime: { lastError: { message: 'private detail' } } });
    disconnected.postMessage.mockImplementation(() => queueMicrotask(() => disconnected.drop()));
    const pendingDisconnect = first.get('openai');
    await expect(pendingDisconnect).rejects.toMatchObject({ message: 'The operating system keychain is unavailable.' });
    const stalled = fakePort();
    stalled.postMessage.mockImplementation(() => {});
    const second = new NativeKeychainAdapter({ hasPermission: async () => true, connect: () => stalled, timeoutMs: 5 });
    await expect(second.get('openai')).rejects.toMatchObject({ message: 'The operating system keychain is unavailable.' });
    expect(stalled.disconnect).toHaveBeenCalled();
  });

  it('does not connect to the native host without the optional permission', async () => {
    const connect = vi.fn(() => fakePort());
    const adapter = new NativeKeychainAdapter({ hasPermission: async () => false, connect });
    await expect(adapter.get('openai')).rejects.toMatchObject({ name: 'KeychainFailure' });
    expect(connect).not.toHaveBeenCalled();
  });

  it('accepts a valid key response and never includes the key in an error', async () => {
    const port = fakePort();
    const adapter = new NativeKeychainAdapter({ hasPermission: async () => true, connect: () => port });
    await expect(adapter.get('openai')).resolves.toBe('sk-test-CANARY1234567890');
  });
});
