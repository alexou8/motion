import type { ActionType } from '@/core/policy';
import type { Course, CourseTask, PageContent, PageType, Confidence } from '@/core/domain';

export interface AdapterInput {
  readonly url: string;
  readonly document: Document;
  readonly now: Date;
  readonly timeZone: string;
}

export interface PageDetection {
  readonly pageType: PageType;
  readonly confidence: Confidence;
  readonly warnings: string[];
}

export interface LearningPlatformAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly hostPatterns: readonly RegExp[];
  matchesHost(url: string): boolean;
  classifyUrl(url: string): PageType | null;
  detectPage(input: AdapterInput): PageDetection | null;
  extractCourse(input: AdapterInput): Course | null;
  extractTasks(input: AdapterInput): CourseTask[];
  extractPageContent(input: AdapterInput): PageContent;
  getSupportedActions(pageType: PageType): readonly ActionType[];
}
