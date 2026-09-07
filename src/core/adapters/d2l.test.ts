import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { d2lAdapter } from './d2l';
import type { DetectionInput, ExtractionInput } from './types';

function fixture(name: string): Document {
  const html = readFileSync(resolve(process.cwd(), `src/test/fixtures/d2l/${name}.html`), 'utf8');
  return new DOMParser().parseFromString(html, 'text/html');
}

function input(url: string, document: Document): DetectionInput & ExtractionInput {
  return { url, document, now: new Date('2025-01-10T12:00:00.000Z'), timeZone: 'America/Toronto' };
}

describe('D2L route detection', () => {
  const routes: [string, string][] = [
    ['/d2l/home', 'dashboard'],
    ['/d2l/home/363', 'course-home'],
    ['/d2l/le/content/363/home', 'content-module'],
    ['/d2l/le/content/363/viewContent/12', 'content-topic'],
    ['/d2l/le/news/123', 'announcements'],
    ['/d2l/lms/dropbox/user/folders_list.d2l', 'assignment-list'],
    ['/d2l/lms/dropbox/user/folder_submit_files.d2l?ou=363', 'assignment'],
    ['/d2l/le/363/discussions/List', 'discussion-list'],
    ['/d2l/le/363/discussions/topics/7', 'discussion-topic'],
    ['/d2l/lms/quizzing/user/quizzes_list.d2l', 'quiz-list'],
    ['/d2l/lms/quizzing/user/attempt/7', 'quiz-attempt'],
    ['/d2l/lms/grades/363', 'grades'],
    ['/d2l/le/calendar/363', 'calendar'],
  ];

  it.each(routes)('detects %s as %s', (path, pageType) => {
    expect(d2lAdapter.detectPage(input(`https://school.brightspace.com${path}`, fixture('course-home')))).toMatchObject({ pageType, confidence: 'high', warnings: [] });
  });

  it('does not invent a page type for an unknown route', () => {
    const detection = d2lAdapter.detectPage(input('https://school.brightspace.com/d2l/unknown', fixture('broken')));
    expect(detection).toMatchObject({ pageType: 'unsupported', confidence: 'low' });
    expect(detection?.warnings[0]).toContain('Unsupported D2L route');
  });

  it('degrades on a broken or partially loaded fixture', () => {
    const page = d2lAdapter.extractPageContent(input('https://school.brightspace.com/d2l/unknown', fixture('broken')));
    expect(page.pageType).toBe('unsupported');
    expect(page.warnings.length).toBeGreaterThan(0);
    expect(d2lAdapter.extractTasks(input('https://school.brightspace.com/d2l/unknown', fixture('broken')))).toEqual([]);
  });
});

describe('D2L extraction', () => {
  it('extracts a course from a course home', () => {
    const course = d2lAdapter.extractCourse(input('https://school.brightspace.com/d2l/home/363', fixture('course-home')));
    expect(course).toMatchObject({ id: 'd2l:363', platformId: 'd2l', name: 'CP363 Database II', code: 'CP363', externalId: '363' });
  });

  it('extracts and deduplicates assignment tasks, including weights', () => {
    const tasks = d2lAdapter.extractTasks(input('https://school.brightspace.com/d2l/lms/dropbox/user/folders_list.d2l', fixture('assignment-list')));
    expect(tasks).toHaveLength(2);
    expect(tasks[0]).toMatchObject({ id: 'd2l:assignment-01', title: 'Relational Algebra Worksheet', kind: 'assignment', weight: 15 });
    expect(tasks[1]).toMatchObject({ id: 'd2l:assignment-02', status: 'submitted', weight: 10 });
    expect(tasks[0]?.provenance).toMatchObject({ platformId: 'd2l', extractionVersion: 1 });
  });

  it('extracts a single assignment with rubric-ish readable instructions', () => {
    const page = input('https://school.brightspace.com/d2l/lms/dropbox/user/folder_submit_files.d2l?ou=363', fixture('assignment'));
    const tasks = d2lAdapter.extractTasks(page);
    const content = d2lAdapter.extractPageContent(page);
    expect(tasks).toHaveLength(1);
    expect(content.text).toContain('Include one sentence of justification per step.');
    expect(content.text).not.toContain('Brightspace navigation');
  });

  it('keeps quiz attempts read-only', () => {
    const actions = d2lAdapter.getSupportedActions('quiz-attempt');
    expect(actions).toEqual(['read-page', 'capture-content']);
    expect(actions.some((action) => /write|submit|answer|draft|mutate|navigate/i.test(action))).toBe(false);
  });
});

describe('D2L host matching', () => {
  it.each([
    'https://school.brightspace.com/d2l/home',
    'https://campus.desire2learn.com/d2l/home',
    'https://mylearningspace.wlu.ca/d2l/home',
  ])('accepts %s', (url) => expect(d2lAdapter.matchesHost(url)).toBe(true));

  it.each(['https://brightspace.example.com/d2l/home', 'https://notbrightspace.com/d2l/home', 'not a URL'])('rejects %s', (url) => expect(d2lAdapter.matchesHost(url)).toBe(false));
});

