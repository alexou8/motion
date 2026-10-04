import {
  DOCUMENT_LIMITS,
  DocumentParseError,
  documentFormatSchema,
  validateDocumentBytes,
} from '@/core/documents/contracts';
import type { DocumentFormat, ParsedDocument } from '@/core/documents/contracts';
import { slideWorkerResponseSchema } from './worker-contracts';

export interface ParseDocumentOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Local text extraction in an extension document context; never fetches a URL. */
export async function parseDocument(
  bytes: Uint8Array,
  format: DocumentFormat,
  options: ParseDocumentOptions = {},
): Promise<ParsedDocument> {
  validateDocumentBytes(bytes);
  const validatedFormat = documentFormatSchema.parse(format);
  if (options.signal?.aborted) throw new DocumentParseError('Document indexing was cancelled.');
  // PDF.js's current legacy build supports Chromium 125+, while the rest of
  // Motion remains available on the extension's Chrome 116 minimum.
  const chromiumVersion =
    typeof navigator === 'undefined'
      ? undefined
      : /(?:Chrome|Chromium)\/(\d+)/.exec(navigator.userAgent)?.[1];
  if (validatedFormat === 'pdf' && chromiumVersion !== undefined && Number(chromiumVersion) < 125) {
    throw new DocumentParseError(
      'PDF indexing needs Chromium 125 or newer. Update your browser, then try again.',
    );
  }
  const timeout = options.timeoutMs ?? DOCUMENT_LIMITS.timeoutMs;
  if (!Number.isFinite(timeout) || timeout < 1 || timeout > 60_000)
    throw new DocumentParseError('The document timeout is invalid.');
  return new Promise<ParsedDocument>((resolve, reject) => {
    let settled = false;
    let dispose = () => {};
    const finish = (document?: ParsedDocument, error?: DocumentParseError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', cancel);
      dispose();
      if (document) resolve(document);
      else reject(error ?? new DocumentParseError('This document could not be indexed.'));
    };
    const registerCleanup = (cleanup: () => void) => {
      dispose = cleanup;
      if (settled) cleanup();
    };
    const cancel = () =>
      finish(undefined, new DocumentParseError('Document indexing was cancelled.'));
    const timer = setTimeout(
      () =>
        finish(
          undefined,
          new DocumentParseError('Document indexing timed out. Try a smaller document.'),
        ),
      timeout,
    );
    options.signal?.addEventListener('abort', cancel, { once: true });
    // Copy before transferring: callers retain their original bytes on success,
    // failure and cancellation. Shared buffers never cross the parser boundary.
    const owned = new Uint8Array(bytes);
    if (validatedFormat === 'pdf') {
      void (async () => {
        try {
          const { parsePdf } = await import('./pdf');
          if (settled) return;
          finish(await parsePdf(owned, registerCleanup));
        } catch {
          finish(
            undefined,
            new DocumentParseError('This PDF is corrupt, protected, or could not be read.'),
          );
        }
      })();
      return;
    }
    try {
      const worker = new Worker(new URL('./pptx.worker.ts', import.meta.url), {
        type: 'module',
        name: 'Motion slide text',
      });
      registerCleanup(() => worker.terminate());
      worker.onmessage = (event: MessageEvent<unknown>) => {
        const result = slideWorkerResponseSchema.safeParse(event.data);
        if (!result.success || !result.data.ok || result.data.document.format !== 'pptx')
          finish(
            undefined,
            new DocumentParseError(
              'This PowerPoint file is corrupt or uses an unsupported format.',
            ),
          );
        else finish(result.data.document);
      };
      worker.onerror = () =>
        finish(undefined, new DocumentParseError('The local slide parser could not start.'));
      worker.onmessageerror = () =>
        finish(
          undefined,
          new DocumentParseError('The local slide parser returned an invalid response.'),
        );
      worker.postMessage({ bytes: owned }, [owned.buffer]);
    } catch {
      finish(undefined, new DocumentParseError('The local slide parser could not start.'));
    }
  });
}
