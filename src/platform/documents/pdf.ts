import { getDocument, PDFWorker } from 'pdfjs-dist/legacy/build/pdf.mjs';
import LocalPdfWorker from 'pdfjs-dist/legacy/build/pdf.worker.mjs?worker';
import {
  DOCUMENT_LIMITS,
  documentWarnings,
  parsedDocumentSchema,
} from '@/core/documents/contracts';
import type { ParsedDocument } from '@/core/documents/contracts';

// Text decoding needs PDF.js rather than rendering or sending the document to
// a server. The legacy build needs Chromium 125+; parser.ts checks this before
// loading this module. PDF.js 6
// removed eval-based font parsing; no sandbox or relaxed CSP is required.
class NoNetworkBinaryDataFactory {
  fetch(): Promise<never> {
    return Promise.reject(new Error('Optional font and image resources are disabled.'));
  }
}

export async function parsePdf(
  bytes: Uint8Array,
  registerCleanup: (cleanup: () => void) => void,
): Promise<ParsedDocument> {
  const rawWorker = new LocalPdfWorker({ name: 'Motion PDF text' });
  let worker: PDFWorker | undefined;
  let task: ReturnType<typeof getDocument> | undefined;
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    // Invoke the library's teardown as well as terminating the actual worker.
    // A corrupt document must not prevent worker termination during cleanup.
    try {
      void task?.destroy().catch(() => undefined);
      worker?.destroy();
    } finally {
      rawWorker.terminate();
    }
  };
  registerCleanup(cleanup);
  try {
    worker = PDFWorker.create({ port: rawWorker, verbosity: 0 });
    task = getDocument({
      data: bytes,
      worker,
      verbosity: 0,
      disableFontFace: true,
      useSystemFonts: false,
      useWorkerFetch: false,
      useWasm: false,
      BinaryDataFactory: NoNetworkBinaryDataFactory,
      isOffscreenCanvasSupported: false,
      isImageDecoderSupported: false,
      maxImageSize: 0,
      enableXfa: false,
      stopAtErrors: true,
      disableAutoFetch: true,
      disableRange: true,
      disableStream: true,
    });
    const document = await task.promise;
    const units: ParsedDocument['units'] = [];
    let totalChars = 0;
    let truncated = document.numPages > DOCUMENT_LIMITS.units;
    for (let number = 1; number <= Math.min(document.numPages, DOCUMENT_LIMITS.units); number++) {
      if (totalChars >= DOCUMENT_LIMITS.totalChars) {
        truncated = true;
        break;
      }
      const page = await document.getPage(number);
      const reader = page.streamTextContent({ includeMarkedContent: false }).getReader();
      const limit = Math.min(DOCUMENT_LIMITS.unitChars, DOCUMENT_LIMITS.totalChars - totalChars);
      let text = '';
      try {
        let finished = false;
        while (!finished) {
          const chunk = await reader.read();
          if (chunk.done) break;
          // PDF.js supplies validated TextContent from its own message handler.
          for (const item of chunk.value.items) {
            if (!('str' in item)) continue;
            const addition = `${text && !text.endsWith('\n') ? ' ' : ''}${item.str}${item.hasEOL ? '\n' : ''}`;
            if (text.length + addition.length > limit) {
              text += addition.slice(0, limit - text.length);
              truncated = true;
              finished = true;
              break;
            }
            text += addition;
          }
        }
      } finally {
        await reader.cancel().catch(() => undefined);
        page.cleanup();
      }
      text = text.trim();
      totalChars += text.length;
      units.push({ number, text });
    }
    const result = {
      format: 'pdf' as const,
      units,
      totalUnits: document.numPages,
      truncated,
      warnings: [] as string[],
    };
    result.warnings = documentWarnings(result);
    return parsedDocumentSchema.parse(result);
  } finally {
    cleanup();
  }
}
