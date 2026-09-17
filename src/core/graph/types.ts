import { z } from 'zod';
import { confidenceSchema, provenanceSchema } from '../domain';

/** Course graph: persistent structured relationships between course entities (VISION §7). */

export const graphNodeKindSchema = z.enum(['course', 'task', 'page', 'external']);
export type GraphNodeKind = z.infer<typeof graphNodeKindSchema>;

export const courseLinkRelationSchema = z.enum([
  'has-assignment',
  'has-rubric',
  'has-instructions',
  'has-reading',
  'has-module',
  'has-discussion',
  'has-quiz',
  'submission-at',
  'due',
  'related',
]);
export type CourseLinkRelation = z.infer<typeof courseLinkRelationSchema>;

export const graphEndpointSchema = z.object({
  kind: graphNodeKindSchema,
  id: z.string().min(1).optional(),
  url: z.string().url().optional(),
  title: z.string().optional(),
});
export type GraphEndpoint = z.infer<typeof graphEndpointSchema>;

export const linkOverrideSchema = z.object({
  state: z.enum(['confirmed', 'rejected']),
  at: z.string().datetime(),
});
export type LinkOverride = z.infer<typeof linkOverrideSchema>;

export const courseLinkSchema = z.object({
  id: z.string().min(1),
  courseId: z.string().min(1),
  taskId: z.string().nullable().default(null),
  from: graphEndpointSchema,
  relation: courseLinkRelationSchema,
  to: graphEndpointSchema,
  confidence: confidenceSchema,
  provenance: provenanceSchema,
  userOverride: linkOverrideSchema.nullable().default(null),
});
export type CourseLink = z.infer<typeof courseLinkSchema>;
