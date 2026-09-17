import { describe, expect, it } from 'vitest';
import { discoverAllCourses, type DiscoveryEnvironment } from './d2lDiscovery';

const now = () => new Date('2026-09-16T12:00:00.000Z');
function environment(fetchImpl: typeof fetch, pageType: DiscoveryEnvironment['page']['pageType'] = 'dashboard'): DiscoveryEnvironment {
  return { origin: 'https://school.brightspace.com', page: { url: 'https://school.brightspace.com/d2l/home', pageType, title: 'Learn', text: '' }, now, timeZone: () => 'America/Toronto', fetch: fetchImpl };
}
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('all-course discovery runner', () => {
  it('limits course calendar GETs to two concurrent requests', async () => {
    let active = 0; let max = 0;
    const fetch: typeof globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes('/versions/')) return response([{ ProductCode: 'LP', LatestVersion: '1.80' }, { ProductCode: 'LE', LatestVersion: '1.90' }]);
      if (url.includes('myenrollments')) return response({ Items: [1, 2, 3].map((Id) => ({ OrgUnit: { Id, Name: `Course ${Id}` }, IsActive: true })) });
      active += 1; max = Math.max(max, active); await Promise.resolve(); active -= 1;
      return response({ Items: [{ CalendarEventId: Number(url.match(/le\/1\.90\/(\d+)/)?.[1]), Title: 'Quiz', EndDateTime: '2026-09-20T12:00:00Z', AssociatedEntity: { AssociatedEntityType: 'D2L.LE.Quizzing.Quiz', AssociatedEntityId: 1 } }] });
    };
    const result = await discoverAllCourses(environment(fetch));
    expect(result).toMatchObject({ kind: 'success' });
    expect(max).toBeLessThanOrEqual(2);
  });

  it('returns the sign-in blocker for an API 401', async () => {
    const result = await discoverAllCourses(environment((async () => response({}, 401)) as typeof fetch));
    expect(result).toEqual({ kind: 'blocked', message: 'Sign in to school.brightspace.com to scan your courses' });
  });

  it('refuses to scan from a graded attempt', async () => {
    const result = await discoverAllCourses(environment((async () => response({})) as typeof fetch, 'quiz-attempt'));
    expect(result.kind).toBe('refused');
  });

  it('uses a bounded calendar window and follows documented bookmark pages', async () => {
    const urls: string[] = [];
    const fetch: typeof globalThis.fetch = async (input) => {
      const url = String(input); urls.push(url);
      if (url.includes('/versions/')) return response([{ ProductCode: 'LP', LatestVersion: '1.80' }, { ProductCode: 'LE', LatestVersion: '1.90' }]);
      if (url.includes('myenrollments')) return response({ Items: [{ OrgUnit: { Id: 101, Name: 'Course 101' }, Access: { IsActive: true, CanAccess: true } }] });
      if (!url.includes('bookmark=')) return response({ Items: [{ Title: 'Quiz 1', EventType: 'DueDate', EndDateTime: '2026-09-20T12:00:00Z', AssociatedEntity: { AssociatedEntityType: 'D2L.LE.Quizzing.Quiz', AssociatedEntityId: 1 } }], PagingInfo: { Bookmark: 'next-page' } });
      return response({ Items: [{ Title: 'Quiz 2', EventType: 'DueDate', EndDateTime: '2026-09-21T12:00:00Z', AssociatedEntity: { AssociatedEntityType: 'D2L.LE.Quizzing.Quiz', AssociatedEntityId: 2 } }] });
    };
    const result = await discoverAllCourses(environment(fetch));
    expect(result).toMatchObject({ kind: 'success', tasks: [{ id: 'd2l:101:quiz:1' }, { id: 'd2l:101:quiz:2' }] });
    const calendarUrl = urls.find((url) => url.includes('calendar/events/myEvents/'))!;
    expect(calendarUrl).toContain('startDateTime=2026-09-02T12%3A00%3A00.000Z');
    expect(calendarUrl).toContain('endDateTime=2027-01-14T12%3A00%3A00.000Z');
    expect(urls.some((url) => url.includes('bookmark=next-page'))).toBe(true);
  });
});
