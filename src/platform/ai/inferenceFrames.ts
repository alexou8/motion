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
]);
export type ClientFrame = z.infer<typeof clientFrameSchema>;

export const hostFrameSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('delta'), requestId: z.string(), text: z.string() }),
  z.object({ type: z.literal('done'), requestId: z.string() }),
  z.object({ type: z.literal('error'), requestId: z.string(), kind: z.string(), message: z.string() }),
]);
export type HostFrame = z.infer<typeof hostFrameSchema>;

export const INFERENCE_PORT_NAME = 'motion-inference';
