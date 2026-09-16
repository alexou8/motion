import { z } from 'zod';
import type { ActionType } from '../policy';

/**
 * Motion tool surface (VISION §8, §9, §20; ARCH D7).
 *
 * The model only ever requests one of these named, typed, `.strict()` tools.
 * It never supplies a URL, a CSS selector, a script, or a raw tab id: every
 * reference below is a Motion-issued ref (`linkRef`, `tabRef`, `handle`,
 * `taskRef`, `sourceRef`, `noteRef`) that `refs.ts` builds from trusted state
 * and `guard.ts` resolves to something concrete. `.strict()` on every variant
 * means a forged extra field (`url`, `selector`, `script`, …) fails schema
 * validation instead of being silently dropped and possibly honoured later.
 */

/** A Motion-issued reference id, e.g. "L1", "T3", a task/source/note id. Bounded, opaque. */
const refString = z.string().min(1).max(100).regex(/^[A-Za-z0-9_:.-]+$/, 'not a valid ref');

/** An opaque per-snapshot element handle (never a selector). */
const handleString = z.string().min(1).max(40).regex(/^[A-Za-z0-9_-]+$/, 'not a valid handle');

const shortText = (max: number) => z.string().trim().min(1).max(max);
const boundedFillValue = z.string().max(20_000);

export const coursePageSchema = z.enum([
  'content',
  'assignments',
  'discussions',
  'quizzes',
  'grades',
  'calendar',
]);
export type CoursePage = z.infer<typeof coursePageSchema>;

export const draftKindSchema = z.enum(['outline', 'full-draft', 'section', 'discussion-reply', 'revision']);
export type ToolDraftKind = z.infer<typeof draftKindSchema>;

export const deadlineRangeSchema = z.enum(['today', 'week', 'overdue', 'all']);
export type DeadlineRange = z.infer<typeof deadlineRangeSchema>;

/* ---------------- tool variants ---------------- */

export const openAssignmentResourcesSchema = z
  .object({ tool: z.literal('open_assignment_resources'), taskRef: refString.optional() })
  .strict();

export const openCoursePageSchema = z
  .object({ tool: z.literal('open_course_page'), page: coursePageSchema })
  .strict();

export const openLinkSchema = z.object({ tool: z.literal('open_link'), linkRef: refString }).strict();

export const readPageSchema = z.object({ tool: z.literal('read_page'), tabRef: refString }).strict();

export const readAssignmentInstructionsSchema = z
  .object({ tool: z.literal('read_assignment_instructions'), tabRef: refString.optional() })
  .strict();

export const readRubricSchema = z
  .object({ tool: z.literal('read_rubric'), linkRef: refString.optional() })
  .strict();

export const buildChecklistSchema = z.object({ tool: z.literal('build_checklist') }).strict();

export const createNoteSchema = z
  .object({ tool: z.literal('create_note'), title: shortText(200), text: shortText(20_000) })
  .strict();

export const draftSchema = z
  .object({
    tool: z.literal('draft'),
    kind: draftKindSchema,
    direction: shortText(2_000).optional(),
    section: shortText(200).optional(),
  })
  .strict();

export const reviewDraftSchema = z
  .object({ tool: z.literal('review_draft'), noteRef: refString.optional() })
  .strict();

export const summarizeSourcesSchema = z.object({ tool: z.literal('summarize_sources') }).strict();

export const listDeadlinesSchema = z
  .object({ tool: z.literal('list_deadlines'), range: deadlineRangeSchema })
  .strict();

export const snapshotTabSchema = z.object({ tool: z.literal('snapshot_tab'), tabRef: refString }).strict();

export const fillFieldSchema = z
  .object({ tool: z.literal('fill_field'), tabRef: refString, handle: handleString, value: boundedFillValue })
  .strict();

export const selectOptionSchema = z
  .object({ tool: z.literal('select_option'), tabRef: refString, handle: handleString, value: boundedFillValue })
  .strict();

export const toggleControlSchema = z
  .object({ tool: z.literal('toggle_control'), tabRef: refString, handle: handleString, checked: z.boolean() })
  .strict();

export const clickSchema = z
  .object({ tool: z.literal('click'), tabRef: refString, handle: handleString })
  .strict();

export const saveDiscussionDraftSchema = z
  .object({
    tool: z.literal('save_discussion_draft'),
    tabRef: refString,
    handle: handleString,
    text: shortText(20_000),
  })
  .strict();

