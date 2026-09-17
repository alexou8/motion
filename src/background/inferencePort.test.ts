import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getInferencePort, registerInferencePort } from './inferencePort';

interface FakePort {
  name: string;
  sender?: chrome.runtime.MessageSender;
  disconnect: ReturnType<typeof vi.fn> & (() => void);
  onDisconnect: { addListener(listener: () => void): void };
}

function event<T extends (...args: never[]) => void>() {
  const listeners: T[] = [];
  return {
    addListener: vi.fn((listener: T) => listeners.push(listener)),
    emit: (...args: Parameters<T>) => listeners.forEach((listener) => listener(...args)),
  };
}

let connected: ReturnType<typeof event<(port: chrome.runtime.Port) => void>>;

beforeEach(() => {
  connected = event<(port: chrome.runtime.Port) => void>();
  vi.stubGlobal('chrome', {
    runtime: { id: 'extension-id', onConnect: connected },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

function port(sender: Partial<chrome.runtime.MessageSender>, name = 'motion-inference'): FakePort {
  const disconnected = event<() => void>();
  return {
    name,
    sender: sender as chrome.runtime.MessageSender,
    disconnect: vi.fn(() => disconnected.emit()) as ReturnType<typeof vi.fn> & (() => void),
    onDisconnect: disconnected,
  };
}

describe('inference port trust boundary', () => {
  it('accepts a trusted extension document and clears it on disconnect', () => {
    registerInferencePort();
    const candidate = port({ id: 'extension-id', url: 'chrome-extension://extension-id/sidepanel.html' });
    connected.emit(candidate as unknown as chrome.runtime.Port);
    expect(getInferencePort()).toBe(candidate);

    candidate.disconnect();
    expect(getInferencePort()).toBeNull();
  });

  it('rejects a content-script sender', () => {
    registerInferencePort();
    const candidate = port({
      id: 'extension-id',
      url: 'https://mylearningspace.wlu.ca/d2l/home/1',
      tab: { id: 7 } as chrome.tabs.Tab,
    });
    connected.emit(candidate as unknown as chrome.runtime.Port);
    expect(candidate.disconnect).toHaveBeenCalledOnce();
    expect(getInferencePort()).toBeNull();
  });

  it('rejects a tab sender even when its id and URL look trusted', () => {
    registerInferencePort();
    const candidate = port({
      id: 'extension-id',
      url: 'chrome-extension://extension-id/sidepanel.html',
      tab: { id: 7 } as chrome.tabs.Tab,
    });
    connected.emit(candidate as unknown as chrome.runtime.Port);
    expect(candidate.disconnect).toHaveBeenCalledOnce();
    expect(getInferencePort()).toBeNull();
  });

  it('ignores ports for another purpose', () => {
    registerInferencePort();
    const candidate = port({ id: 'extension-id', url: 'chrome-extension://extension-id/options.html' }, 'other');
    connected.emit(candidate as unknown as chrome.runtime.Port);
    expect(candidate.disconnect).not.toHaveBeenCalled();
    expect(getInferencePort()).toBeNull();
  });
});
