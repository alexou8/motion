import { z } from 'zod';
import { DOCUMENT_LIMITS, parsedDocumentSchema } from './contracts';

export const DOCUMENT_LIBRARY_LIMIT = 100;
export const DOCUMENT_RESULT_LIMIT = 40;
const id = z.string().min(1).max(200);
const title = z.string().trim().min(1).max(500);
const url = z.string().url().max(2_000);
const format = z.enum(['pdf', 'pptx']);
const courseId = id.nullable();
const tabId = z.number().int().nonnegative();

const indexedDocumentObjectSchema = parsedDocumentSchema.innerType().extend({
  id,
  title,
  courseId,
  sourceUrl: url.nullable(),
  sourcePageUrl: url.nullable(),
  capturedAt: z.string().datetime(),
}).strict();
export const indexedDocumentSchema = indexedDocumentObjectSchema.superRefine((document, context) => {
  const parsed = parsedDocumentSchema.safeParse({ format: document.format, units: document.units,
    totalUnits: document.totalUnits, truncated: document.truncated, warnings: document.warnings });
  if (!parsed.success) for (const issue of parsed.error.issues) context.addIssue(issue);
});
export type IndexedDocument = z.infer<typeof indexedDocumentSchema>;

export const indexedDocumentSummarySchema = indexedDocumentObjectSchema.omit({ units: true }).extend({
  indexedUnitCount: z.number().int().min(0).max(DOCUMENT_LIMITS.units),
  hasText: z.boolean(),
  matches: z.array(z.object({ number: z.number().int().min(1), text: z.string().max(350) }).strict()).max(3),
}).strict();
export type IndexedDocumentSummary = z.infer<typeof indexedDocumentSummarySchema>;

export const documentSourceSchema = z.object({
  handle: z.string().uuid(),
  title,
  format,
  sourceUrl: url,
}).strict();
export const documentSourcesResponseSchema = z.object({
  sources: z.array(documentSourceSchema).max(50),
  courseId,
}).strict();
export const fetchDocumentResponseSchema = z.object({
  token: z.string().uuid(),
  title,
  format,
  base64: z.string().max(Math.ceil(DOCUMENT_LIMITS.bytes / 3) * 4),
}).strict();
export const beginDocumentImportResponseSchema = z.object({ token: z.string().uuid() }).strict();
export const documentResponseSchema = z.object({ document: indexedDocumentSchema }).strict();
export const getDocumentResponseSchema = z.object({ document: indexedDocumentSchema.nullable() }).strict();
export const documentsResponseSchema = z.object({
  documents: z.array(indexedDocumentSummarySchema).max(DOCUMENT_RESULT_LIMIT),
  total: z.number().int().min(0).max(DOCUMENT_LIBRARY_LIMIT),
  truncated: z.boolean(),
}).strict();
export const deleteDocumentResponseSchema = z.object({ deleted: z.literal(true) }).strict();

export const getDocumentSourcesSchema = z.object({ type: z.literal('get-document-sources'), tabId }).strict();
export const beginDocumentImportSchema = z.object({ type: z.literal('begin-document-import'), tabId: tabId.optional() }).strict();
export const fetchDocumentSchema = z.object({ type: z.literal('fetch-document'), tabId, handle: z.string().uuid() }).strict();
export const storeDocumentSchema = z.object({ type: z.literal('store-document'), token: z.string().uuid(), parsed: parsedDocumentSchema }).strict();
export const storeDocumentLocalSchema = z.object({
  type: z.literal('store-document-local'), title, parsed: parsedDocumentSchema,
  token: z.string().uuid(), courseId: courseId.optional(), tabId: tabId.optional(),
}).strict();
export const getDocumentsSchema = z.object({
  type: z.literal('get-documents'), query: z.string().trim().max(500).optional(), courseId: courseId.optional(),
}).strict();
export const getDocumentSchema = z.object({ type: z.literal('get-document'), id }).strict();
export const deleteDocumentSchema = z.object({ type: z.literal('delete-document'), id }).strict();
export const DOCUMENT_MESSAGE_SCHEMAS = [beginDocumentImportSchema, getDocumentSourcesSchema, fetchDocumentSchema, storeDocumentSchema,
  storeDocumentLocalSchema, getDocumentsSchema, getDocumentSchema, deleteDocumentSchema] as const;
export const documentMessageSchema = z.discriminatedUnion('type', DOCUMENT_MESSAGE_SCHEMAS);
export type DocumentMessage = z.infer<typeof documentMessageSchema>;

export function summarizeDocument(document: IndexedDocument, query = ''): IndexedDocumentSummary | null {
  const needle = query.trim().toLocaleLowerCase();
  const titleMatch = document.title.toLocaleLowerCase().includes(needle);
  const matches: IndexedDocumentSummary['matches'] = [];
  for (const unit of document.units) {
    const index = needle ? unit.text.toLocaleLowerCase().indexOf(needle) : 0;
    if (index < 0 || !unit.text.trim()) continue;
    const start = Math.max(0, index - 80);
    matches.push({ number: unit.number, text: unit.text.slice(start, start + 350) });
    if (matches.length === 3) break;
  }
  if (needle && !titleMatch && matches.length === 0) return null;
  const { units, ...metadata } = document;
  return indexedDocumentSummarySchema.parse({
    ...metadata, indexedUnitCount: units.length, hasText: units.some((unit) => unit.text.trim()), matches,
  });
}
