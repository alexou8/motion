/**
 * Message frames exchanged over the `motion-inference` runtime port between
 * the worker (client) and the side panel (host) — ARCH D2.
 *
 * A plain object schema rather than reusing `GenerateRequest` directly: an
 * `AbortSignal` cannot cross `postMessage`, and every frame crossing an
 * extension messaging boundary should be validated rather than trusted.
 */

import { z } from 'zod';

export const inferenceMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string(),
});

export const inferenceRequestSchema = z.object({
  system: z.string(),
  messages: z.array(inferenceMessageSchema),
  maxOutputTokens: z.number().int().positive().optional(),
  model: z.string().optional(),
  json: z.boolean().optional(),
});
export type InferenceRequest = z.infer<typeof inferenceRequestSchema>;

export const clientFrameSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('generate'), requestId: z.string(), request: inferenceRequestSchema }),
  z.object({ type: z.literal('cancel'), requestId: z.string() }),
  /** Asks the panel's own `LanguageModel` whether it can run, rather than assuming a port means ready. */
  z.object({ type: z.literal('availability'), requestId: z.string() }),
]);
export type ClientFrame = z.infer<typeof clientFrameSchema>;

const availabilityStatusSchema = z.enum([
  'available',
  'downloadable',
  'downloading',
  'unavailable',
  'not-configured',
  'needs-document-context',
  'needs-permission',
  'invalid-key',
  'rate-limited',
  'insufficient-quota',
  'network-error',
  'model-unavailable',
]);

export const hostFrameSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('availability'),
    requestId: z.string(),
    status: availabilityStatusSchema,
    message: z.string(),
    retryAfterMs: z.number().int().nonnegative().optional(),
  }),
  z.object({ type: z.literal('delta'), requestId: z.string(), text: z.string() }),
  z.object({ type: z.literal('done'), requestId: z.string() }),
  z.object({ type: z.literal('error'), requestId: z.string(), kind: z.string(), message: z.string() }),
]);
export type HostFrame = z.infer<typeof hostFrameSchema>;

export const INFERENCE_PORT_NAME = 'motion-inference';
