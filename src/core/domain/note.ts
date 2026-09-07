import { z } from 'zod';
import { provenanceSchema } from './provenance';

/**
 * Notes are built from blocks so that a single note can mix the student's own
 * writing with captured source material and generated text, while keeping the
 * origin of each part distinct. That distinction is what makes the "clearly
 * label AI-generated content" requirement enforceable rather than cosmetic.
 */
export const noteBlockOriginSchema = z.enum([
  /** Text the student selected on a page, captured verbatim. */
  'captured',
  /** Text the student wrote. */
  'student',
  /** Text produced by a model. Always rendered with a visible AI label. */
  'generated',
]);
export type NoteBlockOrigin = z.infer<typeof noteBlockOriginSchema>;

export const noteBlockSchema = z.object({
  id: z.string().min(1),
  origin: noteBlockOriginSchema,
  /** Plain text only. Motion never stores or renders HTML from a page. */
  text: z.string(),
  /** Required for captured blocks; that is the point of a source-linked note. */
  provenance: provenanceSchema.optional(),
  /** Model identifier for generated blocks, so the label can be specific. */
  generatedBy: z.string().optional(),
  createdAt: z.string().datetime(),
});
export type NoteBlock = z.infer<typeof noteBlockSchema>;

export const noteSchema = z.object({
  id: z.string().min(1),
  courseId: z.string().nullable().default(null),
  taskId: z.string().nullable().default(null),
  title: z.string().min(1),
  blocks: z.array(noteBlockSchema).default([]),
  tags: z.array(z.string()).default([]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Note = z.infer<typeof noteSchema>;

/** A requirement pulled from assignment instructions or a rubric. */
export const requirementSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  done: z.boolean().default(false),
  /** Where in the instructions this came from, so the student can check it. */
  provenance: provenanceSchema,
  /** Added by the student rather than extracted. */
  manual: z.boolean().default(false),
});
export type Requirement = z.infer<typeof requirementSchema>;

export const checklistSchema = z.object({
  id: z.string().min(1),
  courseId: z.string().min(1),
  taskId: z.string().nullable().default(null),
  title: z.string().min(1),
  items: z.array(requirementSchema).default([]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Checklist = z.infer<typeof checklistSchema>;
