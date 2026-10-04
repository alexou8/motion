import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  getDocument: vi.fn(),
  create: vi.fn(),
  terminate: vi.fn(),
  destroyWorker: vi.fn(),
}));
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  getDocument: state.getDocument,
  PDFWorker: { create: state.create },
}));
vi.mock('pdfjs-dist/legacy/build/pdf.worker.mjs?worker', () => ({
  default: class {
    terminate = state.terminate;
  },
}));
import { parsePdf } from './pdf';

describe('PDF text extraction lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.create.mockReturnValue({ destroy: state.destroyWorker });
  });

  it('uses data-only decoding, no network or rendering, and cleans up the document', async () => {
    const destroy = vi.fn(async () => undefined);
    const cancel = vi.fn(async () => undefined);
    const cleanup = vi.fn();
    state.getDocument.mockReturnValue({
      destroy,
      promise: Promise.resolve({
        numPages: 1,
        getPage: async () => ({
          streamTextContent: () => ({
            getReader: () => {
              let read = false;
              return {
                read: async () =>
                  read
                    ? { done: true }
                    : ((read = true),
                      {
                        done: false,
                        value: { items: [{ str: 'Synthetic café text', hasEOL: true }] },
                      }),
                cancel,
              };
            },
          }),
          cleanup,
        }),
      }),
    });
    const result = await parsePdf(new Uint8Array([1]), () => undefined);
    expect(result.units).toEqual([{ number: 1, text: 'Synthetic café text' }]);
    const options = state.getDocument.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(options.url).toBeUndefined();
    expect(options).toMatchObject({
      disableFontFace: true,
      useSystemFonts: false,
      useWorkerFetch: false,
      useWasm: false,
      enableXfa: false,
      stopAtErrors: true,
    });
    const Factory = options.BinaryDataFactory as new () => { fetch(): Promise<never> };
    await expect(new Factory().fetch()).rejects.toThrow('resources are disabled');
    expect(cancel).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(destroy).toHaveBeenCalledOnce();
    expect(state.destroyWorker).toHaveBeenCalledOnce();
    expect(state.terminate).toHaveBeenCalledOnce();
  });

  it('terminates the actual worker when PDF setup or decoding fails', async () => {
    state.create.mockImplementationOnce(() => {
      throw new Error('Synthetic worker setup failure');
    });
    await expect(parsePdf(new Uint8Array([1]), () => undefined)).rejects.toThrow(
      'Synthetic worker setup failure',
    );
    expect(state.terminate).toHaveBeenCalledOnce();
    state.getDocument.mockImplementationOnce(() => {
      throw new Error('Synthetic setup failure');
    });
    await expect(parsePdf(new Uint8Array([1]), () => undefined)).rejects.toThrow(
      'Synthetic setup failure',
    );
    expect(state.terminate).toHaveBeenCalledTimes(2);
    const destroy = vi.fn(async () => undefined);
    state.getDocument.mockReturnValueOnce({
      destroy,
      promise: Promise.reject(new Error('Synthetic corrupt document')),
    });
    await expect(parsePdf(new Uint8Array([1]), () => undefined)).rejects.toThrow(
      'Synthetic corrupt document',
    );
    expect(destroy).toHaveBeenCalledOnce();
    expect(state.terminate).toHaveBeenCalledTimes(3);
  });
});
