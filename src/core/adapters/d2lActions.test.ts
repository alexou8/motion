import { describe, expect, it } from 'vitest';
import type { PageContent } from '@/core/domain';
import { resolveAssignmentResources, resolveCourseNav } from './d2lActions';

/** Synthetic fixture: not captured from a real D2L instance. */
function pageContent(overrides: Partial<PageContent> = {}): PageContent {
  return {
    pageType: 'assignment',
    title: 'Assignment 2: Relational Algebra',
    url: 'https://school.brightspace.com/d2l/lms/dropbox/user/folder_submit_files.d2l?ou=363&db=101',
    text: 'Submit your relational algebra solutions by the due date.',
    headings: ['Assignment 2'],
    links: [],
    resources: [],
    capturedAt: '2025-01-10T12:00:00.000Z',
    instructionBlocks: [],
    warnings: [],
    ...overrides,
  };
}

describe('resolveAssignmentResources (synthetic fixtures)', () => {
  it('treats the assignment page itself as the instructions source', () => {
    const resources = resolveAssignmentResources(pageContent());
    expect(resources.instructionsUrl).toMatchObject({
      url: 'https://school.brightspace.com/d2l/lms/dropbox/user/folder_submit_files.d2l?ou=363&db=101',
      provenance: 'the current assignment page',
    });
  });

  it('finds the rubric and submission links by label, and collects related readings', () => {
    const content = pageContent({
      links: [
        { href: 'https://school.brightspace.com/d2l/lms/rubrics/view.d2l?rb=9', label: 'View Rubric' },
        { href: 'https://school.brightspace.com/d2l/lms/dropbox/user/folder_submit_files.d2l?ou=363&db=101', label: 'Submit Assignment' },
        { href: 'https://school.brightspace.com/d2l/le/content/363/viewContent/12', label: 'Week 3 Reading' },
      ],
    });
    const resources = resolveAssignmentResources(content);
    expect(resources.rubricUrl).toMatchObject({ url: 'https://school.brightspace.com/d2l/lms/rubrics/view.d2l?rb=9', label: 'View Rubric' });
    expect(resources.submissionUrl).toMatchObject({ label: 'Submit Assignment' });
    expect(resources.relatedReadings).toHaveLength(1);
    expect(resources.relatedReadings[0]).toMatchObject({ label: 'Week 3 Reading' });
  });

  it('rejects a cross-origin link masquerading as the rubric', () => {
    const content = pageContent({
      links: [{ href: 'https://evil.example.com/rubric.pdf', label: 'View Rubric' }],
    });
    const resources = resolveAssignmentResources(content);
    expect(resources.rubricUrl).toBeUndefined();
  });

  it('rejects a plain-http link even when same host', () => {
    const content = pageContent({
      links: [{ href: 'http://school.brightspace.com/d2l/lms/rubrics/view.d2l?rb=9', label: 'View Rubric' }],
    });
    const resources = resolveAssignmentResources(content);
    expect(resources.rubricUrl).toBeUndefined();
  });
});

describe('resolveCourseNav (synthetic fixtures)', () => {
  it.each(['ou', 'OU', 'orgUnitId'])('uses the source URL %s query before unrelated links', (key) => {
    const url = `https://mylearningspace.wlu.ca/d2l/lms/dropbox/user/folders_list.d2l?${key}=999999`;
    expect(resolveCourseNav(url, pageContent({ links: [{ href: 'https://mylearningspace.wlu.ca/d2l/home/888888', label: 'Other course' }] }))?.contentUrl)
      .toBe('https://mylearningspace.wlu.ca/d2l/le/content/999999/home');
  });

  it('never selects a dashboard course from the first course-card link', () => {
    const content = pageContent({ links: [{ href: 'https://mylearningspace.wlu.ca/d2l/home/999999', label: 'Example course' }] });
    expect(resolveCourseNav('https://mylearningspace.wlu.ca/d2l/home', content)).toBeNull();
  });

  it('refuses a source without a course when its observed links name multiple courses', () => {
    const content = pageContent({ links: [
      { href: 'https://mylearningspace.wlu.ca/d2l/home/999999', label: 'Example course one' },
      { href: 'https://mylearningspace.wlu.ca/d2l/home/888888', label: 'Example course two' },
    ] });
    expect(resolveCourseNav('https://mylearningspace.wlu.ca/d2l/unknown', content)).toBeNull();
  });

  it.each([
    '/d2l/home/888888?ou=999999',
    '/d2l/lms/dropbox/user/folders_list.d2l?ou=888888&orgUnitId=999999',
    '/d2l/lms/dropbox/user/folders_list.d2l?ou=888888&ou=999999',
  ])('refuses conflicting source identifiers even with one valid linked course: %s', (path) => {
    expect(resolveCourseNav(`https://mylearningspace.wlu.ca${path}`, pageContent({ links: [
      { href: 'https://mylearningspace.wlu.ca/d2l/home/999999', label: 'Example course' },
    ] }))).toBeNull();
  });

  it('builds course-section URLs from the org unit id in the page URL', () => {
    const nav = resolveCourseNav('https://school.brightspace.com/d2l/home/363', pageContent());
    expect(nav).toEqual({
      contentUrl: 'https://school.brightspace.com/d2l/le/content/363/home',
      assignmentsUrl: 'https://school.brightspace.com/d2l/lms/dropbox/user/folders_list.d2l?ou=363',
      discussionsUrl: 'https://school.brightspace.com/d2l/le/363/discussions/List',
      quizzesUrl: 'https://school.brightspace.com/d2l/lms/quizzing/user/quizzes_list.d2l?ou=363',
      gradesUrl: 'https://school.brightspace.com/d2l/lms/grades/363',
      calendarUrl: 'https://school.brightspace.com/d2l/le/calendar/363',
    });
  });

  it('falls back to an org unit id found on an ou=-carrying same-origin link', () => {
    const content = pageContent({
      url: 'https://school.brightspace.com/d2l/lms/dropbox/user/folder_submit_files.d2l?db=101',
      links: [{ href: 'https://school.brightspace.com/d2l/home/363', label: 'Course home' }],
    });
    const nav = resolveCourseNav(content.url, content);
    expect(nav?.contentUrl).toBe('https://school.brightspace.com/d2l/le/content/363/home');
  });

  it('returns null when no org unit id can be established', () => {
    const content = pageContent({ url: 'https://school.brightspace.com/d2l/unknown', links: [] });
    expect(resolveCourseNav(content.url, content)).toBeNull();
  });

  it('returns null for a non-https source URL', () => {
    const content = pageContent({ url: 'http://school.brightspace.com/d2l/home/363' });
    expect(resolveCourseNav(content.url, content)).toBeNull();
  });
});
