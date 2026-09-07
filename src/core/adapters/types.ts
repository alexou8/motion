import type { Course, CourseTask, PageContent, PageType, Confidence } from '@/core/domain';

export interface DetectionInput {
  readonly url: string;
  readonly document: Document;
  readonly now: Date;
  readonly timeZone: string;
}

export interface ExtractionInput {
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
  detectPage(input: DetectionInput): PageDetection | null;
  extractCourse(input: ExtractionInput): Course | null;
  extractTasks(input: ExtractionInput): CourseTask[];
  extractPageContent(input: ExtractionInput): PageContent;
  getSupportedActions(pageType: PageType): readonly string[];
}

