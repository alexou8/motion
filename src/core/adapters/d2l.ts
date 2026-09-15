import {
  ASSESSMENT_PAGE_TYPES,
  EXTRACTION_VERSION,
  type Course,
  type CourseTask,
  type PageContent,
  type PageType,
  type TaskKind,
  type TaskStatus,
} from '@/core/domain';
import type { ActionType } from '@/core/policy';
import { parseDueDate } from '@/core/parse/dueDate';
import {
  absoluteUrl,
  allMatches,
  canonicalUrl,
  courseIdFromUrl,
  extractWeight,
  firstMatch,
  normalizedText,
  readablePageText,
} from './dom';
import type { AdapterInput, LearningPlatformAdapter, PageDetection } from './types';

const HOST_PATTERNS: readonly RegExp[] = [
  /(^|\.)brightspace\.com$/i,
  /(^|\.)desire2learn\.com$/i,
  /^mylearningspace\.wlu\.ca$/i,
];

const ROUTES: readonly { pattern: RegExp; pageType: PageType }[] = [
  { pattern: /^\/d2l\/home\/?$/i, pageType: 'dashboard' },
  { pattern: /^\/d2l\/home\/\d+\/?$/i, pageType: 'course-home' },
  // The legacy org-unit home is still what several course-navbar links point at.
  { pattern: /^\/d2l\/lp\/ouHome\/home(?:\.d2l)?\/?$/i, pageType: 'course-home' },
  { pattern: /^\/d2l\/le\/content\/[^/]+\/home\/?$/i, pageType: 'content-module' },
  { pattern: /^\/d2l\/le\/content\/[^/]+\/viewContent\//i, pageType: 'content-topic' },
  { pattern: /^\/d2l\/le\/content\/[^/]+\/navigateContent\//i, pageType: 'content-topic' },
  { pattern: /^\/d2l\/le\/news(?:\/|$)/i, pageType: 'announcements' },
  { pattern: /^\/d2l\/lms\/news\/main(?:\.d2l)?\/?$/i, pageType: 'announcements' },
  { pattern: /^\/d2l\/lms\/dropbox\/user\/folders_list(?:\.d2l)?\/?$/i, pageType: 'assignment-list' },
  { pattern: /^\/d2l\/lms\/dropbox\/user\/folder_submit_files(?:\/|\.|$)/i, pageType: 'assignment' },
  // Opening a submitted assignment for feedback lands here, not on the submit page.
  { pattern: /^\/d2l\/lms\/dropbox\/user\/folder_user_view_src(?:\/|\.|$)/i, pageType: 'assignment' },
  { pattern: /^\/d2l\/le\/[^/]+\/discussions\/List(?:\/|$)/i, pageType: 'discussion-list' },
  { pattern: /^\/d2l\/le\/[^/]+\/discussions\/topics\//i, pageType: 'discussion-topic' },
  { pattern: /^\/d2l\/lms\/quizzing\/user\/quizzes_list(?:\.d2l)?\/?$/i, pageType: 'quiz-list' },
  // The pre-attempt summary is metadata about a quiz, not an attempt: it stays
  // outside ASSESSMENT_PAGE_TYPES so Motion may read it, and the attempt route
  // below is the only quizzing route that trips restricted mode.
  { pattern: /^\/d2l\/lms\/quizzing\/user\/quiz_summary(?:\.d2l)?\/?$/i, pageType: 'quiz-list' },
  { pattern: /^\/d2l\/lms\/quizzing\/user\/attempt\//i, pageType: 'quiz-attempt' },
  { pattern: /^\/d2l\/lms\/grades(?:\/|$)/i, pageType: 'grades' },
  { pattern: /^\/d2l\/le\/calendar(?:\/|$)/i, pageType: 'calendar' },
  { pattern: /^\/d2l\/login(?:\/|$)/i, pageType: 'signed-out' },
  { pattern: /^\/d2l\/lp\/auth\/(?:login|saml)(?:\/|$)/i, pageType: 'signed-out' },
];

/**
 * A signed-out D2L serves the requested route as a near-empty document whose
 * only content is a script redirecting to `/d2l/login`. Detected from the
 * document rather than the URL, because the URL is still the course page the
 * student asked for: reporting that as a dashboard, at high confidence, with an
 * empty body behind it, is how a stale panel starts.
 */
function looksSignedOut(document: Document): boolean {
  const body = document.body;
  if (!body) return false;

  // A login wall served *at* the course URL: the route still says course home,
  // but what is on screen is a password prompt. A page asking for a password is
  // never a page to read coursework from, whatever its URL claims.
  if (body.querySelector('input[type="password" i]')) return true;

  const visibleBody = body.cloneNode(true) as Element;
  for (const element of visibleBody.querySelectorAll('script, noscript, template, style')) element.remove();
  if (normalizedText(visibleBody)) return false;
  // A page that has rendered nothing *yet* still has its elements: D2L ships
  // session-expiry redirect scripts on ordinary pages, so the script alone
  // proves nothing. The stub has no body content at all.
  const hasContentElements = Array.from(body.children).some(
    (child) => !['SCRIPT', 'NOSCRIPT', 'TEMPLATE', 'STYLE'].includes(child.tagName),
  );
  if (hasContentElements) return false;
  const scripts = Array.from(document.querySelectorAll('head script, body script'))
    .map((script) => script.textContent ?? '')
    .join(' ');
  return /location\.(?:replace|href)\s*[(=]\s*['"][^'"]*\/d2l\/login/i.test(scripts);
}

const DOCUMENTED_ROW_SELECTORS = [
  '.d2l-datalist-item',
  '.d2l-le-listitem',
  '.d2l-table tr',
  '.d2l-grid tr',
  '.d2l-textblock',
  '.d2l-dates-text',
  'd2l-link',
] as const;

const SEMANTIC_ROW_SELECTORS = ['table tr'] as const;

/**
 * Page chrome: regions that hold navigation rather than coursework. A course
 * navbar links to the assignments, quizzes and discussions *lists*, so reading
 * it as coursework produced tasks called "Assignments" and "Quizzes" that exist
 * on no due-date list. Candidates inside these regions are dropped entirely.
 *
 * Deliberately not `header` or `footer` as bare tags: `closest` walks to the
 * root, and a list row may title itself with its own `<header>`. Matching those
 * would drop a real, due-dated assignment silently. Page chrome identifies
 * itself with a role or a D2L navigation class.
 */
const NAVIGATION_REGION_SELECTOR =
  'nav, [role="navigation"], [role="banner"], [role="contentinfo"], .d2l-navigation, .d2l-navigation-header, d2l-navigation, d2l-navigation-main-header, d2l-labs-navigation, d2l-labs-navigation-main-header, d2l-labs-navigation-main-footer, d2l-labs-navigation-band, .d2l-breadcrumbs, .d2l-menu';

/**
 * Routes that are a place to look rather than a thing to do. A link to a list
 * page is navigation even when it appears in the body of a page.
 */
const NAVIGATION_HREF_PATTERNS: readonly RegExp[] = [
  /\/d2l\/lms\/dropbox\/user\/folders_list(?:\.d2l)?(?:[/?#]|$)/i,
  /\/d2l\/lms\/quizzing\/user\/quizzes_list(?:\.d2l)?(?:[/?#]|$)/i,
  /\/d2l\/le\/[^/]+\/discussions\/List(?:[/?#]|$)/i,
  /\/d2l\/le\/content\/[^/]+\/home(?:[/?#]|$)/i,
  /\/d2l\/lms\/grades(?:[/?#]|$)/i,
  /\/d2l\/le\/calendar(?:\/\d+)?(?:[?#]|$)/i,
  /\/d2l\/home(?:\/\d+)?(?:[/?#]|$)/i,
];

function isNavigationHref(href: string | null): boolean {
  return href !== null && NAVIGATION_HREF_PATTERNS.some((pattern) => pattern.test(href));
}

/**
 * Links that describe a row without naming it.
 *
 * A D2L list row carries more than one link to the same piece of work: the
 * submission history ("1 Submission, 1 File"), the feedback view, and — on a
 * discussion list — an "Unread for topic ..." counter that differs from the
 * topic's own link only by a `filters=unread` query. Taking whichever link came
 * first in the DOM named assignments after their submission count, and turned
 * every discussion topic into two tasks. These never supply a title, and never
 * stand in for the row's own link.
 */
const SECONDARY_LINK_PATTERNS: readonly RegExp[] = [
  /\/d2l\/lms\/dropbox\/user\/folders_history(?:\.d2l)?(?:[/?#]|$)/i,
  /\/d2l\/lms\/dropbox\/user\/folder_user_view_feedback(?:\.d2l)?(?:[/?#]|$)/i,
  /[?&]filters=unread\b/i,
  /\/d2l\/le\/userprogress\//i,
];

function isSecondaryHref(href: string | null): boolean {
  return href !== null && SECONDARY_LINK_PATTERNS.some((pattern) => pattern.test(href));
}

/**
 * Where a row states its own name, most specific first.
 *
 * D2L puts the name in a dedicated container and the dates, counts and grades
 * in siblings. Reading the container rather than the first anchor is what keeps
 * a *closed* assignment — whose name is a plain label because there is nothing
 * left to submit — from being titled after the only link left on the row.
 */
const TASK_NAME_SELECTORS = [
  '.d2l-foldername-medium-font',
  '.d_ich',
  '.d2l-linkheading-link',
  '.d2l-le-listitem-name',
] as const;

/**
 * The name held by a row's name container, without the dates D2L nests inside
 * it. Prefers the container's own link or label over its full text, so a
 * wrapper that also holds a due date cannot smuggle the date into the title.
 */
function nameText(container: Element): string {
  const link = Array.from(container.querySelectorAll<HTMLAnchorElement>('a[href]')).find(
    (candidate) => !isSecondaryHref(candidate.getAttribute('href')),
  );
  const linkText = normalizedText(link ?? null);
  if (linkText) return linkText;

  const label = container.querySelector('label');
  const labelText = normalizedText(label);
  if (labelText) return labelText;

  const copy = container.cloneNode(true) as Element;
  for (const dates of copy.querySelectorAll('.d2l-dates-text, .d2l-folderdates-wrapper')) dates.remove();
  return normalizedText(copy);
}

/** The row's own link: the first that is not one of the secondary links above. */
function primaryAnchor(row: Element): HTMLAnchorElement | null {
  const anchors = Array.from(row.querySelectorAll<HTMLAnchorElement>('a[href]'));
  return (
    anchors.find((candidate) => !isSecondaryHref(candidate.getAttribute('href'))) ?? anchors[0] ?? null
  );
}

function inNavigationRegion(element: Element): boolean {
  return element.closest(NAVIGATION_REGION_SELECTOR) !== null;
}

const READ_ACTIONS: readonly ActionType[] = ['read-page', 'extract-deadlines', 'extract-requirements'];
const ASSESSMENT_READ_ACTIONS: readonly ActionType[] = ['read-page'];

type RouteTask = {
  readonly kind: TaskKind;
  readonly strategy: string;
};

type TaskCandidate = {
  readonly row: Element;
  readonly anchor: HTMLAnchorElement | null;
  readonly href: string | null;
  readonly route: RouteTask | null;
  readonly strategy: string;
};

const TASK_ID_QUERY_ALIASES = new Map<string, string>([
  ['ou', 'ou'],
  ['orgunitid', 'ou'],
  ['db', 'db'],
  ['qi', 'qi'],
  ['tid', 'topicId'],
  ['topic', 'topicId'],
  ['topicid', 'topicId'],
  ['fid', 'forumId'],
  ['forum', 'forumId'],
  ['forumid', 'forumId'],
]);

const TASK_ROUTE_PATTERNS: readonly { pattern: RegExp; route: RouteTask }[] = [
  {
    pattern: /\/d2l\/lms\/dropbox\/user\/(?:folder_submit_files|folder_user_view_src)(?:\.d2l)?(?:[/?]|$)/i,
    route: { kind: 'assignment', strategy: 'route:assignment' },
  },
  {
    pattern: /(?:\/d2l\/lms\/quizzing\/user\/quiz_summary(?:\.d2l)?(?:[/?]|$)|\/quizzing\/user\/attempt\/)/i,
    route: { kind: 'quiz', strategy: 'route:quiz' },
  },
  {
    pattern: /\/discussions\/topics\//i,
    route: { kind: 'discussion', strategy: 'route:discussion' },
  },
  {
    pattern: /\/viewContent\//i,
    route: { kind: 'content', strategy: 'route:content' },
  },
];

function pathnameOf(url: string): string | null {
  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
}

function safeTaskHref(rawHref: string, baseUrl: string): string | null {
  const href = rawHref.trim();
  if (!href || href.startsWith('#')) return null;
  const absolute = absoluteUrl(href, baseUrl);
  if (!absolute) return null;
  try {
    const parsed = new URL(absolute);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function canonicalTaskIdentity(href: string, courseId: string): string | null {
  try {
    const parsed = new URL(href);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    const params = Array.from(parsed.searchParams.entries())
      .flatMap(([key, value]) => {
        const canonicalKey = TASK_ID_QUERY_ALIASES.get(key.toLowerCase());
        return canonicalKey && value.trim() ? [[canonicalKey, value.trim()] as const] : [];
      })
      .sort(([leftKey, leftValue], [rightKey, rightValue]) => leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue));
    if (!params.some(([key]) => key === 'ou')) params.push(['ou', courseId]);
    params.sort(([leftKey, leftValue], [rightKey, rightValue]) => leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue));
    const search = params.length > 0
      ? `?${params.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&')}`
      : '';
    return `${parsed.origin}${parsed.pathname}${search}`;
  } catch {
    return null;
  }
}

function quizIdFromAnchor(anchor: HTMLAnchorElement): string | null {
  const handler = anchor.getAttribute('onclick') ?? '';
  return handler.match(/\bGoToQuiz\s*\(\s*(\d+)\b/i)?.[1] ?? null;
}

function quizRouteForAnchor(anchor: HTMLAnchorElement, input: AdapterInput, pageType: PageType): RouteTask | null {
  if (pageType !== 'quiz-list' || safeTaskHref(anchor.getAttribute('href') ?? '', input.url)) return null;
  return quizIdFromAnchor(anchor) ? { kind: 'quiz', strategy: 'quiz-list GoToQuiz id' } : null;
}

function queryValue(url: string, names: readonly string[]): string | null {
  try {
    // D2L emits `ou` on modern routes and `OU` on some legacy ones, so the
    // lookup is case-insensitive rather than trusting one spelling.
    const params = new URL(url).searchParams;
    const wanted = names.map((name) => name.toLowerCase());
    for (const wantedName of wanted) {
      for (const [key, value] of params) {
        if (key.toLowerCase() !== wantedName) continue;
        const trimmed = value.trim();
        if (trimmed) return trimmed;
      }
    }
  } catch {
    return null;
  }
  return null;
}

function pageTitle(document: Document): string {
  return normalizedText(firstMatch(document, ['.d2l-page-title', 'h1'])) || document.title.trim() || 'D2L page';
}

const COURSE_CODE_PATTERN = /\b[A-Za-z]{2,}[A-Za-z0-9-]*\d[A-Za-z0-9-]*\b/;

/**
 * The document title's segments, with the page's own segment removed.
 *
 * D2L titles a page "<what this page is> - <course code> - <course name>", so
 * the first segment names the page, not the course. Some course-home pages use
 * the course name as their heading, which means the heading match is not the
 * page segment and cannot be used as the removal rule.
 */
function titleSegments(document: Document): string[] {
  const heading = normalizedText(firstMatch(document, ['.d2l-page-title', 'h1'])).toLowerCase();
  const segments = document.title
    .split(/\s+-\s+|\s+\|\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  const headingIndex = segments.findIndex((part) => part.toLowerCase() === heading);
  return headingIndex > 0
    ? segments.slice(1)
    : segments.filter((part) => part.toLowerCase() !== heading);
}

/**
 * The course this page belongs to, as a name and a code.
 *
 * Element lookups come first, because a stock Brightspace skin states the
 * course in its navigation. This deliberately does *not* fall back to
 * `.d2l-page-title` or `h1`: on MyLearningSpace those hold the name of the
 * page, and accepting them meant every visit overwrote the stored course with
 * the title of whatever page had just been read.
 */
function courseIdentity(document: Document): { name: string; code: string | null } {
  const namedElement = firstMatch(document, [
    '.d2l-navigation-s-course-name',
    'd2l-navigation-link-text',
    '[class*="course-name"]',
  ]);
  const visibleName = normalizedText(namedElement);
  if (visibleName) return { name: visibleName, code: courseCodeFromName(visibleName) };

  const segments = titleSegments(document);
  const codeIndex = segments.findIndex((part) => part.length <= 40 && COURSE_CODE_PATTERN.test(part));
  if (codeIndex === -1) return { name: segments[0] ?? '', code: null };

  const codeSegment = segments[codeIndex] ?? '';
  const code = codeSegment.match(COURSE_CODE_PATTERN)?.[0] ?? null;
  // "CS101 Example Course" names the course and carries its code; a bare
  // "CS-101-A" does not, and the segment after it is the course's name.
  const following = segments[codeIndex + 1];
  const name = codeSegment === code && following ? following : codeSegment;
  return { name, code };
}

function courseCodeFromName(name: string): string | null {
  return name.match(COURSE_CODE_PATTERN)?.[0] ?? null;
}

function termFromName(name: string): string | null {
  return name.match(/\b(?:Fall|Winter|Spring|Summer)\s+\d{4}\b/i)?.[0] ?? null;
}

function pageTypeFromTaskHref(href: string): RouteTask | null {
  return TASK_ROUTE_PATTERNS.find((candidate) => candidate.pattern.test(href))?.route ?? null;
}

function meaningfulAncestor(element: Element): Element {
  return element.closest('tr, li, .d2l-datalist-item, .d2l-le-listitem, [role="listitem"]') ?? element.parentElement ?? element;
}

function routeAnchorCandidate(anchor: HTMLAnchorElement, input: AdapterInput, pageType: PageType): TaskCandidate | null {
  const raw = anchor.getAttribute('href') ?? '';
  // A secondary link points at the same work as the row's own link. Letting it
  // start a candidate is what produced the duplicate "Unread for topic ..." task.
  if (isSecondaryHref(raw)) return null;
  const href = safeTaskHref(raw, input.url);
  const quizRoute = quizRouteForAnchor(anchor, input, pageType);
  if (!href && !quizRoute) return null;
  if (href && isSecondaryHref(href)) return null;
  const route = href ? pageTypeFromTaskHref(href) : null;
  if (!route && !quizRoute) return null;
  const resolvedRoute = route ?? quizRoute;
  return { row: meaningfulAncestor(anchor), anchor, href, route: resolvedRoute, strategy: resolvedRoute?.strategy ?? 'route link' };
}

function rowCandidate(row: Element, input: AdapterInput, pageType: PageType, strategy: string): TaskCandidate {
  const anchor = primaryAnchor(row);
  const href = anchor ? safeTaskHref(anchor.getAttribute('href') ?? '', input.url) : null;
  const route = href ? pageTypeFromTaskHref(href) : null;
  const quizRoute = anchor ? quizRouteForAnchor(anchor, input, pageType) : null;
  return { row, anchor, href, route: route ?? quizRoute, strategy: route?.strategy ?? quizRoute?.strategy ?? strategy };
}

function documentedCandidate(element: Element, input: AdapterInput, pageType: PageType): TaskCandidate {
  return rowCandidate(meaningfulAncestor(element), input, pageType, 'documented D2L class convention');
}

function semanticCandidate(element: Element, input: AdapterInput, pageType: PageType): TaskCandidate {
  return rowCandidate(element, input, pageType, 'semantic table row');
}

function isCoursework(candidate: TaskCandidate): boolean {
  if (isNavigationHref(candidate.href)) return false;
  if (inNavigationRegion(candidate.row)) return false;
  if (candidate.anchor && inNavigationRegion(candidate.anchor)) return false;
  return true;
}

/**
 * Whether `next` describes a row better than the candidate already held for it.
 *
 * A candidate that recognised the row's route knows what kind of work it is, so
 * it wins over one that only matched a class convention.
 */
function isBetterCandidate(next: TaskCandidate, current: TaskCandidate): boolean {
  if ((next.route !== null) !== (current.route !== null)) return next.route !== null;
  return next.href !== null && current.href === null;
}

/**
 * The rows on this page that might be coursework — at most one candidate each.
 *
 * A row is the unit, not a link. D2L puts several links to the same work on one
 * row, and treating each as its own candidate produced a second task per
 * discussion topic and titled closed assignments after their submission count.
 */
function taskCandidates(document: Document, input: AdapterInput, pageType: PageType): TaskCandidate[] {
  const byRow = new Map<Element, TaskCandidate>();
  const consider = (candidate: TaskCandidate | null): void => {
    if (!candidate) return;
    const current = byRow.get(candidate.row);
    if (!current || isBetterCandidate(candidate, current)) byRow.set(candidate.row, candidate);
  };

  for (const anchor of document.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    consider(routeAnchorCandidate(anchor, input, pageType));
  }
  for (const element of allMatches(document, DOCUMENTED_ROW_SELECTORS)) consider(documentedCandidate(element, input, pageType));
  for (const element of allMatches(document, SEMANTIC_ROW_SELECTORS)) consider(semanticCandidate(element, input, pageType));

  // Report rows in the order the page lists them. The passes above run
  // route-first, which would otherwise hand back a page's work in an order that
  // matches neither the document nor anything the student can see.
  return Array.from(byRow.values())
    .filter(isCoursework)
    .sort((a, b) =>
      a.row === b.row
        ? 0
        : a.row.compareDocumentPosition(b.row) & Node.DOCUMENT_POSITION_FOLLOWING
          ? -1
          : 1,
    );
}

function taskAnchor(candidate: TaskCandidate): HTMLAnchorElement | null {
  if (candidate.anchor) return candidate.anchor;
  return primaryAnchor(candidate.row);
}

/**
 * What the row calls this piece of work.
 *
 * The row's own name container is asked first. Only when a row does not use one
 * does this fall back to the row's link, and then to a heading — which is what
 * the simpler list markup on stock Brightspace relies on.
 */
function taskTitle(candidate: TaskCandidate): string {
  const named = firstMatch(candidate.row, TASK_NAME_SELECTORS);
  const namedText = named ? nameText(named) : '';
  if (namedText) return namedText;

  const anchorText = normalizedText(taskAnchor(candidate));
  if (anchorText) return anchorText;

  return normalizedText(firstMatch(candidate.row, ['h1', 'h2', 'h3', 'h4', 'd2l-link']));
}

function dueText(element: Element): string {
  const datesText = element.querySelector('.d2l-dates-text, .d2l-folderdates-wrapper');
  const dateRows = datesText?.matches('.d2l-folderdates-wrapper')
    ? Array.from(datesText.querySelectorAll('.d2l-folderdate-wrapper-row')).map(normalizedText).filter(Boolean).join(' ')
    : '';
  const rowText = Array.from(element.children).map(normalizedText).filter(Boolean).join(' ') || normalizedText(element);
  const dueMarkers = Array.from(rowText.matchAll(/\b(?:due(?:\s+on)?|submit by)\b/gi));
  const lastDueMarker = dueMarkers.at(-1);
  if (lastDueMarker?.index !== undefined) {
    const dueTail = rowText.slice(lastDueMarker.index);
    const availabilityIndex = dueTail.search(/(?:available|starts?|availability|ends?|closes?)\b/i);
    return (availabilityIndex >= 0 ? dueTail.slice(0, availabilityIndex) : dueTail).trim();
  }

  const text = datesText
    ? dateRows || normalizedText(datesText)
    : rowText;
  const availabilityEnd = text.match(/\b(?:available(?:[^.;|]{0,80})?\s+until|availability ends|ends|closes)\b[^.;|]{0,80}?(?=\s+(?:available|starts?|availability|ends?|closes?)\b|[.;|]|$)/i);
  if (availabilityEnd?.[0]) {
    const raw = availabilityEnd[0].trim();
    const untilIndex = raw.toLowerCase().indexOf('until');
    return untilIndex > 'available'.length ? `Available until ${raw.slice(untilIndex + 'until'.length).trim()}` : raw;
  }
  const time = element.querySelector('time[datetime]');
  const hasAvailabilityStart = /\b(?:available|availability|starts?)\b/i.test(text);
  if (time && !hasAvailabilityStart) return time.getAttribute('datetime')?.trim() ?? '';
  return '';
}

function statusFor(element: Element): TaskStatus {
  const status = element.textContent?.match(/\b(submitted|completed|graded|attempt \d+)\b/i)?.[1]?.toLowerCase();
  if (status === 'submitted') return 'submitted';
  if (status === 'graded' || status === 'completed') return 'graded';
  if (status?.startsWith('attempt ')) return 'in-progress';
  return 'todo';
}

function courseExternalId(url: string): string | null {
  return queryValue(url, ['ou', 'orgUnitId']) ?? courseIdFromUrl(url);
}

function courseIdForTask(candidate: TaskCandidate, courseId: string | null): string | null {
  const localId = candidate.href ? queryValue(candidate.href, ['ou', 'orgUnitId']) : null;
  const resolved = localId ?? courseId;
  return resolved ? `d2l:${resolved}` : null;
}

function makeTask(candidate: TaskCandidate, input: AdapterInput, pageType: PageType, courseId: string | null): CourseTask | null {
  const title = taskTitle(candidate);
  const resolvedCourseId = courseIdForTask(candidate, courseId);
  const dueRaw = dueText(candidate.row);
  const parsedDue = parseDueDate(dueRaw, input.now, input.timeZone);
  // Brightspace uses the same date wrapper for an availability window. An end
  // is useful as a review hint, but it is not the assignment's due date unless
  // the row explicitly says due/submit by.
  const due = /\b(?:due(?:\s+on)?|submit by)\b/i.test(dueRaw)
    ? parsedDue
    : { ...parsedDue, confidence: 'low' as const };
  // A content route names reading material — a slide deck, a handout — which is
  // something to open, not something due. Listing a module's files as undated
  // deadlines buried the real ones, so a content row has to state a date of its
  // own to count. Every other route is a piece of work in itself.
  const hasRouteEvidence = candidate.route !== null && candidate.route.kind !== 'content';
  const hasDateEvidence = due.iso !== null;
  if ((!hasRouteEvidence && !hasDateEvidence) || !title || !resolvedCourseId) return null;

  const capturedAt = input.now.toISOString();
  const normalizedTitle = title.toLowerCase().replace(/\s+/g, ' ').trim();
  const taskCourseId = resolvedCourseId.replace(/^d2l:/, '');
  const quizId = candidate.anchor && pageType === 'quiz-list' ? quizIdFromAnchor(candidate.anchor) : null;
  const id = quizId
    ? `d2l:${taskCourseId}:quiz:${quizId}`
    : candidate.href
      ? `d2l:${canonicalTaskIdentity(candidate.href, taskCourseId) ?? `${taskCourseId}:title:${normalizedTitle}`}`
      : `d2l:${taskCourseId}:title:${normalizedTitle}`;
  return {
    id,
    courseId: resolvedCourseId,
    title,
    kind: candidate.route?.kind ?? taskKindForPage(pageType),
    due,
    status: statusFor(candidate.row),
    weight: extractWeight(normalizedText(candidate.row)),
    provenance: {
      sourceUrl: canonicalUrl(input.url),
      pageTitle: pageTitle(input.document),
      platformId: 'd2l',
      pageType,
      capturedAt,
      extractionVersion: EXTRACTION_VERSION,
      strategy: candidate.strategy,
    },
    corrections: [],
    studentEdited: false,
    manual: false,
    archived: false,
    createdAt: capturedAt,
    updatedAt: capturedAt,
  };
}

function taskKindForPage(pageType: PageType): TaskKind {
  if (pageType === 'quiz-list' || pageType === 'quiz-attempt') return 'quiz';
  if (pageType === 'discussion-list' || pageType === 'discussion-topic') return 'discussion';
  if (pageType === 'content-module' || pageType === 'content-topic') return 'content';
  return 'assignment';
}

export class D2LBrightspaceAdapter implements LearningPlatformAdapter {
  readonly id = 'd2l';
  readonly displayName = 'D2L Brightspace';
  readonly hostPatterns = HOST_PATTERNS;

  matchesHost(url: string): boolean {
    try {
      const host = new URL(url).hostname;
      return this.hostPatterns.some((pattern) => {
        pattern.lastIndex = 0;
        return pattern.test(host);
      });
    } catch {
      return false;
    }
  }

  /**
   * What a URL would be, from its route alone. Used to decide whether a link is
   * safe to open, so it never guesses: an unrecognised route is null, and a
   * sign-in wall or an attempt is reported as exactly that.
   */
  classifyUrl(url: string): PageType | null {
    if (!this.matchesHost(url)) return null;
    const pathname = pathnameOf(url);
    if (!pathname) return null;
    return ROUTES.find((candidate) => candidate.pattern.test(pathname))?.pageType ?? null;
  }

  courseIdForUrl(url: string): string | null {
    if (!this.matchesHost(url)) return null;
    return courseExternalId(url);
  }

  isLegacyTaskId(id: string, courseId: string): boolean {
    if (/^d2l:(?:title:|javascript:\/\/)/i.test(id)) return true;
    if (!/^d2l:https?:\/\//i.test(id)) return false;
    const href = id.slice('d2l:'.length);
    const canonical = canonicalTaskIdentity(href, courseId.replace(/^d2l:/, ''));
    return canonical === null || `d2l:${canonical}` !== id;
  }

  detectPage(input: AdapterInput): PageDetection | null {
    if (!this.matchesHost(input.url)) return null;
    const pathname = pathnameOf(input.url);
    if (!pathname) return { pageType: 'unsupported', confidence: 'low', warnings: ['The page URL could not be parsed.'] };

    if (looksSignedOut(input.document)) {
      return {
        pageType: 'signed-out',
        confidence: 'high',
        warnings: ['This D2L session has ended. Sign in again to let Motion read the page.'],
      };
    }

    const route = ROUTES.find((candidate) => candidate.pattern.test(pathname));
    if (route) {
      return {
        pageType: route.pageType,
        confidence: 'high',
        warnings:
          route.pageType === 'signed-out'
            ? ['This D2L session has ended. Sign in again to let Motion read the page.']
            : [],
      };
    }

    return { pageType: 'unsupported', confidence: 'low', warnings: [`Unsupported D2L route: ${pathname}`] };
  }

  extractCourse(input: AdapterInput): Course | null {
    // A sign-in stub carries the course URL but none of the course.
    if (this.detectPage(input)?.pageType === 'signed-out') return null;
    const externalId = courseExternalId(input.url);
    const { name, code } = courseIdentity(input.document);
    if (!externalId || !name) return null;
    const capturedAt = input.now.toISOString();
    const term = termFromName(name);
    return {
      id: `d2l:${externalId}`,
      platformId: 'd2l',
      name,
      ...(code ? { code } : {}),
      ...(term ? { term } : {}),
      homeUrl: canonicalUrl(input.url),
      externalId,
      lastVerifiedAt: capturedAt,
      archived: false,
    };
  }

  extractTasks(input: AdapterInput): CourseTask[] {
    const detection = this.detectPage(input);
    const pageType = detection?.pageType ?? 'unsupported';
    if (
      pageType === 'unsupported' ||
      pageType === 'signed-out' ||
      pageType === 'dashboard' ||
      pageType === 'announcements' ||
      pageType === 'grades' ||
      pageType === 'calendar'
    )
      return [];

    const externalCourseId = courseExternalId(input.url);
    const tasks: CourseTask[] = [];
    const seenTaskIds = new Set<string>();
    for (const candidate of taskCandidates(input.document, input, pageType)) {
      const task = makeTask(candidate, input, pageType, externalCourseId);
      if (!task) continue;
      if (seenTaskIds.has(task.id)) continue;
      seenTaskIds.add(task.id);
      tasks.push(task);
    }
    return tasks;
  }

  extractPageContent(input: AdapterInput): PageContent {
    const detection = this.detectPage(input);
    const pageType = detection?.pageType ?? 'unsupported';
    const readable = readablePageText(input.document);
    const headings = Array.from(input.document.querySelectorAll('main h1, main h2, main h3, [role="main"] h1, [role="main"] h2, [role="main"] h3, .d2l-page-main h1, .d2l-page-main h2, .d2l-page-main h3'))
      .map(normalizedText)
      .filter(Boolean)
      .slice(0, 100);
    const links: { href: string; label: string }[] = [];
    const seen = new Set<string>();
    for (const link of input.document.querySelectorAll('main a, [role="main"] a, .d2l-page-main a, body a')) {
      const href = absoluteUrl(link.getAttribute('href') ?? '', input.url);
      const label = normalizedText(link);
      if (!href || !label || seen.has(href)) continue;
      seen.add(href);
      links.push({ href, label });
    }
    return {
      pageType,
      title: pageTitle(input.document),
      url: input.url,
      text: readable.text,
      headings,
      links: links.slice(0, 200),
      instructionBlocks: instructionBlocksFor(pageType, input.document),
      capturedAt: input.now.toISOString(),
      warnings: [...(detection?.warnings ?? []), ...readable.warnings],
    };
  }

  getSupportedActions(pageType: PageType): readonly ActionType[] {
    if (pageType === 'signed-out') return [];
    return ASSESSMENT_PAGE_TYPES.includes(pageType) ? ASSESSMENT_READ_ACTIONS : READ_ACTIONS;
  }
}

/**
 * Instruction text, split by the structural element it came from.
 *
 * Only gathered on pages where instructions actually live -- an assignment,
 * a discussion prompt, or a content topic. Harvesting bullets from a grades
 * table would produce a checklist of nonsense.
 *
 * The adapter's job ends at "here is the instruction text and its shape"; what
 * counts as a requirement is decided in src/core/assist, with no DOM involved.
 */
function instructionBlocksFor(
  pageType: PageType,
  document: Document,
): { text: string; kind: 'list-item' | 'table-cell' | 'paragraph' | 'heading' }[] {
  const carriesInstructions =
    pageType === 'assignment' || pageType === 'discussion-topic' || pageType === 'content-topic';
  if (!carriesInstructions) return [];

  const region =
    document.querySelector('main') ??
    document.querySelector('[role="main"]') ??
    document.querySelector('.d2l-page-main') ??
    document.body;
  if (!region) return [];

  const blocks: { text: string; kind: 'list-item' | 'table-cell' | 'paragraph' | 'heading' }[] = [];
  const selector = 'li, td, th, p, h1, h2, h3, h4';
  for (const element of Array.from(region.querySelectorAll(selector))) {
    // Skip a container that only wraps other blocks; its text would duplicate
    // the children and swamp the checklist.
    if (element.querySelector(selector)) continue;
    const text = normalizedText(element);
    if (!text) continue;

    const tag = element.tagName.toLowerCase();
    const kind =
      tag === 'li'
        ? ('list-item' as const)
        : tag === 'td' || tag === 'th'
          ? ('table-cell' as const)
          : tag === 'p'
            ? ('paragraph' as const)
            : ('heading' as const);

    blocks.push({ text, kind });
    if (blocks.length >= 300) break;
  }
  return blocks;
}

export const d2lAdapter = new D2LBrightspaceAdapter();
export const D2LAdapter = D2LBrightspaceAdapter;
export default d2lAdapter;
