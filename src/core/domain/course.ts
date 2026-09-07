import { z } from 'zod';
import { confidenceSchema, correctionSchema, provenanceSchema } from './provenance';

export const pageTypeSchema = z.enum([
  'dashboard',
  'course-home',
  'content-module',
  'content-topic',
  'announcements',
  'assignment-list',
  'assignment',
  'discussion-list',
  'discussion-topic',
  'quiz-list',
  'quiz-attempt',
  'grades',
  'calendar',
  'unsupported',
]);
export type PageType = z.infer<typeof pageTypeSchema>;

/**
 * Page kinds that are, or may be, a graded assessment in progress. Motion drops
 * to restricted learning-support mode on these: read-only, no drafting, no
 * automation. Kept as data next to the enum so the policy layer and the
 * adapters cannot disagree about what counts as an assessment.
 */
export const ASSESSMENT_PAGE_TYPES: readonly PageType[] = ['quiz-attempt'];

export const taskKindSchema = z.enum(['assignment', 'quiz', 'discussion', 'content', 'other']);
export type TaskKind = z.infer<typeof taskKindSchema>;

export const taskStatusSchema = z.enum(['todo', 'in-progress', 'submitted', 'graded', 'archived']);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

export const courseSchema = z.object({
  id: z.string().min(1),
  platformId: z.string().min(1),
  name: z.string().min(1),
  code: z.string().optional(),
  term: z.string().optional(),
  homeUrl: z.string().url().optional(),
  /** Platform-native course identifier (D2L calls this the org unit id). */
  externalId: z.string().optional(),
  lastVerifiedAt: z.string().datetime(),
  archived: z.boolean().default(false),
});
export type Course = z.infer<typeof courseSchema>;

/**
 * A due date as Motion understands it.
 *
 * LMS pages almost never state a timezone. Rather than silently assuming the
 * browser's zone and presenting a false precision, Motion records what evidence
 * it actually had. `zoneEvidence: 'assumed-local'` is the common case and the
 * UI marks those times as approximate.
 */
export const dueDateSchema = z.object({
  /** Absolute instant, resolved using `zoneEvidence`. Null when unparseable. */
  iso: z.string().datetime().nullable(),
  /** Exact source text, always retained even when parsing succeeds. */
  raw: z.string(),
  zoneEvidence: z.enum(['explicit', 'assumed-local', 'none']),
  /** IANA zone when the page stated one, or the zone that was assumed. */
  timeZone: z.string().optional(),
  /** True when the page gave a date but no clock time. */
  timeAssumed: z.boolean().default(false),
  confidence: confidenceSchema,
});
export type DueDate = z.infer<typeof dueDateSchema>;

export const courseTaskSchema = z.object({
  id: z.string().min(1),
  courseId: z.string().min(1),
  title: z.string().min(1),
  kind: taskKindSchema,
  due: dueDateSchema,
  status: taskStatusSchema.default('todo'),
  /** Percentage of the final grade, when the page stated one. */
  weight: z.number().min(0).max(100).nullable().default(null),
  provenance: provenanceSchema,
  /** Student corrections, newest last. The extraction itself is never mutated. */
  corrections: z.array(correctionSchema).default([]),
  /** True once the student has edited this task, so a rescan will not clobber it. */
  studentEdited: z.boolean().default(false),
  /** Manually added by the student rather than extracted. */
  manual: z.boolean().default(false),
  archived: z.boolean().default(false),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type CourseTask = z.infer<typeof courseTaskSchema>;

export const pageContentSchema = z.object({
  pageType: pageTypeSchema,
  title: z.string(),
  url: z.string().url(),
  /** Readable text with navigation chrome removed and length bounded. */
  text: z.string(),
  headings: z.array(z.string()).default([]),
  links: z.array(z.object({ href: z.string().url(), label: z.string() })).default([]),
  capturedAt: z.string().datetime(),
  /** Non-fatal problems: a partial load, a login wall, a missing region. */
  warnings: z.array(z.string()).default([]),
});
export type PageContent = z.infer<typeof pageContentSchema>;
