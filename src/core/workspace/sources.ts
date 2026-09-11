import type { PageContent, PageType } from '@/core/domain';
import { evaluateAssessmentContext } from '@/core/policy';

/**
 * Which pages go into a prepared workspace.
 *
 * Opening a tab is not a read: it is a GET navigation made with the student's
 * session, and the links on an assignment page are written by whoever authored
 * that page. A GET can sign the student out, start a quiz attempt, or mark
 * something read. So a link is opened only when the adapter recognises its
 * route as a page that is safe to *look at*; a route it does not know is
 * refused rather than guessed at (docs/THREAT_MODEL.md T13).
 */

/** Route kinds a workspace may open. Lists, grades and quizzes are deliberately absent. */
const READABLE_PAGE_TYPES: readonly PageType[] = [
  'assignment',
  'content-topic',
  'content-module',
  'discussion-topic',
  'announcements',
];

/** The assignment plus a handful of readings: a workspace, not a tab flood. */
export const MAX_WORKSPACE_SOURCES = 6;

/** Marker Motion stamps on tabs it opens; never carried into a new workspace. */
const MOTION_MARKER = 'motion_op';

function normalise(url: URL): string {
  const copy = new URL(url.toString());
  copy.searchParams.delete(MOTION_MARKER);
  copy.hash = '';
  return copy.toString();
}

/** A URL as a workspace compares it: no fragment, no Motion marker. Null if unparseable. */
export function workspacePageUrl(raw: string): string | null {
  try {
    return normalise(new URL(raw));
  } catch {
    return null;
  }
}

function isReadable(pageType: PageType | null, url: string): boolean {
  if (!pageType || !READABLE_PAGE_TYPES.includes(pageType)) return false;
  // The route table already excludes attempts; the policy's URL hints are the
  // second opinion for an attempt served from a route that looks ordinary.
  return !evaluateAssessmentContext({ pageType, url }).restricted;
}

/**
 * @param classify the adapter's route-only page classifier
 * @returns the page itself first, then readable same-origin links, deduplicated
 */
export function selectWorkspaceSources(
  content: PageContent,
  classify: (url: string) => PageType | null,
  max = MAX_WORKSPACE_SOURCES,
): string[] {
  let page: URL;
  try {
    page = new URL(content.url);
  } catch {
    return [];
  }
  if (page.protocol !== 'https:' || max < 1) return [];
  // The page itself goes into the workspace too, so it passes the same test as
  // its links. A tab that moved on to an attempt or a sign-out between being
  // observed and being read contributes nothing — not itself, not its links.
  if (!isReadable(classify(normalise(page)), normalise(page))) return [];

  const selected = [normalise(page)];
  const seen = new Set(selected);

  for (const link of content.links) {
    if (selected.length >= max) break;

    let url: URL;
    try {
      url = new URL(link.href, page);
    } catch {
      continue; // a malformed link is the page's problem, not a reason to stop
    }
    if (url.protocol !== 'https:' || url.origin !== page.origin) continue;

    const href = normalise(url);
    if (seen.has(href)) continue;

    if (!isReadable(classify(href), href)) continue;

    seen.add(href);
    selected.push(href);
  }

  return selected;
}
