import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { evaluateAssessmentContext } from '@/core/policy';
import { d2lAdapter } from './d2l';
import type { AdapterInput } from './types';

const STOCK_ORIGIN = 'https://school.brightspace.com';
const WLU_ORIGIN = 'https://mylearningspace.wlu.ca';

function fixture(name: string): Document {
  const html = readFileSync(resolve(process.cwd(), `src/test/fixtures/d2l/${name}.html`), 'utf8');
  return new DOMParser().parseFromString(html, 'text/html');
}

function input(url: string, document: Document): AdapterInput {
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
    ['/d2l/lms/dropbox/user/folder_submit_files.d2l?ou=363&db=101', 'assignment'],
    ['/d2l/le/363/discussions/List', 'discussion-list'],
    ['/d2l/le/363/discussions/topics/301', 'discussion-topic'],
    ['/d2l/lms/quizzing/user/quizzes_list.d2l', 'quiz-list'],
    ['/d2l/lms/quizzing/user/attempt/201', 'quiz-attempt'],
    ['/d2l/lms/grades/363', 'grades'],
    ['/d2l/le/calendar/363', 'calendar'],
  ];

  it.each(routes.flatMap(([path, pageType]) => [[STOCK_ORIGIN, path, pageType], [WLU_ORIGIN, path, pageType]]))(
    'detects %s%s as %s from the platform route',
    (origin, path, pageType) => {
      expect(d2lAdapter.detectPage(input(`${origin}${path}`, fixture('course-home')))).toMatchObject({ pageType, confidence: 'high', warnings: [] });
    },
  );

  it('does not invent a page type for an unknown route', () => {
    const detection = d2lAdapter.detectPage(input(`${STOCK_ORIGIN}/d2l/unknown`, fixture('broken')));
    expect(detection).toMatchObject({ pageType: 'unsupported', confidence: 'low' });
    expect(detection?.warnings[0]).toContain('Unsupported D2L route');
  });

  it('degrades on renamed or partially loaded markup with warnings and no fabricated tasks', () => {
    const page = input(`${STOCK_ORIGIN}/d2l/unknown`, fixture('broken'));
    expect(d2lAdapter.extractPageContent(page).warnings.length).toBeGreaterThan(0);
    expect(d2lAdapter.extractTasks(page)).toEqual([]);
  });
});

