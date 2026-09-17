import { d2lAdapter } from '../adapters';
import { evaluateAssessmentContext } from '../policy';
import type { CourseLinkRelation } from '../graph';

export type DestinationProvenance = 'observed-link' | 'd2l-route';

const READABLE_PAGE_TYPES = new Set([
  'dashboard', 'course-home', 'content-module', 'content-topic', 'announcements',
  'assignment-list', 'assignment', 'discussion-list', 'discussion-topic',
  'quiz-list', 'grades', 'calendar',
]);

/**
 * Allows only a route the adapter itself classifies as a readable D2L page.
 * Assessment attempts are rejected before Chrome can request them.
 *
 * D-DEST-2 (SOL-10): `provenance`/`observedRelation` are accepted for
 * call-site bookkeeping only and never widen authority. A page can label an
 * anchor however it likes — `<a href="/d2l/logout">Rubric</a>` — and
 * `derive.ts` computes `observedRelation` from exactly that page-controlled
 * text via a regex over anchor labels. Treating a "safe" relation as
 * authorization let hostile anchor text open an unclassified same-origin
 * route (e.g. a logout link labeled "Rubric"). The only thing that can ever
 * authorize a route is the adapter's own URL classification, which depends
 * solely on the URL's path shape, not on anything a page author wrote.
 */
export function validateDestination(
  url: string,
  lmsOrigins: readonly string[],
  _provenance?: DestinationProvenance,
  _observedRelation?: CourseLinkRelation,
): { ok: true } | { ok: false; reason: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: 'destination is not a valid URL' };
  }
  const hostAllowed = lmsOrigins.some((origin) => {
    const hostPattern = origin.replace(/^https:\/\//, '');
    if (hostPattern.startsWith('*.')) return parsed.hostname.endsWith(hostPattern.slice(1));
    if (!origin.includes('://')) return parsed.hostname === hostPattern;
    try { return parsed.origin === new URL(origin).origin; } catch { return false; }
  });
  if (parsed.protocol !== 'https:' || !hostAllowed)
    return { ok: false, reason: 'destination is not an HTTPS page on this LMS' };

  const pageType = d2lAdapter.classifyUrl(parsed.toString());
  if (evaluateAssessmentContext({ pageType: pageType ?? 'unsupported', url: parsed.toString() }).restricted)
    return { ok: false, reason: 'Motion will not open a graded or timed assessment attempt' };
  if (pageType && READABLE_PAGE_TYPES.has(pageType)) return { ok: true };
  return { ok: false, reason: 'destination is not a route the adapter classifies as readable' };
}