export const submitAssignmentSchema = z
  .object({
    tool: z.literal('submit_assignment'),
    tabRef: refString,
    handle: handleString,
    fileLabel: shortText(200).optional(),
  })
  .strict();

export const postDiscussionSchema = z
  .object({ tool: z.literal('post_discussion'), tabRef: refString, handle: handleString })
  .strict();

export const toolCallSchema = z.discriminatedUnion('tool', [
  openAssignmentResourcesSchema,
  openCoursePageSchema,
  openLinkSchema,
  readPageSchema,
  readAssignmentInstructionsSchema,
  readRubricSchema,
  buildChecklistSchema,
  createNoteSchema,
  draftSchema,
  reviewDraftSchema,
  summarizeSourcesSchema,
  listDeadlinesSchema,
  snapshotTabSchema,
  fillFieldSchema,
  selectOptionSchema,
  toggleControlSchema,
  clickSchema,
  saveDiscussionDraftSchema,
  submitAssignmentSchema,
  postDiscussionSchema,
]);
export type ToolCall = z.infer<typeof toolCallSchema>;
export type ToolName = ToolCall['tool'];

/**
 * Maps each tool to the policy action it is charged as. `click` maps to the
 * generic `click-element`; the *actual* charge for a specific click is
 * resolved later by `classifyElementConsequence` against the live element
 * descriptor (guard.ts) — a page cannot make a click cheaper than its
 * consequence just by how the model phrased the tool call.
 */
export const TOOL_ACTION: Record<ToolName, ActionType> = {
  open_assignment_resources: 'gather-material',
  open_course_page: 'navigate-owned-tab',
  open_link: 'open-tab',
  read_page: 'read-page',
  read_assignment_instructions: 'read-page',
  read_rubric: 'analyze-rubric',
  build_checklist: 'create-checklist',
  create_note: 'create-note',
  draft: 'generate-draft',
  review_draft: 'analyze-rubric',
  summarize_sources: 'summarize',
  list_deadlines: 'extract-deadlines',
  snapshot_tab: 'inspect-tab',
  fill_field: 'fill-form-field',
  select_option: 'select-option',
  toggle_control: 'toggle-control',
  click: 'click-element',
  save_discussion_draft: 'prepare-discussion-response',
  submit_assignment: 'submit-assignment',
  post_discussion: 'post-discussion',
};

export function actionForTool(tool: ToolName): ActionType {
  return TOOL_ACTION[tool];
}

/**
 * A student-readable tool catalogue for the system prompt. Deliberately in
 * plain language — this is what the model is told it may ask Motion to do,
 * never how to reach the DOM directly.
 */
export const TOOL_CATALOGUE = `
- open_assignment_resources(taskRef?): open the instructions, rubric and submission page Motion already knows about for a task.
- open_course_page(page): open a course page (content | assignments | discussions | quizzes | grades | calendar).
- open_link(linkRef): open a specific link Motion has already identified and issued a ref for.
- read_page(tabRef): read the text of a page already open in the workspace.
- read_assignment_instructions(tabRef?): read the assignment instructions.
- read_rubric(linkRef?): read a rubric.
- build_checklist(): build a checklist of requirements from what has been read so far.
- create_note(title, text): save a note in the workspace.
- draft(kind, direction?, section?): produce a local draft (outline | full-draft | section | discussion-reply | revision).
- review_draft(noteRef?): check an existing draft against the rubric/requirements.
- summarize_sources(): summarize the sources gathered so far.
- list_deadlines(range): list deadlines (today | week | overdue | all).
- snapshot_tab(tabRef): look at the interactive elements on a page before acting on it.
- fill_field(tabRef, handle, value): fill a form field (never submits anything).
- select_option(tabRef, handle, value): choose an option in a dropdown/listbox.
- toggle_control(tabRef, handle, checked): check/uncheck a checkbox or switch.
- click(tabRef, handle): click a specific element from the latest snapshot.
- save_discussion_draft(tabRef, handle, text): save a discussion reply as a draft (does not post it).
- submit_assignment(tabRef, handle, fileLabel?): submit assessed work. Always needs your fresh confirmation.
- post_discussion(tabRef, handle): post a discussion reply. Always needs your fresh confirmation.

Every reference (taskRef, linkRef, tabRef, handle, noteRef) must be one Motion already gave you. Never invent one, and never ask for a URL, selector, or script directly.
`.trim();
