import { DOCUMENT_LIMITS } from '@/core/documents/contracts';
import {
  documentResponseSchema,
  beginDocumentImportResponseSchema,
  fetchDocumentResponseSchema,
  type IndexedDocument,
} from '@/core/documents/library';
import { parseDocument } from '@/platform/documents/parser';
import type { UiCommandResult } from './bridge';
import { toUiCommandResult } from './commandResult';

type StoredResult = UiCommandResult<{ document: IndexedDocument }>;

/** Parsing needs a document host, while the worker owns all provenance and storage. */
export function createDocumentImporter(
  ask: (message: unknown) => Promise<unknown>,
  currentTabId: () => Promise<number | undefined>,
  notify: () => void = () => {},
) {
  let pending: AbortController | null = null;
  let stage: 'reading' | 'parsing' | 'saving' | null = null;
  const setStage = (next: typeof stage) => {
    stage = next;
    notify();
  };
  const run = async (
    work: (signal: AbortSignal) => Promise<StoredResult>,
  ): Promise<StoredResult> => {
    if (pending)
      return {
        ok: false,
        code: 'document-busy',
        message: 'Wait for the current file to finish indexing.',
      };
    const controller = new AbortController();
    pending = controller;
    setStage('reading');
    try {
      return await work(controller.signal);
    } catch (error) {
      return {
        ok: false,
        code: controller.signal.aborted ? 'document-cancelled' : 'document-unreadable',
        message: controller.signal.aborted
          ? 'Indexing cancelled. The file was not saved.'
          : error instanceof Error
            ? error.message
            : 'This file could not be indexed.',
      };
    } finally {
      pending = null;
      setStage(null);
    }
  };
  const storeResult = (raw: unknown) =>
    toUiCommandResult(raw, (value) => {
      const parsed = documentResponseSchema.safeParse(value);
      return parsed.success ? parsed.data : null;
    });
  return {
    cancel: () => {
      if (stage !== 'saving') pending?.abort();
    },
    status: () => stage,
    importFile: (file: File, courseId: string | null): Promise<StoredResult> =>
      run(async (signal) => {
        if (file.size > DOCUMENT_LIMITS.bytes)
          throw new Error('This file exceeds the 20 MB indexing limit.');
        const format = /\.pdf$/i.test(file.name)
          ? 'pdf'
          : /\.pptx$/i.test(file.name)
            ? 'pptx'
            : null;
        if (!format) throw new Error('Choose a PDF or PowerPoint (.pptx) file.');
        const tabId = await currentTabId();
        signal.throwIfAborted();
        const ticket = toUiCommandResult(
          await ask({ type: 'begin-document-import', ...(tabId === undefined ? {} : { tabId }) }),
          (value) => {
            const parsed = beginDocumentImportResponseSchema.safeParse(value);
            return parsed.success ? parsed.data : null;
          },
        );
        if (!ticket.ok) return ticket;
        if (!ticket.data) throw new Error('Motion could not start the import.');
        signal.throwIfAborted();
        const bytes = new Uint8Array(await file.arrayBuffer());
        setStage('parsing');
        const parsed = await parseDocument(bytes, format, { signal });
        signal.throwIfAborted();
        setStage('saving');
        return storeResult(
          await ask({
            type: 'store-document-local',
            token: ticket.data.token,
            title: file.name.slice(0, 500),
            courseId,
            parsed,
            ...(tabId === undefined ? {} : { tabId }),
          }),
        );
      }),
    indexSource: (handle: string): Promise<StoredResult> =>
      run(async (signal) => {
        const tabId = await currentTabId();
        signal.throwIfAborted();
        if (tabId === undefined)
          return {
            ok: false,
            code: 'target-unavailable',
            message: 'Open the course page again to index this file.',
          };
        const fetched = toUiCommandResult(
          await ask({ type: 'fetch-document', tabId, handle }),
          (value) => {
            const parsed = fetchDocumentResponseSchema.safeParse(value);
            return parsed.success ? parsed.data : null;
          },
        );
        if (!fetched.ok) return fetched;
        if (!fetched.data) throw new Error('Motion did not receive the file.');
        signal.throwIfAborted();
        const binary = atob(fetched.data.base64);
        const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
        setStage('parsing');
        const parsed = await parseDocument(bytes, fetched.data.format, { signal });
        signal.throwIfAborted();
        setStage('saving');
        return storeResult(
          await ask({ type: 'store-document', token: fetched.data.token, parsed }),
        );
      }),
  };
}
