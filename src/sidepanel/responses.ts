import { z } from 'zod';
import { checklistSchema } from '@/core/domain';
import type { MotionCommand } from './bridge';

const generatedTextSchema = z.string().max(20_000);
const reasonSchema = z.string().max(1_000);

const draftReviewSchema = z.object({
  stats: z.object({
    words: z.number().int().nonnegative(),
    sentences: z.number().int().nonnegative(),
    paragraphs: z.number().int().nonnegative(),
  }),
  findings: z.array(z.object({
    requirementId: z.string().min(1),
    requirement: z.string().min(1).max(20_000),
    coverage: z.enum(['addressed', 'partial', 'no-evidence']),
    evidence: generatedTextSchema.nullable(),
    explanation: reasonSchema,
  })).max(500),
  constraintChecks: z.array(z.object({
    label: reasonSchema,
    satisfied: z.boolean().nullable(),
    detail: reasonSchema,
  })).max(500),
});

const workerResultSchemas = {
  'model-status': z.object({
    availability: z.enum(['available', 'downloadable', 'downloading', 'unavailable']),
    explanation: reasonSchema,
  }),
  'build-checklist': z.object({
    checklistId: z.string().uuid().nullable(),
    items: z.number().int().nonnegative(),
    reason: reasonSchema.optional(),
  }),
  'get-checklist': checklistSchema,
  'compose-draft': z.object({
    noteId: z.string().uuid().nullable(),
    draft: generatedTextSchema,
    label: reasonSchema,
    unsupported: z.array(reasonSchema).max(500),
    reason: reasonSchema.optional(),
  }),
  'review-draft': z.object({
    review: draftReviewSchema.nullable(),
    summary: reasonSchema,
  }),
  'prepare-workspace': z.object({
    workflowId: z.string().min(1).nullable(),
    reused: z.boolean().optional(),
    reason: reasonSchema.optional(),
  }),
  'ask-about-page': z.object({
    answer: generatedTextSchema.nullable(),
    reason: reasonSchema.optional(),
    label: reasonSchema.optional(),
  }),
  'toggle-requirement': z.object({ updated: z.boolean() }),
} satisfies Partial<Record<MotionCommand['type'], z.ZodTypeAny>>;

export function parseWorkerResult(commandType: MotionCommand['type'], raw: unknown): unknown | null {
  const schema = workerResultSchemas[commandType as keyof typeof workerResultSchemas];
  if (!schema) return null;
  const parsed = schema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
