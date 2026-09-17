import type { ActionType } from './actions';

/**
 * What the browser actor observed about a clickable element, immediately
 * before deciding what to charge a click as. This is deliberately a small,
 * pure-data shape: the model never supplies the classification itself (that
 * would make prompt injection a policy bypass), only the raw descriptor the
 * page exposes.
 */
export interface ElementConsequenceDescriptor {
  tag: string;
  type?: string;
  role?: string;
  label: string;
  formMethod?: string;
  formActionPath?: string;
  /** Whether the element sits inside an active graded/timed/proctored attempt. */
  inAttempt?: boolean;
}

const SEND_LIKE = /\bsend\b/i;
const INSTRUCTOR_LIKE = /\b(instructor|professor|teacher|ta)\b/i;
const POST_LIKE = /\b(post|reply)\b/i;
const UPLOAD_LIKE = /\bupload\b/i;
const SAVE_AND_CLOSE_LIKE = /\bsave\s*(and|&)\s*close\b/i;
const SAVE_DRAFT_LIKE = /\bsave\s*(a\s*)?draft\b/i;
const PUBLISH_LIKE = /\b(publish|finalize|finalise)\b/i;
const SUBMIT_LIKE = /\b(submit|finish|complete)\b/i;

/**
 * Classifies a clickable element by the action it would charge, per ARCH.md
 * D5/D7. Pure and conservative: an ambiguous submit-shaped control (a
 * `type=submit` button in a POST form with no label Motion recognises) is
 * classified as a fresh-confirmation action rather than the harmless
 * `click-element` default, because guessing wrong in the other direction lets
 * a consequential action through unconfirmed.
 */
export function classifyElementConsequence(descriptor: ElementConsequenceDescriptor): ActionType {
  if (descriptor.inAttempt) return 'act-in-graded-quiz';

  const label = descriptor.label ?? '';
  const isSubmitShaped =
    (descriptor.type ?? '').toLowerCase() === 'submit' ||
    (descriptor.formMethod ?? '').toLowerCase() === 'post';

  if (SEND_LIKE.test(label)) {
    return INSTRUCTOR_LIKE.test(label) ? 'send-message-to-instructor' : 'send-message';
  }
  if (POST_LIKE.test(label)) return 'post-discussion';
  if (UPLOAD_LIKE.test(label)) return 'upload-file';
  // D2L's "Save and Close" on a quiz/dropbox commonly finalizes the attempt or
  // submission rather than merely persisting a draft, so it is treated as
  // consequential even though "save" alone is not.
  if (SAVE_AND_CLOSE_LIKE.test(label)) return 'finalize-remote-draft';
  if (SAVE_DRAFT_LIKE.test(label)) return 'save-remote-draft';
  if (PUBLISH_LIKE.test(label)) return 'finalize-remote-draft';
  if (SUBMIT_LIKE.test(label)) return 'submit-assignment';

  if (isSubmitShaped) {
    // A submit-typed control in a POST form with no recognisable label: do
    // not assume it is harmless.
    return 'finalize-remote-draft';
  }

  const type = (descriptor.type ?? '').toLowerCase();
  const role = (descriptor.role ?? '').toLowerCase();
  const tag = (descriptor.tag ?? '').toLowerCase();

  if (type === 'checkbox' || type === 'radio' || role === 'switch' || role === 'checkbox' || role === 'radio') {
    return 'toggle-control';
  }
  if (tag === 'select' || role === 'listbox' || role === 'combobox') {
    return 'select-option';
  }

  return 'click-element';
}