describe('D2L route-based extraction', () => {
  it('extracts the course id from ou and parses code and term from the visible course name', () => {
    const course = d2lAdapter.extractCourse(input(`${STOCK_ORIGIN}/d2l/home/363?ou=363`, fixture('course-home')));
    expect(course).toMatchObject({
      id: 'd2l:363',
      platformId: 'd2l',
      name: 'CP363 Database II - Fall 2025',
      code: 'CP363',
      term: 'Fall 2025',
      externalId: '363',
    });
  });

  it('extracts assignment rows from D2L route hrefs and records route provenance', () => {
    const tasks = d2lAdapter.extractTasks(input(`${STOCK_ORIGIN}/d2l/lms/dropbox/user/folders_list.d2l?ou=363`, fixture('assignment-list')));
    expect(tasks).toHaveLength(2);
    expect(tasks.map(({ title, due: { iso }, weight }) => ({ title, iso, weight }))).toEqual([
      { title: 'Relational Algebra Worksheet', iso: '2025-10-15T03:59:00.000Z', weight: 15 },
      { title: 'Normalization Practice', iso: '2025-10-21T04:00:00.000Z', weight: 10 },
    ]);
    expect(tasks[0]?.provenance).toMatchObject({ strategy: 'route:assignment', platformId: 'd2l' });
    expect(tasks[1]?.status).toBe('submitted');
  });

  it('uses the route as the primary signal across institution skins: stock and MyLearningSpace assignment fixtures yield equivalent tasks', () => {
    const stock = d2lAdapter.extractTasks(input(`${STOCK_ORIGIN}/d2l/lms/dropbox/user/folders_list.d2l?ou=363`, fixture('assignment-list')));
    const myLearningSpace = d2lAdapter.extractTasks(input(`${WLU_ORIGIN}/d2l/lms/dropbox/user/folders_list.d2l?ou=363`, fixture('mylearningspace-assignment-list')));
    const comparable = (tasks: typeof stock) => tasks.map(({ title, due: { iso }, weight }) => ({ title, iso, weight }));
    expect(comparable(myLearningSpace)).toEqual(comparable(stock));
    expect(myLearningSpace.every((task) => task.provenance.strategy === 'route:assignment')).toBe(true);
  });

  it('extracts assignments, quizzes, discussions, and content topics from their route-shaped links', () => {
    const assignment = d2lAdapter.extractTasks(input(`${STOCK_ORIGIN}/d2l/lms/dropbox/user/folder_submit_files.d2l?ou=363&db=101`, fixture('assignment')));
    const quiz = d2lAdapter.extractTasks(input(`${WLU_ORIGIN}/d2l/lms/quizzing/user/quizzes_list.d2l?ou=363`, fixture('quiz-list')));
    const discussion = d2lAdapter.extractTasks(input(`${STOCK_ORIGIN}/d2l/le/363/discussions/List?ou=363`, fixture('discussion-list')));
    const content = d2lAdapter.extractTasks(input(`${WLU_ORIGIN}/d2l/le/content/363/viewContent/12?ou=363`, fixture('course-home')));
    expect(assignment[0]).toMatchObject({ kind: 'assignment', title: 'Relational Algebra Worksheet', weight: 15 });
    expect(quiz.map((task) => task.kind)).toEqual(['quiz', 'quiz']);
    expect(quiz[1]?.status).toBe('graded');
    expect(discussion.map((task) => task.kind)).toEqual(['discussion', 'discussion']);
    expect(content[0]).toMatchObject({ kind: 'content', title: 'Database foundations' });
    expect(new Set([assignment[0]?.provenance.strategy, quiz[0]?.provenance.strategy, discussion[0]?.provenance.strategy, content[0]?.provenance.strategy])).toEqual(new Set(['route:assignment', 'route:quiz', 'route:discussion', 'route:content']));
  });

  it('prefers time datetime, then D2L dates text, then the documented due-text fallback', () => {
    const assignment = d2lAdapter.extractTasks(input(`${STOCK_ORIGIN}/d2l/lms/dropbox/user/folder_submit_files.d2l?ou=363&db=101`, fixture('assignment')));
    const discussion = d2lAdapter.extractTasks(input(`${STOCK_ORIGIN}/d2l/le/363/discussions/List?ou=363`, fixture('discussion-list')));
    expect(assignment[0]?.due.raw).toBe('Available until Friday, October 14, 2025');
    expect(discussion[0]?.due.raw).toBe('Ends November 4, 2025');
    expect(discussion[1]?.due.raw).toBe('Closes November 11, 2025');
  });

  it('deduplicates by resolved href before falling back to normalized title', () => {
    const duplicateHref = d2lAdapter.extractTasks(input(`${STOCK_ORIGIN}/d2l/lms/dropbox/user/folders_list.d2l?ou=363`, fixture('assignment-list')));
    expect(duplicateHref).toHaveLength(2);

    const noHref = new DOMParser().parseFromString('<main><div class="d2l-textblock"><h2>Reading reminder</h2><span class="d2l-dates-text">Due October 14, 2025</span></div><div><h2>Reading reminder</h2><time datetime="2025-10-14">Due October 14, 2025</time></div></main>', 'text/html');
    const titleFallback = d2lAdapter.extractTasks(input(`${STOCK_ORIGIN}/d2l/home/363?ou=363`, noHref));
    expect(titleFallback).toHaveLength(1);
    expect(titleFallback[0]?.provenance.strategy).toBe('documented D2L class convention');
  });

  it('keeps quiz-attempt actions at the read-only policy boundary', () => {
    const pageType = 'quiz-attempt' as const;
    const actions = d2lAdapter.getSupportedActions(pageType);
    const assessment = evaluateAssessmentContext({ pageType, url: `${STOCK_ORIGIN}/d2l/lms/quizzing/user/attempt/201` });
    expect(actions).toEqual(['read-page']);
    expect(actions.every((action) => assessment.allowedActions.includes(action))).toBe(true);
    expect(d2lAdapter.extractTasks(input(`${STOCK_ORIGIN}/d2l/lms/quizzing/user/attempt/201?ou=363`, fixture('quiz-attempt')))[0]).toMatchObject({ kind: 'quiz', status: 'in-progress' });
  });
});

