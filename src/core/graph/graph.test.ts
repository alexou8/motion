import { describe, expect, it } from 'vitest';
import type { Course, CourseTask, PageContent } from '../domain';
import { deriveLinksFromPage } from './derive';
import { courseLinkId } from './derive';
import { effectiveLinks, mergeCourseLinks, resourcesForTask } from './query';
import { courseLinkSchema, type CourseLink } from './types';

const NOW = '2026-03-02T12:00:00.000Z';

const course: Course = {
  id: 'c1',
  platformId: 'd2l',
  name: 'Database II',
  code: 'CP363',
  lastVerifiedAt: NOW,
  archived: false,
};

const task: CourseTask = {
  id: 't1',
  courseId: 'c1',
  title: 'Assignment 2',
  kind: 'assignment',
  due: { iso: null, raw: '', zoneEvidence: 'none', timeAssumed: false, confidence: 'low' },
  dueHistory: [],
  dueConflict: null,
  status: 'todo',
  weight: null,
  provenance: {
    sourceUrl: 'https://lms.example.com/a2',
    pageTitle: '',
    platformId: 'd2l',
    pageType: 'assignment',
    capturedAt: NOW,
    extractionVersion: 1,
  },
  corrections: [],
  studentEdited: false,
  manual: false,
  archived: false,
  createdAt: NOW,
  updatedAt: NOW,
};

function page(overrides: Partial<PageContent> = {}): PageContent {
  return {
    pageType: 'assignment',
    title: 'Assignment 2',
    url: 'https://lms.example.com/a2',
    text: '',
    headings: [],
    links: [],
    capturedAt: NOW,
    instructionBlocks: [],
    warnings: [],
    ...overrides,
  };
}

describe('deriveLinksFromPage', () => {
  it('derives a link only when the label carries evidence', () => {
    const content = page({
      links: [
        { href: 'https://lms.example.com/rubric', label: 'Grading Rubric' },
        { href: 'https://lms.example.com/random', label: 'Click here' },
      ],
    });
    const links = deriveLinksFromPage(content, course, task, NOW);
    expect(links).toHaveLength(1);
    expect(links[0]!.relation).toBe('has-rubric');
    expect(links[0]!.to.url).toBe('https://lms.example.com/rubric');
    expect(links[0]!.provenance.sourceUrl).toBe(content.url);
  });

  it('ignores links without recognised evidence entirely', () => {
    const content = page({ links: [{ href: 'https://lms.example.com/x', label: 'Home' }] });
    expect(deriveLinksFromPage(content, course, task, NOW)).toHaveLength(0);
  });

  it('produces a stable id from courseId+relation+url', () => {
    const content = page({
      links: [{ href: 'https://lms.example.com/instructions', label: 'Instructions' }],
    });
    const links = deriveLinksFromPage(content, course, task, NOW);
    expect(links[0]!.id).toBe(
      courseLinkId('c1', 'has-instructions', 'https://lms.example.com/instructions'),
    );
  });
});

function link(overrides: Partial<CourseLink> = {}): CourseLink {
  return courseLinkSchema.parse({
    id: 'cl_1',
    courseId: 'c1',
    taskId: 't1',
    from: { kind: 'task', id: 't1' },
    relation: 'has-rubric',
    to: { kind: 'page', url: 'https://lms.example.com/rubric', title: 'Rubric' },
    confidence: 'medium',
    provenance: {
      sourceUrl: 'https://lms.example.com/a2',
      pageTitle: '',
      platformId: 'd2l',
      pageType: 'assignment',
      capturedAt: NOW,
      extractionVersion: 1,
    },
    userOverride: null,
    ...overrides,
  });
}

describe('effectiveLinks / resourcesForTask', () => {
  it('drops a link the student rejected', () => {
    const rejected = link({ userOverride: { state: 'rejected', at: NOW } });
    const kept = link({ id: 'cl_2', to: { kind: 'page', url: 'https://lms.example.com/reading' } });
    expect(effectiveLinks([rejected, kept])).toEqual([kept]);
  });

  it('resourcesForTask returns only effective links for that task', () => {
    const forTask = link();
    const rejectedForTask = link({ id: 'cl_2', userOverride: { state: 'rejected', at: NOW } });
    const otherTask = link({ id: 'cl_3', taskId: 't2', from: { kind: 'task', id: 't2' } });
    const result = resourcesForTask([forTask, rejectedForTask, otherTask], 't1');
    expect(result).toEqual([forTask]);
  });
});

describe('mergeCourseLinks', () => {
  it('upserts by id and preserves an existing override', () => {
    const existing = [link({ userOverride: { state: 'confirmed', at: NOW } })];
    const incoming = [link({ confidence: 'high' })];
    const merged = mergeCourseLinks(existing, incoming);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.confidence).toBe('high');
    expect(merged[0]!.userOverride).toEqual({ state: 'confirmed', at: NOW });
  });

  it('adds new links without touching unrelated existing ones', () => {
    const existing = [link()];
    const incoming = [link({ id: 'cl_new', to: { kind: 'page', url: 'https://lms.example.com/other' } })];
    const merged = mergeCourseLinks(existing, incoming);
    expect(merged.map((l) => l.id).sort()).toEqual(['cl_1', 'cl_new']);
  });
});
