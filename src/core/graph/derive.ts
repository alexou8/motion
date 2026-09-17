import type { Course, CourseTask, PageContent } from '../domain';
import { EXTRACTION_VERSION } from '../domain';
import { courseLinkSchema, type CourseLink, type CourseLinkRelation } from './types';

/**
 * Label keywords Motion recognises as evidence of a specific relation. Kept
 * deliberately generic (not D2L-specific) — D2L selectors belong only in
 * `src/core/adapters/`, never here.
 */
const LABEL_RELATIONS: readonly { pattern: RegExp; relation: CourseLinkRelation }[] = [
  { pattern: /rubric/i, relation: 'has-rubric' },
  { pattern: /instructions?/i, relation: 'has-instructions' },
  { pattern: /submit|submission/i, relation: 'submission-at' },
  { pattern: /reading/i, relation: 'has-reading' },
  { pattern: /module/i, relation: 'has-module' },
];

function stableHash(input: string): string {
  // FNV-1a: small, deterministic, no crypto dependency required in core.
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function courseLinkId(courseId: string, relation: string, toUrl: string): string {
  return `cl_${stableHash(`${courseId}|${relation}|${toUrl}`)}`;
}

/**
 * Derives course-graph links from a single observed page, using only evidence
 * actually present on that page (link labels). Never invents a relationship
 * the page did not show (VISION §7: "do not hallucinate relationships").
 */
export function deriveLinksFromPage(
  content: PageContent,
  course: Course,
  task: CourseTask | null,
  now: string,
): CourseLink[] {
  const from = task
    ? { kind: 'task' as const, id: task.id, title: task.title }
    : { kind: 'course' as const, id: course.id, title: course.name };

  const links: CourseLink[] = [];
  for (const link of content.links) {
    const matched = LABEL_RELATIONS.find(({ pattern }) => pattern.test(link.label));
    if (!matched) continue;

    const to = { kind: 'page' as const, url: link.href, title: link.label };
    links.push(
      courseLinkSchema.parse({
        id: courseLinkId(course.id, matched.relation, link.href),
        courseId: course.id,
        taskId: task?.id ?? null,
        from,
        relation: matched.relation,
        to,
        // Heuristic label match, not a confirmed structural relation.
        confidence: 'medium',
        provenance: {
          sourceUrl: content.url,
          pageTitle: content.title,
          platformId: course.platformId,
          pageType: content.pageType,
          capturedAt: content.capturedAt || now,
          extractionVersion: EXTRACTION_VERSION,
          strategy: 'link-label-heuristic',
        },
        userOverride: null,
      }),
    );
  }
  return links;
}
