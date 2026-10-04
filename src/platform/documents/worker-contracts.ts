import { z } from 'zod';
import { DOCUMENT_LIMITS, parsedDocumentSchema } from '@/core/documents/contracts';

export const slideWorkerRequestSchema = z
  .object({
    bytes: z
      .instanceof(Uint8Array)
      .refine((bytes) => bytes.byteLength > 0 && bytes.byteLength <= DOCUMENT_LIMITS.bytes),
  })
  .strict();

export const slideWorkerResponseSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), document: parsedDocumentSchema }).strict(),
  z.object({ ok: z.literal(false), error: z.enum(['invalid-document']) }).strict(),
]);
