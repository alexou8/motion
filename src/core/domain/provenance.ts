import { z } from 'zod';

/**
 * Bumped whenever extraction logic changes in a way that could alter results.
 * Stored on every extracted record so a later version can tell which rows were
 * produced by an older, possibly worse, parser and offer to re-verify them.
 */
export const EXTRACTION_VERSION = 1;

/**
 * Where a piece of information came from. Motion never shows an extracted fact
 * without being able to answer "where did you get that?", so provenance is
 * required on every extracted record rather than optional metadata.
 */
export const provenanceSchema = z.object({
  /** Canonical page URL, with query/fragment stripped of anything identifying. */
  sourceUrl: z.string().url(),
  pageTitle: z.string().default(''),
  platformId: z.string().min(1),
  /** Adapter-reported page kind at capture time. */
  pageType: z.string().min(1),
  capturedAt: z.string().datetime(),
  extractionVersion: z.number().int().nonnegative().default(EXTRACTION_VERSION),
  /** The selector or strategy that produced the value, for debugging drift. */
  strategy: z.string().optional(),
});
export type Provenance = z.infer<typeof provenanceSchema>;

/**
 * How much Motion trusts a value.
 * - `confirmed`: the student verified or entered it themselves.
 * - `high`: unambiguous parse (explicit year, explicit time).
 * - `medium`: parsed but something was inferred (e.g. the year).
 * - `low`: ambiguous format, or a heuristic fallback. Shown as needing review.
 */
export const confidenceSchema = z.enum(['confirmed', 'high', 'medium', 'low']);
export type Confidence = z.infer<typeof confidenceSchema>;

/**
 * A value the student corrected. The original extraction is never discarded —
 * keeping it makes a wrong correction recoverable and lets Motion tell whether
 * its parser or the student was right when the two disagree later.
 */
export const correctionSchema = z.object({
  field: z.string().min(1),
  originalValue: z.unknown(),
  correctedValue: z.unknown(),
  correctedAt: z.string().datetime(),
});
export type Correction = z.infer<typeof correctionSchema>;
