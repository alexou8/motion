import { ASSESSMENT_PAGE_TYPES, type PageType } from '../domain';
import type { ActionType } from './actions';

/**
 * Restricted learning-support mode.
 *
 * On a page that is, or might be, a graded attempt, Motion stops being a
 * workspace and becomes a reference: it will explain concepts and show existing
 * notes, but it will not read the attempt into storage, draft anything, or take
 * any action. The rule is deliberately conservative — a false positive costs a
 * student a convenience, a false negative costs them an integrity violation.
 */
export interface AssessmentAssessment {
  restricted: boolean;
  /** Shown to the student so the restriction is explained, not just enforced. */
  reason: string;
  allowedActions: readonly ActionType[];
}

/** Actions that remain available in restricted mode. Intentionally tiny. */
const RESTRICTED_ALLOWED: readonly ActionType[] = ['read-page'];

/**
 * URL and title signals that suggest an in-progress graded attempt even when
 * the route did not match a known assessment page — institution deployments and
 * third-party quiz tools do not all use D2L's canonical paths.
 */
const ATTEMPT_URL_HINTS = [
  /\/quizzing\/user\/attempt\//i,
  /\bquiz[_-]?attempt\b/i,
  /\btake[_-]?(quiz|test|exam)\b/i,
  /\bexam\/(start|attempt|session)\b/i,
  /\bproctor/i,
];

const ATTEMPT_TEXT_HINTS =
  /\b(time remaining|attempt in progress|question \d+ of \d+|submit quiz|proctor|lockdown browser)\b/i;

export function evaluateAssessmentContext(input: {
  pageType: PageType;
  url: string;
  pageTitle?: string;
  visibleText?: string;
}): AssessmentAssessment {
  if (ASSESSMENT_PAGE_TYPES.includes(input.pageType)) {
    return {
      restricted: true,
      reason:
        'This looks like a graded attempt. Motion will not read, draft, or act here — it can only explain concepts and show notes you already made.',
      allowedActions: RESTRICTED_ALLOWED,
    };
  }

  if (ATTEMPT_URL_HINTS.some((pattern) => pattern.test(input.url))) {
    return {
      restricted: true,
      reason:
        'This page address looks like a graded attempt, so Motion is staying in learning-support mode.',
      allowedActions: RESTRICTED_ALLOWED,
    };
  }

  const haystack = `${input.pageTitle ?? ''} ${input.visibleText ?? ''}`;
  if (ATTEMPT_TEXT_HINTS.test(haystack)) {
    return {
      restricted: true,
      reason:
        'This page reads like a timed or proctored assessment, so Motion is staying in learning-support mode.',
      allowedActions: RESTRICTED_ALLOWED,
    };
  }

  return { restricted: false, reason: '', allowedActions: [] };
}
