import { z } from 'zod';

export const DOCUMENT_LIMITS = {
  bytes: 20 * 1024 * 1024,
  units: 200,
  totalChars: 200_000,
  unitChars: 12_000,
  timeoutMs: 30_000,
} as const;

export const documentFormatSchema = z.enum(['pdf', 'pptx']);
export type DocumentFormat = z.infer<typeof documentFormatSchema>;

export const parsedDocumentSchema = z
  .object({
    format: documentFormatSchema,
    units: z
      .array(
        z
          .object({
            number: z.number().int().positive(),
            text: z.string().max(DOCUMENT_LIMITS.unitChars),
          })
          .strict(),
      )
      .min(1)
      .max(DOCUMENT_LIMITS.units),
    totalUnits: z.number().int().positive().max(1_000_000),
    truncated: z.boolean(),
    warnings: z.array(z.string().max(240)).max(10),
  })
  .strict()
  .superRefine((document, context) => {
    if (
      document.units.reduce((total, unit) => total + unit.text.length, 0) >
      DOCUMENT_LIMITS.totalChars
    ) {
      context.addIssue({ code: 'custom', message: 'Document text exceeds the indexing limit.' });
    }
    let previous = 0;
    for (const unit of document.units) {
      if (unit.number <= previous || unit.number > document.totalUnits) {
        context.addIssue({
          code: 'custom',
          message: 'Document page or slide numbers are invalid.',
        });
        break;
      }
      previous = unit.number;
    }
    if (document.units.length < document.totalUnits && !document.truncated) {
      context.addIssue({ code: 'custom', message: 'Partial documents must disclose truncation.' });
    }
  });

export type ParsedDocument = z.infer<typeof parsedDocumentSchema>;

/** Documents are untrusted data: errors never include document text or paths. */
export class DocumentParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocumentParseError';
  }
}

export function validateDocumentBytes(bytes: Uint8Array): void {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
    throw new DocumentParseError('The document is empty or unavailable.');
  }
  if (bytes.byteLength > DOCUMENT_LIMITS.bytes) {
    throw new DocumentParseError('This document exceeds the 20 MB indexing limit.');
  }
}

export function documentWarnings(document: Pick<ParsedDocument, 'units' | 'truncated'>): string[] {
  const warnings: string[] = [];
  if (document.truncated)
    warnings.push(
      'Only part of this document was indexed because it reached a size or text limit.',
    );
  const empty = document.units.filter((unit) => !unit.text.trim()).length;
  if (empty === document.units.length) {
    warnings.push(
      'No selectable text was found. Image-only or scanned pages need OCR, which Motion does not perform.',
    );
  } else if (empty > 0) {
    warnings.push(
      'Some pages or slides contain no selectable text. Image text and diagrams are not indexed.',
    );
  }
  return warnings;
}
