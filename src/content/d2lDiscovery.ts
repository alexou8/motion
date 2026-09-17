import { coursesFromEnrollments, discoveryRunResultSchema, tasksFromCalendarEvents, tasksFromDropboxFolders, versionsForDiscovery, type DiscoveryRunResult } from '@/core/adapters/d2lDiscovery';
import { evaluateAssessmentContext } from '@/core/policy';
import { d2lAdapter } from '@/core/adapters/d2l';

const REQUEST_TIMEOUT_MS = 12_000;
const CONCURRENCY = 2;
const MAX_CALENDAR_TASKS_PER_COURSE = 500;
const MAX_PAGES_PER_REQUEST = 100;

export interface DiscoveryEnvironment {
  origin: string;
  page: { url: string; pageType: Parameters<typeof evaluateAssessmentContext>[0]['pageType']; title: string; text: string };
  now: () => Date;
  timeZone: () => string;
  fetch: typeof fetch;
}

type ResponseResult = { status: number; body: unknown } | { status: number; body: null };

type PagedResponse = { status: number; bodies: unknown[] };

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/**
 * Follows either paging style Valence uses: an ObjectListPage's `Next` URL,
 * or a PagedResultSet's `PagingInfo.Bookmark` offset (the org unit `Id` for
 * enrollments). See https://docs.valence.desire2learn.com/basic/apicall.html
 * ("Progressive paging through results") and
 * https://docs.valence.desire2learn.com/res/enroll.html for the bookmark
 * semantics of myenrollments.
 */
function nextPath(currentPath: string, body: unknown, origin: string): string | null {
  const paging = object(object(body)?.PagingInfo);
  const next = paging?.Next;
  if (typeof next === 'string' && next) {
    const nextUrl = new URL(next, origin);
    return nextUrl.origin === origin ? `${nextUrl.pathname}${nextUrl.search}` : null;
  }
  const bookmark = paging?.Bookmark;
  if (typeof bookmark !== 'string' || !bookmark) return null;
  const url = new URL(currentPath, origin);
  url.searchParams.set('bookmark', bookmark);
  return `${url.pathname}${url.search}`;
}

async function getJson(env: DiscoveryEnvironment, path: string): Promise<ResponseResult> {
  const url = new URL(path, env.origin);
  if (url.origin !== env.origin) throw new Error('Discovery only requests the current Learn host.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await env.fetch(url.toString(), { method: 'GET', credentials: 'include', signal: controller.signal });
    if (!response.ok) return { status: response.status, body: null };
    return { status: response.status, body: await response.json() as unknown };
  } finally { clearTimeout(timer); }
}

/** Follows Valence ObjectListPage bookmarks without ever leaving the Learn host. */
async function getJsonPages(env: DiscoveryEnvironment, path: string): Promise<PagedResponse> {
  const bodies: unknown[] = [];
  const visited = new Set<string>();
  let current: string | null = path;
  while (current && !visited.has(current) && visited.size < MAX_PAGES_PER_REQUEST) {
    visited.add(current);
    const response = await getJson(env, current);
    if (response.status !== 200) return { status: response.status, bodies };
    bodies.push(response.body);
    current = nextPath(current, response.body, env.origin);
  }
  return { status: 200, bodies };
}

function listRows(value: unknown): unknown[] {
  const row = object(value);
  return Array.isArray(value) ? value : Array.isArray(row?.Items) ? row.Items : Array.isArray(row?.Objects) ? row.Objects : [];
}

function combinePages(bodies: unknown[]): { Items: unknown[] } {
  return { Items: bodies.flatMap(listRows) };
}

async function getText(env: DiscoveryEnvironment, path: string): Promise<{ status: number; text: string }> {
  const url = new URL(path, env.origin);
  if (url.origin !== env.origin) throw new Error('Discovery only requests the current Learn host.');
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try { const response = await env.fetch(url.toString(), { method: 'GET', credentials: 'include', signal: controller.signal }); return { status: response.status, text: response.ok ? await response.text() : '' }; } finally { clearTimeout(timer); }
}

function signInBlocker(origin: string): DiscoveryRunResult { return { kind: 'blocked', message: `Sign in to ${new URL(origin).host} to scan your courses` }; }

