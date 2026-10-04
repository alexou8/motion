import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseDocument } from './parser';

const synthetic = {
  format: 'pptx' as const,
  units: [{ number: 1, text: 'Synthetic slide.' }],
  totalUnits: 1,
  truncated: false,
  warnings: [],
};

class SyntheticWorker {
  static instances: SyntheticWorker[] = [];
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminated = 0;
  bytes: Uint8Array | undefined;
  constructor() {
    SyntheticWorker.instances.push(this);
  }
  postMessage(request: { bytes: Uint8Array }) {
    this.bytes = request.bytes;
  }
  terminate() {
    this.terminated++;
  }
  reply(data: unknown) {
    this.onmessage?.({ data } as MessageEvent<unknown>);
  }
}

describe('document worker boundary and cancellation', () => {
  beforeEach(() => {
    SyntheticWorker.instances = [];
    vi.stubGlobal('Worker', SyntheticWorker);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('returns a validated result, terminates the worker and retains caller bytes', async () => {
    const bytes = new Uint8Array([1, 2]);
    const result = parseDocument(bytes, 'pptx');
    const worker = SyntheticWorker.instances[0]!;
    worker.bytes![0] = 99;
    worker.reply({ ok: true, document: synthetic });
    expect(await result).toEqual(synthetic);
    expect(bytes).toEqual(new Uint8Array([1, 2]));
    expect(worker.terminated).toBe(1);
  });

  it.each(['Chrome/116.0.0.0', 'Chromium/124.0.0.0', 'HeadlessChrome/124.0.0.0'])(
    'explains the PDF browser requirement before starting a worker: %s',
    async (userAgent) => {
      vi.stubGlobal('navigator', { userAgent });
      await expect(parseDocument(new Uint8Array([1]), 'pdf')).rejects.toThrow(
        'PDF indexing needs Chromium 125 or newer. Update your browser',
      );
      expect(SyntheticWorker.instances).toHaveLength(0);
    },
  );

  it('keeps PowerPoint indexing available on the extension minimum', async () => {
    vi.stubGlobal('navigator', { userAgent: 'Chrome/116.0.0.0' });
    const result = parseDocument(new Uint8Array([1]), 'pptx');
    const worker = SyntheticWorker.instances[0]!;
    worker.reply({ ok: true, document: synthetic });
    expect(await result).toEqual(synthetic);
    expect(worker.terminated).toBe(1);
  });

  it.each([
    { ok: true, document: { ...synthetic, totalUnits: 10 } },
    { ok: true, document: { ...synthetic, format: 'pdf' } },
    { ok: true, document: { ...synthetic, units: [{ number: 0, text: 'invalid' }] } },
    { ok: false, error: 'private course content in exception' },
    { ok: false, error: 'invalid-document' },
    { arbitrary: 'payload' },
  ])('rejects invalid or failed worker responses without exposing data: %j', async (response) => {
    const result = parseDocument(new Uint8Array([1]), 'pptx');
    const worker = SyntheticWorker.instances[0]!;
    worker.reply(response);
    await expect(result).rejects.toThrow('corrupt or uses an unsupported format');
    expect(worker.terminated).toBe(1);
  });

  it('cancels a running parse and ignores later worker results', async () => {
    const controller = new AbortController();
    const result = parseDocument(new Uint8Array([1]), 'pptx', { signal: controller.signal });
    const worker = SyntheticWorker.instances[0]!;
    controller.abort();
    worker.reply({ ok: true, document: synthetic });
    await expect(result).rejects.toThrow('cancelled');
    expect(worker.terminated).toBe(1);
  });

  it('does not start an already cancelled or oversized parse', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      parseDocument(new Uint8Array([1]), 'pptx', { signal: controller.signal }),
    ).rejects.toThrow('cancelled');
    await expect(parseDocument(new Uint8Array(20 * 1024 * 1024 + 1), 'pptx')).rejects.toThrow(
      '20 MB',
    );
    expect(SyntheticWorker.instances).toHaveLength(0);
  });

  it('terminates stalled workers after the bounded timeout', async () => {
    vi.useFakeTimers();
    const result = parseDocument(new Uint8Array([1]), 'pptx', { timeoutMs: 20 });
    const rejection = expect(result).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(20);
    await rejection;
    expect(SyntheticWorker.instances[0]?.terminated).toBe(1);
  });

  it('handles worker startup and deserialization failures', async () => {
    const startup = parseDocument(new Uint8Array([1]), 'pptx');
    SyntheticWorker.instances[0]?.onerror?.();
    await expect(startup).rejects.toThrow('could not start');
    expect(SyntheticWorker.instances[0]?.terminated).toBe(1);
    const deserialization = parseDocument(new Uint8Array([1]), 'pptx');
    SyntheticWorker.instances[1]?.onmessageerror?.();
    await expect(deserialization).rejects.toThrow('invalid response');
    expect(SyntheticWorker.instances[1]?.terminated).toBe(1);
  });
});
