import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDocumentImporter } from './documentBridge';
import { parseDocument } from '@/platform/documents/parser';
import { DOCUMENT_LIMITS } from '@/core/documents/contracts';

vi.mock('@/platform/documents/parser', () => ({ parseDocument: vi.fn() }));
const parsed = {
  format: 'pdf' as const,
  units: [{ number: 1, text: 'Synthetic lecture text' }],
  totalUnits: 1,
  truncated: false,
  warnings: [],
};
const document = {
  ...parsed,
  id: 'synthetic-document',
  title: 'Synthetic lecture.pdf',
  courseId: null,
  sourceUrl: null,
  sourcePageUrl: null,
  capturedAt: '2026-10-03T12:00:00Z',
};
const token = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const handle = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const file = (name = 'Synthetic lecture.pdf', size = 10) =>
  ({ name, size, arrayBuffer: async () => new Uint8Array([37, 80, 68, 70]).buffer }) as File;

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(parseDocument).mockResolvedValue(parsed);
});

describe('local document host boundary', () => {
  it('saves local parsed text without sending file bytes to the worker', async () => {
    const messages: unknown[] = [];
    const importer = createDocumentImporter(
      async (message) => {
        messages.push(message);
        return { ok: true, result: messages.length === 1 ? { token } : { document } };
      },
      async () => 17,
    );
    expect(await importer.importFile(file(), null)).toEqual({ ok: true, data: { document } });
    expect(messages).toEqual([
      { type: 'begin-document-import', tabId: 17 },
      {
        type: 'store-document-local',
        token,
        title: 'Synthetic lecture.pdf',
        courseId: null,
        parsed,
        tabId: 17,
      },
    ]);
  });

  it('rejects unsupported and oversized files before reading their bytes', async () => {
    const ask = vi.fn();
    const importer = createDocumentImporter(ask, async () => undefined);
    expect(await importer.importFile(file('Synthetic.ppt'), null)).toMatchObject({
      ok: false,
      message: 'Choose a PDF or PowerPoint (.pptx) file.',
    });
    expect(
      await importer.importFile(file('Synthetic.pdf', DOCUMENT_LIMITS.bytes + 1), null),
    ).toMatchObject({ ok: false, message: 'This file exceeds the 20 MB indexing limit.' });
    expect(parseDocument).not.toHaveBeenCalled();
    expect(ask).not.toHaveBeenCalled();
  });

  it('passes a worker-owned fetch token back when saving an observed LMS source', async () => {
    const messages: unknown[] = [];
    const importer = createDocumentImporter(
      async (message) => {
        messages.push(message);
        return {
          ok: true,
          result:
            messages.length === 1
              ? { token, title: 'Synthetic lecture', format: 'pdf', base64: 'JVBERg==' }
              : { document },
        };
      },
      async () => 17,
    );
    expect(await importer.indexSource(handle)).toMatchObject({ ok: true });
    expect(messages).toEqual([
      { type: 'fetch-document', tabId: 17, handle },
      { type: 'store-document', token, parsed },
    ]);
  });

  it('drops malformed fetch and storage replies', async () => {
    const importer = createDocumentImporter(
      async () => ({ ok: true, result: { token, format: 'pdf', base64: 'AA==' } }),
      async () => 17,
    );
    expect(await importer.indexSource(handle)).toMatchObject({
      ok: false,
      code: 'transport-invalid-result',
    });
    expect(parseDocument).not.toHaveBeenCalled();
    const local = createDocumentImporter(
      async (message) => ({
        ok: true,
        result:
          (message as { type: string }).type === 'begin-document-import'
            ? { token }
            : { document: { ...document, units: [] } },
      }),
      async () => 17,
    );
    expect(await local.importFile(file(), null)).toMatchObject({
      ok: false,
      code: 'transport-invalid-result',
    });
  });

  it('cancels after a download and never starts parsing or storage', async () => {
    let release!: (raw: unknown) => void;
    const ask = vi.fn(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const importer = createDocumentImporter(ask, async () => 17);
    const job = importer.indexSource(handle);
    await vi.waitFor(() => expect(ask).toHaveBeenCalledTimes(1));
    expect(await importer.importFile(file(), null)).toMatchObject({
      ok: false,
      code: 'document-busy',
    });
    importer.cancel();
    release({
      ok: true,
      result: { token, title: 'Synthetic lecture', format: 'pdf', base64: 'JVBERg==' },
    });
    expect(await job).toMatchObject({ ok: false, code: 'document-cancelled' });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(parseDocument).not.toHaveBeenCalled();
  });

  it('cancels during target lookup before starting a credentialed download', async () => {
    let resolveTab!: (tabId: number) => void;
    const ask = vi.fn();
    const importer = createDocumentImporter(
      ask,
      () =>
        new Promise((resolve) => {
          resolveTab = resolve;
        }),
    );
    const job = importer.indexSource(handle);
    importer.cancel();
    resolveTab(17);
    expect(await job).toMatchObject({ ok: false, code: 'document-cancelled' });
    expect(ask).not.toHaveBeenCalled();
    expect(parseDocument).not.toHaveBeenCalled();
    expect(importer.status()).toBeNull();
  });

  it('stops offering cancellation once committing and reports the saved index', async () => {
    let release!: (raw: unknown) => void;
    const importer = createDocumentImporter(
      async (message) =>
        (message as { type: string }).type === 'begin-document-import'
          ? { ok: true, result: { token } }
          : new Promise((resolve) => {
              release = resolve;
            }),
      async () => undefined,
    );
    const job = importer.importFile(file(), null);
    await vi.waitFor(() => expect(importer.status()).toBe('saving'));
    importer.cancel();
    release({ ok: true, result: { document } });
    expect(await job).toMatchObject({ ok: true, data: { document } });
    expect(importer.status()).toBeNull();
  });
});
