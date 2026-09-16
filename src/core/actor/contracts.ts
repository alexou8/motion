import { z } from 'zod';

/**
 * Contracts for Motion's typed browser actor (VISION §8, §9, §22; ARCH D7).
 *
 * The model never supplies a selector, a URL, or a script — every request
 * references an element by an opaque `handle` drawn from a specific,
 * previously issued `snapshotId`. There is no field anywhere in this file
 * that lets a request carry arbitrary DOM-reaching data: schemas are `.strict()`
 * so a forged extra field (e.g. `selector`, `script`) fails validation rather
 * than being silently dropped and possibly honoured downstream.
 */

/** Longest a fill value may be. Generous for an essay paragraph, bounded against abuse. */
export const MAX_FILL_VALUE_LENGTH = 20_000;

/** Longest an accessible label may be once computed. */
export const MAX_LABEL_LENGTH = 200;

/** Most interactive elements a single snapshot will describe. */
export const MAX_SNAPSHOT_ELEMENTS = 150;

/* ---------------- snapshot ---------------- */

export const snapshotRequestSchema = z
  .object({
    type: z.literal('motion:snapshot'),
  })
  .strict();
export type SnapshotRequest = z.infer<typeof snapshotRequestSchema>;

export const elementRoleSchema = z.enum([
  'link',
  'button',
  'textbox',
  'combobox',
  'checkbox',
  'radio',
  'tab',
  'menuitem',
  'other',
]);
export type ElementRole = z.infer<typeof elementRoleSchema>;

export const elementDescriptorSchema = z
  .object({
    /** Opaque per-snapshot reference. Never a selector, never stable across snapshots. */
    handle: z.string().min(1),
    role: elementRoleSchema,
    tag: z.string().min(1),
    /** `input` type, when the tag is `input`. */
    type: z.string().optional(),
    /** Accessible label, bounded and computed — never raw innerHTML. */
    label: z.string().max(MAX_LABEL_LENGTH),
    name: z.string().max(MAX_LABEL_LENGTH).optional(),
    disabled: z.boolean(),
    /** Present only on elements inside a <form>, for consequence classification. */
    formMethod: z.string().optional(),
    formActionPath: z.string().optional(),
    /** Present only for links; same-origin already enforced by the actor. */
    href: z.string().url().optional(),
  })
  .strict();
export type ElementDescriptor = z.infer<typeof elementDescriptorSchema>;

export const snapshotResultSchema = z
  .object({
    snapshotId: z.string().min(1),
    url: z.string().url(),
    elements: z.array(elementDescriptorSchema).max(MAX_SNAPSHOT_ELEMENTS),
  })
  .strict();
export type SnapshotResult = z.infer<typeof snapshotResultSchema>;

/* ---------------- act ---------------- */

/**
 * Every action variant carries only `snapshotId` + `handle` (+ the minimal
 * value the action needs) — never a selector, script, url, or arbitrary
 * attribute. `.strict()` on each variant rejects a request smuggling extra
 * fields, so a forged `selector`/`script` property fails validation rather
 * than being ignored.
 */
const targetFields = {
  snapshotId: z.string().min(1),
  handle: z.string().min(1),
};

export const clickActionSchema = z
  .object({
    type: z.literal('click'),
    ...targetFields,
    /**
     * The worker sets this only after a usable fresh approval. The actor
     * additionally refuses a submit-like click without it — defense in depth,
     * not a substitute for the policy engine's classification.
     */
    confirmedConsequential: z.boolean().default(false),
  })
  .strict();

export const fillActionSchema = z
  .object({
    type: z.literal('fill'),
    ...targetFields,
    value: z.string().max(MAX_FILL_VALUE_LENGTH),
  })
  .strict();

export const selectActionSchema = z
  .object({
    type: z.literal('select'),
    ...targetFields,
    value: z.string().max(MAX_FILL_VALUE_LENGTH),
  })
  .strict();

export const toggleActionSchema = z
  .object({
    type: z.literal('toggle'),
    ...targetFields,
    checked: z.boolean(),
  })
  .strict();

export const scrollToActionSchema = z
  .object({
    type: z.literal('scrollTo'),
    ...targetFields,
  })
  .strict();

export const focusActionSchema = z
  .object({
    type: z.literal('focus'),
    ...targetFields,
  })
  .strict();

export const actRequestSchema = z.discriminatedUnion('type', [
  clickActionSchema,
  fillActionSchema,
  selectActionSchema,
  toggleActionSchema,
  scrollToActionSchema,
  focusActionSchema,
]);
export type ActRequest = z.infer<typeof actRequestSchema>;
export type ActActionType = ActRequest['type'];

/* ---------------- act result ---------------- */

export const actErrorCodeSchema = z.enum([
  'stale-snapshot',
  'unknown-handle',
  'not-connected',
  'not-visible',
  'disabled',
  'refused-input-type',
  'refused-restricted-context',
  'refused-consequential',
  'invalid-option',
  'internal-error',
]);
export type ActErrorCode = z.infer<typeof actErrorCodeSchema>;

/**
 * Evidence of what the actor actually did, returned whether the action
 * succeeded or was refused, so the worker (and the student) can see the
 * before/after state rather than trusting a bare boolean.
 */
export const actEvidenceSchema = z
  .object({
    descriptor: elementDescriptorSchema.optional(),
    before: z.string().max(MAX_FILL_VALUE_LENGTH).optional(),
    after: z.string().max(MAX_FILL_VALUE_LENGTH).optional(),
    urlAfter: z.string().url().optional(),
  })
  .strict();
export type ActEvidence = z.infer<typeof actEvidenceSchema>;

export const actResultSchema = z
  .discriminatedUnion('ok', [
    z
      .object({
        ok: z.literal(true),
        evidence: actEvidenceSchema,
      })
      .strict(),
    z
      .object({
        ok: z.literal(false),
        error: actErrorCodeSchema,
        message: z.string().max(500),
        evidence: actEvidenceSchema.optional(),
      })
      .strict(),
  ]);
export type ActResult = z.infer<typeof actResultSchema>;
