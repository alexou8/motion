import {
  ASSESSMENT_PAGE_TYPES,
  EXTRACTION_VERSION,
  pageTypeSchema,
  type Course,
  type CourseTask,
  type PageContent,
  type PageType,
  type TaskKind,
  type TaskStatus,
} from '@/core/domain';
import { parseDueDate } from '@/core/parse/dueDate';
import {
  absoluteUrl,
  allMatches,
  attributeText,
  canonicalUrl,
  courseIdFromUrl,
  extractWeight,
  firstMatch,
  normalizedText,
  readablePageText,
} from './dom';
import type { DetectionInput, ExtractionInput, LearningPlatformAdapter, PageDetection } from './types';

const HOST_PATTERNS: readonly RegExp[] = [/(^|\.)brightspace\.com$/i, /(^|\.)desire2learn\.com$/i, /^mylearningspace\.wlu\.ca$/i];

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

const TASK_SELECTORS = [
  '[data-task-id]',
  '[data-task]',
  '.d2l-task-card',
  '.d2l-assignment-item',
  '.d2l-quiz-item',
  'tr[data-activity-id]',
  'li.d2l-le-activity',
] as const;

const READ_ACTIONS: readonly string[] = ['read-page', 'capture-content', 'extract-tasks'];
const ASSESSMENT_READ_ACTIONS: readonly string[] = ['read-page', 'capture-content'];

function pathnameOf(url: string): string | null {
  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
}

