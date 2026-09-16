import type { PageContent } from '@/core/domain';
import { courseIdFromUrl } from './dom';

/**
 * D2L semantic actions (VISION §9, ARCH D7).
 *
 * Pure functions over already-extracted `PageContent`/links and the source
 * URL — no DOM, no network, nothing here reaches into a live page. Where
 * Motion understands D2L's own route shapes it resolves a rubric, submission
 * page, or course-section URL directly instead of asking a model to click
 * around for it. Every URL returned is same-origin https relative to the
 * page it was found on: a page cannot smuggle a link to another site into
 * what Motion treats as "the rubric".
 */

export interface AssignmentResourceLink {
  readonly url: string;
  readonly label: string;
  /** How this link was identified, so a wrong guess is debuggable. */
  readonly provenance: string;
}

export interface AssignmentResources {
  readonly instructionsUrl?: AssignmentResourceLink;
  readonly rubricUrl?: AssignmentResourceLink;
  readonly submissionUrl?: AssignmentResourceLink;
  readonly relatedReadings: AssignmentResourceLink[];
}

export interface CourseNav {
  readonly contentUrl: string;
  readonly assignmentsUrl: string;
  readonly discussionsUrl: string;
  readonly quizzesUrl: string;
  readonly gradesUrl: string;
  readonly calendarUrl: string;
}

const RUBRIC_PATTERN = /\brubric\b/i;
const SUBMISSION_PATTERN = /\b(submit|submission|dropbox|upload)\b/i;
const INSTRUCTIONS_PATTERN = /\b(instructions?|assignment details|guidelines)\b/i;

/**
 * Same origin and https, checked against the page the link was found on —
 * not against some other trusted list. A link into a different site, even a
 * plausible-looking one, is never treated as a resource for this assignment.
 */
function sameOriginHttpsLink(href: string, sourceUrl: string): URL | null {
  try {
    const source = new URL(sourceUrl);
    const target = new URL(href, sourceUrl);
    if (target.protocol !== 'https:') return null;
    if (target.origin !== source.origin) return null;
    return target;
  } catch {
    return null;
  }
}

/**
 * Resource links referenced from an assignment page: the rubric, the
 * submission (dropbox) page, and — when the current page itself reads as
 * instructions — the instructions link, plus anything else the page links to
 * as further reading. Classification is by link label only; nothing here
 * executes or is derived from page text beyond that label.
 */
export function resolveAssignmentResources(content: PageContent): AssignmentResources {
  const relatedReadings: AssignmentResourceLink[] = [];
  let instructionsUrl: AssignmentResourceLink | undefined;
  let rubricUrl: AssignmentResourceLink | undefined;
  let submissionUrl: AssignmentResourceLink | undefined;

  if (content.pageType === 'assignment') {
    instructionsUrl = { url: content.url, label: content.title, provenance: 'the current assignment page' };
  }

  for (const link of content.links) {
    const target = sameOriginHttpsLink(link.href, content.url);
    if (!target) continue;
    const resolved = target.toString();
    const label = link.label;

    if (!rubricUrl && RUBRIC_PATTERN.test(label)) {
      rubricUrl = { url: resolved, label, provenance: `link labelled "${label}"` };
      continue;
    }
    if (!submissionUrl && SUBMISSION_PATTERN.test(label)) {
      submissionUrl = { url: resolved, label, provenance: `link labelled "${label}"` };
      continue;
    }
    if (!instructionsUrl && INSTRUCTIONS_PATTERN.test(label)) {
      instructionsUrl = { url: resolved, label, provenance: `link labelled "${label}"` };
      continue;
    }
    if (/\/d2l\/le\/content\//i.test(resolved)) {
      relatedReadings.push({ url: resolved, label, provenance: `content link labelled "${label}"` });
    }
  }

  return { instructionsUrl, rubricUrl, submissionUrl, relatedReadings };
}

/**
 * A course-section navigation, built entirely from D2L's known route shapes
 * (`d2l.ts`'s `ROUTES`) plus an org-unit id — resolved from the URL, or,
 * failing that, from any `ou=`-carrying link on the page. Returns `null` when
 * no org-unit id can be established: guessing at a course id would put a
 * student's assignments link into someone else's course.
 */
export function resolveCourseNav(url: string, content: PageContent): CourseNav | null {
  const source = safeHttpsUrl(url);
  if (!source) return null;

  const orgUnitId = courseIdFromUrl(url) ?? orgUnitIdFromLinks(content, source);
  if (!orgUnitId) return null;

  const origin = source.origin;
  return {
    contentUrl: `${origin}/d2l/le/content/${orgUnitId}/home`,
    assignmentsUrl: `${origin}/d2l/lms/dropbox/user/folders_list.d2l?ou=${orgUnitId}`,
    discussionsUrl: `${origin}/d2l/le/${orgUnitId}/discussions/List`,
    quizzesUrl: `${origin}/d2l/lms/quizzing/user/quizzes_list.d2l?ou=${orgUnitId}`,
    gradesUrl: `${origin}/d2l/lms/grades/${orgUnitId}`,
    calendarUrl: `${origin}/d2l/le/calendar/${orgUnitId}`,
  };
}

function safeHttpsUrl(url: string): URL | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' ? parsed : null;
  } catch {
    return null;
  }
}

function orgUnitIdFromLinks(content: PageContent, source: URL): string | null {
  for (const link of content.links) {
    const target = sameOriginHttpsLink(link.href, source.toString());
    if (!target) continue;
    const resolved = target.toString();
    const ou = target.searchParams.get('ou');
    if (ou && /^\d+$/.test(ou)) return ou;
    const pathId = courseIdFromUrl(resolved);
    if (pathId) return pathId;
  }
  return null;
}
