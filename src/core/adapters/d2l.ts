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
  { pattern: /^\/d2l\/home\/[^/]+\/?$/i, pageType: 'course-home' },
  { pattern: /^\/d2l\/le\/content\/[^/]+\/home\/?$/i, pageType: 'content-module' },
  { pattern: /^\/d2l\/le\/content\/[^/]+\/viewContent\//i, pageType: 'content-topic' },
  { pattern: /^\/d2l\/le\/news(?:\/|$)/i, pageType: 'announcements' },
  { pattern: /^\/d2l\/lms\/dropbox\/user\/folders_list(?:\.d2l)?\/?$/i, pageType: 'assignment-list' },
  { pattern: /^\/d2l\/lms\/dropbox\/user\/folder_submit_files(?:\/|\.|$)/i, pageType: 'assignment' },
  { pattern: /^\/d2l\/le\/[^/]+\/discussions\/List(?:\/|$)/i, pageType: 'discussion-list' },
  { pattern: /^\/d2l\/le\/[^/]+\/discussions\/topics\//i, pageType: 'discussion-topic' },
  { pattern: /^\/d2l\/lms\/quizzing\/user\/quizzes_list(?:\.d2l)?\/?$/i, pageType: 'quiz-list' },
  { pattern: /^\/d2l\/lms\/quizzing\/user\/attempt\//i, pageType: 'quiz-attempt' },
  { pattern: /^\/d2l\/lms\/grades(?:\/|$)/i, pageType: 'grades' },
  { pattern: /^\/d2l\/le\/calendar(?:\/|$)/i, pageType: 'calendar' },
];

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

const TASK_ROUTE_PATTERNS: readonly { pattern: RegExp; route: RouteTask }[] = [
  {
    pattern: /\/d2l\/lms\/dropbox\/user\/(?:folder_submit_files|folders_list)(?:\.d2l)?(?:[/?]|$)/i,
    route: { kind: 'assignment', strategy: 'route:assignment' },
  },
  {
    pattern: /(?:\/d2l\/lms\/quizzing\/user\/quizzes_list(?:\.d2l)?(?:[/?]|$)|quiz_summary|\/quizzing\/user\/attempt\/)/i,
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

function queryValue(url: string, names: readonly string[]): string | null {
  try {
    const params = new URL(url).searchParams;
    for (const name of names) {
      const value = params.get(name)?.trim();
      if (value) return value;
    }
  } catch {
    return null;
  }
  return null;
}

function pageTitle(document: Document): string {
  return normalizedText(firstMatch(document, ['.d2l-page-title', 'h1'])) || document.title.trim() || 'D2L page';
}

function courseName(document: Document): string {
  const namedElement = firstMatch(document, [
    '.d2l-navigation-s-course-name',
    'd2l-navigation-link-text',
    '[class*="course-name"]',
    '.d2l-page-title',
    'h1',
  ]);
  const visibleName = normalizedText(namedElement);
  if (visibleName) return visibleName;

  const titleParts = document.title
    .split(/\s+-\s+|\s+\|\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  const courseCodePattern = /\b[A-Za-z]{2,}[A-Za-z0-9-]*\d[A-Za-z0-9-]*\b/;
  return titleParts.find((part) => courseCodePattern.test(part)) ?? titleParts[0] ?? '';
}

function courseCodeFromName(name: string): string | null {
  return name.match(/\b[A-Za-z]{2,}[A-Za-z0-9-]*\d[A-Za-z0-9-]*\b/)?.[0] ?? null;
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

function routeAnchorCandidate(anchor: HTMLAnchorElement, input: AdapterInput): TaskCandidate | null {
  const href = absoluteUrl(anchor.getAttribute('href') ?? '', input.url);
  if (!href) return null;
  const route = pageTypeFromTaskHref(href);
  if (!route) return null;
  return { row: meaningfulAncestor(anchor), anchor, href, route, strategy: route.strategy };
}

function documentedCandidate(element: Element, input: AdapterInput): TaskCandidate {
  const row = meaningfulAncestor(element);
  const anchor = row.querySelector<HTMLAnchorElement>('a[href]');
  const href = anchor ? absoluteUrl(anchor.getAttribute('href') ?? '', input.url) : null;
  const route = href ? pageTypeFromTaskHref(href) : null;
  return { row, anchor, href, route, strategy: 'documented D2L class convention' };
}

function semanticCandidate(element: Element, input: AdapterInput): TaskCandidate {
  const anchor = element.querySelector<HTMLAnchorElement>('a[href]');
  const href = anchor ? absoluteUrl(anchor.getAttribute('href') ?? '', input.url) : null;
  const route = href ? pageTypeFromTaskHref(href) : null;
  return { row: element, anchor, href, route, strategy: 'semantic table row' };
}

function taskCandidates(document: Document, input: AdapterInput): TaskCandidate[] {
  const candidates: TaskCandidate[] = [];
  for (const anchor of document.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    const candidate = routeAnchorCandidate(anchor, input);
    if (candidate) candidates.push(candidate);
  }
  for (const element of allMatches(document, DOCUMENTED_ROW_SELECTORS)) candidates.push(documentedCandidate(element, input));
  for (const element of allMatches(document, SEMANTIC_ROW_SELECTORS)) candidates.push(semanticCandidate(element, input));
  return candidates;
}

function taskAnchor(candidate: TaskCandidate): HTMLAnchorElement | null {
  if (candidate.anchor) return candidate.anchor;
  return candidate.row.querySelector<HTMLAnchorElement>('a[href]');
}

function taskTitle(candidate: TaskCandidate): string {
  const anchor = taskAnchor(candidate);
  const heading = firstMatch(candidate.row, ['h1', 'h2', 'h3', 'h4', 'd2l-link']);
  const anchorText = normalizedText(anchor);
  const headingText = normalizedText(heading);
  return anchorText || headingText;
}

function dueText(element: Element): string {
  const time = element.querySelector('time[datetime]');
  if (time) return time.getAttribute('datetime')?.trim() ?? '';
  const datesText = element.querySelector('.d2l-dates-text');
  if (datesText) return normalizedText(datesText);
  return element.textContent?.match(/(?:due|available until|ends|closes|submit by)\b[^.;|]{0,60}/i)?.[0].trim() ?? '';
}

function statusFor(element: Element): TaskStatus {
  const status = element.textContent?.match(/\b(submitted|completed|graded|attempt \d+)\b/i)?.[1]?.toLowerCase();
  if (status === 'submitted') return 'submitted';
  if (status === 'graded' || status === 'completed') return 'graded';
  if (status?.startsWith('attempt ')) return 'in-progress';
  return 'todo';
}

function courseExternalId(input: AdapterInput): string | null {
  return queryValue(input.url, ['ou', 'orgUnitId']) ?? courseIdFromUrl(input.url);
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
  const due = parseDueDate(dueRaw, input.now, input.timeZone);
  const hasRouteEvidence = candidate.route !== null;
  const hasDateEvidence = due.iso !== null;
  if ((!hasRouteEvidence && !hasDateEvidence) || !title || !resolvedCourseId) return null;

  const capturedAt = input.now.toISOString();
  const normalizedTitle = title.toLowerCase().replace(/\s+/g, ' ').trim();
  const id = candidate.href ? `d2l:${candidate.href}` : `d2l:title:${normalizedTitle}`;
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

  detectPage(input: AdapterInput): PageDetection | null {
    if (!this.matchesHost(input.url)) return null;
    const pathname = pathnameOf(input.url);
    if (!pathname) return { pageType: 'unsupported', confidence: 'low', warnings: ['The page URL could not be parsed.'] };

    const route = ROUTES.find((candidate) => candidate.pattern.test(pathname));
    if (route) return { pageType: route.pageType, confidence: 'high', warnings: [] };

    return { pageType: 'unsupported', confidence: 'low', warnings: [`Unsupported D2L route: ${pathname}`] };
  }

  extractCourse(input: AdapterInput): Course | null {
    const externalId = courseExternalId(input);
    const name = courseName(input.document);
    if (!externalId || !name) return null;
    const capturedAt = input.now.toISOString();
    const code = courseCodeFromName(name);
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
    if (pageType === 'unsupported' || pageType === 'dashboard' || pageType === 'grades' || pageType === 'calendar') return [];

    const externalCourseId = courseExternalId(input);
    const tasks: CourseTask[] = [];
    const seenHrefs = new Set<string>();
    const seenTitles = new Set<string>();
    for (const candidate of taskCandidates(input.document, input)) {
      const task = makeTask(candidate, input, pageType, externalCourseId);
      if (!task) continue;
      const href = candidate.href;
      const normalizedTitle = task.title.toLowerCase().replace(/\s+/g, ' ').trim();
      if (href) {
        if (seenHrefs.has(href)) continue;
        seenHrefs.add(href);
      } else {
        if (seenTitles.has(normalizedTitle)) continue;
        seenTitles.add(normalizedTitle);
      }
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
      capturedAt: input.now.toISOString(),
      warnings: [...(detection?.warnings ?? []), ...readable.warnings],
    };
  }

  getSupportedActions(pageType: PageType): readonly ActionType[] {
    return ASSESSMENT_PAGE_TYPES.includes(pageType) ? ASSESSMENT_READ_ACTIONS : READ_ACTIONS;
  }
}

export const d2lAdapter = new D2LBrightspaceAdapter();
export const D2LAdapter = D2LBrightspaceAdapter;
export default d2lAdapter;