function pageTypeFromDom(document: Document): PageType | null {
  const marker = firstMatch(document, ['[data-page-type]', '[data-d2l-page]', '[data-page]']);
  const value = marker ? attributeText(marker, ['data-page-type', 'data-d2l-page', 'data-page']) : '';
  const parsed = pageTypeSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function taskKindFor(pageType: PageType, element: Element): TaskKind {
  const explicit = attributeText(element, ['data-kind', 'data-task-kind']).toLowerCase();
  if (explicit === 'assignment' || explicit === 'quiz' || explicit === 'discussion' || explicit === 'content' || explicit === 'other') return explicit;
  if (pageType === 'quiz-list' || pageType === 'quiz-attempt') return 'quiz';
  if (pageType === 'discussion-list' || pageType === 'discussion-topic') return 'discussion';
  if (pageType === 'content-module' || pageType === 'content-topic') return 'content';
  return 'assignment';
}

function statusFor(element: Element): TaskStatus {
  const status = attributeText(element, ['data-status']).toLowerCase();
  if (status === 'in-progress' || status === 'submitted' || status === 'graded' || status === 'archived') return status;
  return 'todo';
}

function courseExternalId(input: ExtractionInput): string | null {
  const element = firstMatch(input.document, ['[data-course-id]', '[data-org-unit-id]', '[data-ou]']);
  const value = element ? attributeText(element, ['data-course-id', 'data-org-unit-id', 'data-ou']) : '';
  return value || courseIdFromUrl(input.url);
}

function courseName(document: Document): string {
  const namedElement = firstMatch(document, ['[data-course-name]', '.d2l-course-title', '.d2l-course-banner h1', '[data-testid="course-name"]']);
  if (!namedElement) return '';
  return attributeText(namedElement, ['data-course-name', 'aria-label']) || normalizedText(namedElement);
}

function pageTitle(document: Document): string {
  return document.title.trim() || normalizedText(firstMatch(document, ['h1', '.d2l-page-title'])) || 'D2L page';
}

function taskId(element: Element): string {
  return attributeText(element, ['data-task-id', 'data-task', 'data-activity-id', 'data-id', 'id']);
}

function taskTitle(element: Element): string {
  const ownTitle = attributeText(element, ['data-task-title']);
  const titleElement = firstMatch(element, ['[data-task-title]', '.d2l-task-title', '.d2l-activity-name', '.d2l-assignment-title', '.d2l-quiz-title', 'h1', 'h2', 'h3', 'a']);
  if (ownTitle) return ownTitle;
  if (!titleElement) return '';
  return attributeText(titleElement, ['data-task-title', 'aria-label']) || normalizedText(titleElement);
}

function dueText(element: Element): string {
  const ownDue = attributeText(element, ['data-due']);
  if (ownDue) return ownDue;
  const dueElement = firstMatch(element, ['[data-due]', '.d2l-task-due', '.d2l-due-date', '[class*="due"]', 'time[datetime]']);
  if (!dueElement) return '';
  return attributeText(dueElement, ['data-due', 'datetime']) || normalizedText(dueElement);
}

function courseIdForTask(element: Element, courseId: string | null): string | null {
  const localId = attributeText(element, ['data-course-id', 'data-org-unit-id', 'data-ou']);
  const resolved = localId || courseId;
  return resolved ? `d2l:${resolved}` : null;
}

function makeTask(element: Element, input: ExtractionInput, pageType: PageType, courseId: string | null): CourseTask | null {
  const externalTaskId = taskId(element);
  const title = taskTitle(element);
  const resolvedCourseId = courseIdForTask(element, courseId);
  if (!externalTaskId || !title || !resolvedCourseId) return null;

  const dueRaw = dueText(element);
  const due = parseDueDate(dueRaw, input.now, input.timeZone);
  const capturedAt = input.now.toISOString();
  return {
    id: `d2l:${externalTaskId}`,
    courseId: resolvedCourseId,
    title,
    kind: taskKindFor(pageType, element),
    due,
    status: statusFor(element),
    weight: extractWeight(normalizedText(element)),
    provenance: {
      sourceUrl: canonicalUrl(input.url),
      pageTitle: pageTitle(input.document),
      platformId: 'd2l',
      pageType,
      capturedAt,
      extractionVersion: EXTRACTION_VERSION,
      strategy: 'D2L task card selectors with data-* identity attributes',
    },
    corrections: [],
    studentEdited: false,
    manual: false,
    archived: false,
    createdAt: capturedAt,
    updatedAt: capturedAt,
  };
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

  detectPage(input: DetectionInput): PageDetection | null {
    if (!this.matchesHost(input.url)) return null;
    const pathname = pathnameOf(input.url);
    if (!pathname) return { pageType: 'unsupported', confidence: 'low', warnings: ['The page URL could not be parsed.'] };

    const route = ROUTES.find((candidate) => candidate.pattern.test(pathname));
    if (route) return { pageType: route.pageType, confidence: 'high', warnings: [] };

    const domPageType = pageTypeFromDom(input.document);
    if (domPageType) return { pageType: domPageType, confidence: 'medium', warnings: ['Page type came from a DOM marker because the URL route was not recognized.'] };

    return { pageType: 'unsupported', confidence: 'low', warnings: [`Unsupported D2L route: ${pathname}`] };
  }

  extractCourse(input: ExtractionInput): Course | null {
    const externalId = courseExternalId(input);
    const name = courseName(input.document);
    if (!externalId || !name) return null;
    const capturedAt = input.now.toISOString();
    return {
      id: `d2l:${externalId}`,
      platformId: 'd2l',
      name,
      ...(attributeText(firstMatch(input.document, ['[data-course-code]']) ?? input.document.documentElement, ['data-course-code']) ? { code: attributeText(firstMatch(input.document, ['[data-course-code]']) ?? input.document.documentElement, ['data-course-code']) } : {}),
      ...(attributeText(firstMatch(input.document, ['[data-term]']) ?? input.document.documentElement, ['data-term']) ? { term: attributeText(firstMatch(input.document, ['[data-term]']) ?? input.document.documentElement, ['data-term']) } : {}),
      homeUrl: canonicalUrl(input.url),
      externalId,
      lastVerifiedAt: capturedAt,
      archived: false,
    };
  }

  extractTasks(input: ExtractionInput): CourseTask[] {
    const detection = this.detectPage(input);
    const pageType = detection?.pageType ?? 'unsupported';
    if (pageType === 'unsupported' || pageType === 'dashboard' || pageType === 'grades' || pageType === 'calendar') return [];

    const externalCourseId = courseExternalId(input);
    const candidates = allMatches(input.document, TASK_SELECTORS);
    const tasks: CourseTask[] = [];
    const seen = new Set<string>();
    for (const candidate of candidates) {
      const task = makeTask(candidate, input, pageType, externalCourseId);
      if (!task || seen.has(task.id)) continue;
      seen.add(task.id);
      tasks.push(task);
    }
    return tasks;
  }

  extractPageContent(input: ExtractionInput): PageContent {
    const detection = this.detectPage(input);
    const pageType = detection?.pageType ?? 'unsupported';
    const readable = readablePageText(input.document);
    const headings = Array.from(input.document.querySelectorAll('main h1, main h2, main h3, [role="main"] h1, [role="main"] h2, [role="main"] h3, .d2l-page-main h1, .d2l-page-main h2, .d2l-page-main h3')).map(normalizedText).filter(Boolean).slice(0, 100);
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

  getSupportedActions(pageType: PageType): readonly string[] {
    return ASSESSMENT_PAGE_TYPES.includes(pageType) ? ASSESSMENT_READ_ACTIONS : READ_ACTIONS;
  }
}

export const d2lAdapter = new D2LBrightspaceAdapter();
export const D2LAdapter = D2LBrightspaceAdapter;
export default d2lAdapter;
