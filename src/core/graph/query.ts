import type { CourseLink } from './types';

/** Links honouring student overrides: a rejected link is dropped entirely. */
export function effectiveLinks(links: CourseLink[]): CourseLink[] {
  return links.filter((link) => link.userOverride?.state !== 'rejected');
}

/** Effective resources (evidence-backed pages) for a given task. */
export function resourcesForTask(links: CourseLink[], taskId: string): CourseLink[] {
  return effectiveLinks(links).filter(
    (link) => link.taskId === taskId || (link.from.kind === 'task' && link.from.id === taskId),
  );
}

/**
 * Merges freshly derived links into an existing set, upserting by stable id.
 * A student's override on an existing link is preserved across a re-derive;
 * only the confidence/provenance are refreshed from the newer observation.
 */
export function mergeCourseLinks(existing: CourseLink[], incoming: CourseLink[]): CourseLink[] {
  const byId = new Map(existing.map((link) => [link.id, link]));
  for (const link of incoming) {
    const prior = byId.get(link.id);
    byId.set(link.id, prior ? { ...link, userOverride: prior.userOverride } : link);
  }
  return [...byId.values()];
}