describe('D2L host matching', () => {
  it.each([`${STOCK_ORIGIN}/d2l/home`, 'https://campus.desire2learn.com/d2l/home', `${WLU_ORIGIN}/d2l/home`])('accepts %s', (url) => expect(d2lAdapter.matchesHost(url)).toBe(true));
  it.each(['https://brightspace.example.com/d2l/home', 'https://notbrightspace.com/d2l/home', 'not a URL'])('rejects %s', (url) => expect(d2lAdapter.matchesHost(url)).toBe(false));
});

describe('MyLearningSpace live-validation regressions', () => {
  const additionalRoutes: [string, string][] = [
    ['/d2l/lms/quizzing/user/quiz_summary.d2l?ou=999999&qi=201', 'quiz-list'],
    ['/d2l/lms/dropbox/user/folder_user_view_src.d2l?ou=999999&db=101', 'assignment'],
    ['/d2l/le/content/999999/navigateContent/424242/Next', 'content-topic'],
    ['/d2l/lp/ouHome/home.d2l?ou=999999', 'course-home'],
    ['/d2l/lms/grades/my_grades/main.d2l?ou=999999', 'grades'],
  ];

  it.each(additionalRoutes)('detects %s as %s', (path, pageType) => {
    expect(d2lAdapter.detectPage(input(`${WLU_ORIGIN}${path}`, fixture('course-home')))).toMatchObject({
      pageType,
      confidence: 'high',
    });
  });

  it('does not treat a non-numeric /d2l/home segment as a course home', () => {
    expect(d2lAdapter.detectPage(input(`${WLU_ORIGIN}/d2l/home/settings`, fixture('course-home')))).toMatchObject({
      pageType: 'unsupported',
    });
  });

  it('reads the org unit from a legacy uppercase OU parameter', () => {
    const course = d2lAdapter.extractCourse(input(`${WLU_ORIGIN}/d2l/lp/ouHome/home.d2l?OU=999999`, fixture('course-home')));
    expect(course).toMatchObject({ id: 'd2l:999999', externalId: '999999' });
  });

  it('never turns course-navbar list links into tasks', () => {
    const tasks = d2lAdapter.extractTasks(input(`${WLU_ORIGIN}/d2l/home/999999?ou=999999`, fixture('course-home-navbar')));
    expect(tasks.map((task) => task.title)).toEqual(['Week 1 reading']);
    expect(tasks.every((task) => !/folders_list|quizzes_list|discussions\/List|\/grades|\/calendar/i.test(task.id))).toBe(true);
  });

  it('produces no tasks on grades and calendar routes', () => {
    for (const path of ['/d2l/lms/grades/my_grades/main.d2l?ou=999999', '/d2l/le/calendar/999999?ou=999999']) {
      expect(d2lAdapter.extractTasks(input(`${WLU_ORIGIN}${path}`, fixture('course-home-navbar')))).toEqual([]);
    }
  });

  it('keeps a quiz pre-attempt summary readable while the attempt itself stays restricted', () => {
    const summaryUrl = `${WLU_ORIGIN}/d2l/lms/quizzing/user/quiz_summary.d2l?ou=999999&qi=201`;
    const summary = d2lAdapter.detectPage(input(summaryUrl, fixture('quiz-list')));
    expect(summary?.pageType).toBe('quiz-list');
    expect(evaluateAssessmentContext({ pageType: 'quiz-list', url: summaryUrl }).restricted).toBe(false);
    expect(
      evaluateAssessmentContext({ pageType: 'quiz-attempt', url: `${WLU_ORIGIN}/d2l/lms/quizzing/user/attempt/201` }).restricted,
    ).toBe(true);
  });
});