/** Runs in the page's origin so browser session credentials never leave Learn. */
export async function discoverAllCourses(env: DiscoveryEnvironment): Promise<DiscoveryRunResult> {
  const assessment = evaluateAssessmentContext({ pageType: env.page.pageType, url: env.page.url, pageTitle: env.page.title, visibleText: env.page.text.slice(0, 4_000) });
  if (assessment.restricted) return { kind: 'refused', message: assessment.reason };
  try {
    const versionsResponse = await getJson(env, '/d2l/api/versions/');
    if (versionsResponse.status === 401 || versionsResponse.status === 403) return signInBlocker(env.origin);
    const versions = versionsResponse.status === 200 ? versionsForDiscovery(versionsResponse.body) : null;
    if (!versions) return { kind: 'error', message: 'Learn does not expose a compatible deadline API on this host.' };
    const enrollmentsResponse = await getJsonPages(env, `/d2l/api/lp/${versions.lp}/enrollments/myenrollments/?orgUnitTypeId=3&isActive=true`);
    if (enrollmentsResponse.status === 401 || enrollmentsResponse.status === 403) return signInBlocker(env.origin);
    if (enrollmentsResponse.status !== 200) return { kind: 'error', message: 'Motion could not read your course enrollments.' };
    const courses = coursesFromEnrollments(combinePages(enrollmentsResponse.bodies), env.origin, env.now());
    let stopped = false;
    const results: PagedResponse[] = new Array(courses.length);
    let next = 0;
    const worker = async () => {
      while (!stopped) {
        const index = next++;
        if (index >= courses.length) return;
        const course = courses[index]!;
        const windowStart = new Date(env.now().getTime() - 14 * 24 * 60 * 60 * 1_000).toISOString();
        const windowEnd = new Date(env.now().getTime() + 120 * 24 * 60 * 60 * 1_000).toISOString();
        const path = `/d2l/api/le/${versions.le}/${course.externalId}/calendar/events/myEvents/?startDateTime=${encodeURIComponent(windowStart)}&endDateTime=${encodeURIComponent(windowEnd)}`;
        const response = await getJsonPages(env, path);
        results[index] = response;
        if (response.status === 401 || response.status === 403) stopped = true;
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, courses.length) }, worker));
    if (stopped) return signInBlocker(env.origin);
    const tasks = results.flatMap((response, index) => {
      const course = courses[index];
      if (!course || response?.status !== 200) return [];
      const sourceUrl = new URL(`/d2l/api/le/${versions.le}/${course.externalId}/calendar/events/myEvents/`, env.origin).toString();
      return tasksFromCalendarEvents(combinePages(response.bodies), course, sourceUrl, env.now()).slice(0, MAX_CALENDAR_TASKS_PER_COURSE);
    });
    // Some institutions disable calendar API scopes. Fall back to the ordinary
    // per-course Upcoming/assignment-list HTML and the established D2L adapter.
    const unavailable = results.map((response, index) => ({ response, index })).filter(({ response }) => response?.status !== 200);
    for (const { index } of unavailable) {
      const course = courses[index]!;
      const path = `/d2l/lms/dropbox/user/folders_list.d2l?ou=${encodeURIComponent(course.externalId ?? '')}`;
      const page = await getText(env, path);
      if (page.status === 401 || page.status === 403) return signInBlocker(env.origin);
      if (page.status !== 200) continue;
      const document = new DOMParser().parseFromString(page.text, 'text/html');
      tasks.push(...d2lAdapter.extractTasks({ url: new URL(path, env.origin).toString(), document, now: env.now(), timeZone: env.timeZone() }));
    }
    return discoveryRunResultSchema.parse({ kind: 'success', courses, tasks, scannedAt: env.now().toISOString() });
  } catch {
    return { kind: 'error', message: 'Motion could not scan Learn right now. Try again while you are signed in.' };
  }
}

/** Fallback helper for an endpoint that provides folders instead of calendar events. */
export function tasksFromDiscoveryDropbox(value: unknown, course: Parameters<typeof tasksFromDropboxFolders>[1], sourceUrl: string, now: Date) {
  return tasksFromDropboxFolders(value, course, sourceUrl, now);
}
