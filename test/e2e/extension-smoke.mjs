/**
 * Live extension smoke test.
 *
 * Loads the built `dist/` into a real Chromium as an unpacked MV3 extension and
 * exercises the contexts a unit test cannot reach: the service worker, the
 * content script inside a page, the messaging boundary between them, and the
 * side-panel document.
 *
 * D2L is never contacted. Requests to a matched host are fulfilled from the
 * synthetic fixtures in `src/test/fixtures/d2l/`, so this needs no account, no
 * credentials, and touches no real course data. It proves the extension loads
 * and that the whole path works end to end on markup Motion claims to support.
 * It proves nothing about the real deployment's markup — that part is
 * `docs/MANUAL-TESTING.md`, and a person has to run it.
 *
 * Run with: npm run test:extension  (after npm run build)
 */
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const distPath = resolve(here, '../../dist');
const fixtureDir = resolve(here, '../../src/test/fixtures/d2l');
const executablePath =
  process.env.MOTION_CHROME ??
  (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : chromium.executablePath());
const ORIGIN = 'https://mylearningspace.wlu.ca';

let failures = 0;
let total = 0;

function check(name, passed, detail = '') {
  total += 1;
  if (!passed) failures += 1;
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const fixture = (name) => readFileSync(join(fixtureDir, `${name}.html`), 'utf8');
const jsonFixture = (name) => readFileSync(join(fixtureDir, `${name}.json`), 'utf8');

/** Route shapes served to the browser. Every page is synthetic. */
const ROUTES = [
  { path: '/d2l/home', fixture: 'course-home', expect: 'dashboard' },
  { path: '/d2l/home/999999?ou=999999', fixture: 'course-home-navbar', expect: 'course-home' },
  { path: '/d2l/le/content/999999/home?ou=999999', fixture: 'course-home', expect: 'content-module' },
  { path: '/d2l/lms/dropbox/user/folders_list.d2l?ou=999999', fixture: 'mylearningspace-assignment-list', expect: 'assignment-list' },
  { path: '/d2l/lms/quizzing/user/quizzes_list.d2l?ou=999999', fixture: 'quiz-list', expect: 'quiz-list' },
  { path: '/d2l/lms/quizzing/user/quiz_summary.d2l?ou=999999&qi=201', fixture: 'quiz-list', expect: 'quiz-list' },
  { path: '/d2l/le/999999/discussions/List?ou=999999', fixture: 'discussion-list', expect: 'discussion-list' },
  { path: '/d2l/lms/grades/my_grades/main.d2l?ou=999999', fixture: 'course-home-navbar', expect: 'grades' },
  { path: '/d2l/lms/quizzing/user/attempt/201?ou=999999', fixture: 'quiz-attempt', expect: 'quiz-attempt', restricted: true },
  { path: '/d2l/lms/dropbox/user/folder_submit_files.d2l?ou=363&db=101', fixture: 'assignment', expect: 'assignment' },
  { path: '/d2l/lp/whatever/unknown', fixture: 'broken', expect: 'unsupported' },
  // The document a signed-out D2L serves for any route.
  { path: '/d2l/home/424242?ou=424242', fixture: 'signed-out-redirect', expect: 'signed-out' },
];

const REGRESSION_ROUTES = [
  { path: '/d2l/home/888888?ou=888888', fixture: 'e2e-course-cs202' },
  { path: '/d2l/home/1234?ou=1234', fixture: 'e2e-prefix-course' },
  { path: '/d2l/home/12345?ou=12345', fixture: 'e2e-prefix-course' },
  { path: '/d2l/lp/ouHome/home?ou=999999', fixture: 'e2e-course-heading-title' },
  { path: '/d2l/lms/dropbox/user/folders_list.d2l?ou=999999&delayed=1', fixture: 'e2e-delayed-assignment-list' },
  { path: '/d2l/lp/ouHome/home?ou=999999&slow=1', fixture: 'e2e-slow-course-home' },
];

const ALL_ROUTES = [...ROUTES, ...REGRESSION_ROUTES];

const userDataDir = await mkdtemp(join(tmpdir(), 'motion-e2e-'));
const context = await chromium.launchPersistentContext(userDataDir, {
  executablePath,
  headless: true,
  args: [
    `--disable-extensions-except=${distPath}`,
    `--load-extension=${distPath}`,
    // Every hostname resolves to nothing. Routed requests are answered by
    // Playwright before DNS, so the synthetic LMS still works; anything it does
    // not intercept fails here instead of reaching a real host. That includes a
    // tab Motion opens itself, whose first navigation can start before
    // Playwright attaches its router — which once let this test reach the real
    // institution's sign-in page.
    '--host-resolver-rules=MAP * ~NOTFOUND',
  ],
});

try {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20_000 });
  const extensionId = new URL(worker.url()).host;
  check('service worker registers from the unpacked build', Boolean(extensionId), `extension id ${extensionId}`);

  const workerErrors = [];
  worker.on('console', (message) => {
    if (message.type() === 'error') workerErrors.push(message.text());
  });

  // Extension APIs are reachable from an extension document. The side panel is
  // the document Motion actually ships, so it doubles as the control surface.
  const panel = await context.newPage();
  const panelErrors = [];
  panel.on('pageerror', (error) => panelErrors.push(error.message));
  panel.on('console', (message) => {
    if (message.type() === 'error') panelErrors.push(message.text());
  });
  await panel.goto(`chrome-extension://${extensionId}/src/sidepanel/index.html`, { waitUntil: 'domcontentloaded' });
  check('side panel document loads and renders', (await panel.innerText('body')).includes('Motion'));

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/src/popup/index.html`, { waitUntil: 'domcontentloaded' });
  await popup.waitForTimeout(800);
  const popupBody = await popup.innerText('body');
  check('popup default bridge resolves bounded context', /Open Motion/.test(popupBody) && !/Loading page context/i.test(popupBody), popupBody.replace(/\s+/g, ' ').slice(0, 160));
  await popup.close();

  const manifest = await panel.evaluate(() => chrome.runtime.getManifest());
  check('manifest loads in the browser as MV3', manifest.manifest_version === 3);
  check('minimum_chrome_version is still 116', manifest.minimum_chrome_version === '116');
  check(
    'host permissions are unchanged',
    JSON.stringify(manifest.host_permissions) ===
      JSON.stringify([`https://*.brightspace.com/*`, `https://*.desire2learn.com/*`, `${ORIGIN}/*`]),
    JSON.stringify(manifest.host_permissions),
  );

  // Role inference hands `extension-ui` to anything served from the extension
  // origin, which is safe only while no HTML page is web-accessible: a page
  // could then be opened by a website and would carry that role.
  const webAccessible = (manifest.web_accessible_resources ?? []).flatMap((entry) => entry.resources ?? []);
  check(
    'only script bundles are web-accessible',
    webAccessible.length > 0 && webAccessible.every((resource) => /\.(?:js|mjs|css|woff2?|png|svg)$/i.test(resource)) &&
      webAccessible.every((resource) => !/\.(?:html?|xht(?:ml)?|svg)$/i.test(resource) && !resource.includes('*')),
    webAccessible.join(', ') || 'none',
  );

  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/src/options/index.html`, { waitUntil: 'domcontentloaded' });
  check('options page loads without a runtime error', (await options.innerText('body')).length > 0);
  await options.close();

  // Serve synthetic markup for the matched host. Nothing leaves the machine.
  await context.route(`${ORIGIN}/**`, (route) => {
    const requestUrl = new URL(route.request().url());
    if (requestUrl.pathname === '/d2l/api/versions/') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ Items: [{ ProductCode: 'lp', LatestVersion: '1.48' }, { ProductCode: 'le', LatestVersion: '1.48' }] }) });
    }
    if (requestUrl.pathname.includes('/enrollments/myenrollments/')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: jsonFixture('discovery-enrollments') });
    }
    if (requestUrl.pathname.includes('/calendar/events/myEvents/')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: jsonFixture('discovery-calendar-events') });
    }
    const match = ALL_ROUTES.find((candidate) => {
      const candidateUrl = new URL(candidate.path, ORIGIN);
      return candidateUrl.pathname === requestUrl.pathname &&
        (!candidateUrl.search || candidateUrl.search === requestUrl.search);
    });
    return route.fulfill({
      status: match ? 200 : 404,
      contentType: 'text/html',
      body: match ? fixture(match.fixture) : '<!doctype html><title>Not found</title><body>404',
    });
  });

  const page = await context.newPage();
  // Mirrors the worker: frame 0, and a couple of retries because the bundled
  // content script registers its listener after an async import.
  const askContentScript = () =>
    panel.evaluate(async (origin) => {
      const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
      const [tab] = await chrome.tabs.query({ url: `${origin}/*` });
      if (!tab?.id) return { error: 'no matching tab' };
      let lastError = 'never attempted';
      for (let attempt = 0; attempt < 6; attempt += 1) {
        try {
          return await chrome.tabs.sendMessage(tab.id, { type: 'motion:extract-content' }, { frameId: 0 });
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
          await sleep(250);
        }
      }
      return { error: lastError };
    }, ORIGIN);

  const requestExtractionForTab = (tabId) =>
    panel.evaluate((id) => chrome.runtime.sendMessage({ type: 'request-extraction', tabId: id }), tabId);

  const activeTabId = () =>
    panel.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id ?? null);

  const getState = () => panel.evaluate(() => chrome.runtime.sendMessage({ type: 'get-state' }));

  const getObservation = (tabId) =>
    panel.evaluate(async (id) => (await chrome.storage.session.get(`observation:${id}`))[`observation:${id}`] ?? null, tabId);

  const storedCourseExternalIds = () =>
    panel.evaluate(() => new Promise((resolve) => {
      const request = indexedDB.open('motion');
      request.onerror = () => resolve([]);
      request.onsuccess = () => {
        const db = request.result;
        const read = db.transaction('courses', 'readonly').objectStore('courses').getAll();
        read.onerror = () => { db.close(); resolve([]); };
        read.onsuccess = () => {
          db.close();
          resolve(read.result.map((course) => course.externalId).filter((id) => typeof id === 'string'));
        };
      };
    }));

  for (const route of ROUTES) {
    await page.goto(`${ORIGIN}${route.path}`, { waitUntil: 'load' });
    const reply = await askContentScript();

    if (route.restricted) {
      check(`${route.path} — restricted page refuses to hand over content`, typeof reply?.refused === 'string', reply?.refused ?? JSON.stringify(reply).slice(0, 120));
      continue;
    }

    check(
      `${route.path} — content script reports ${route.expect}`,
      reply?.content?.pageType === route.expect,
      reply?.error ?? `got ${reply?.content?.pageType}`,
    );
  }

  // Full path: panel asks the worker, the worker asks the content script, the
  // content script extracts, the worker stores, the panel reads it back.
  await page.goto(`${ORIGIN}/d2l/lms/dropbox/user/folders_list.d2l?ou=999999`, { waitUntil: 'load' });
  const requested = await panel.evaluate(async (origin) => {
    const [tab] = await chrome.tabs.query({ url: `${origin}/*` });
    return chrome.runtime.sendMessage({ type: 'request-extraction', tabId: tab?.id });
  }, ORIGIN);
  check('the worker accepts an extraction request from the panel', requested?.result?.requested === true, JSON.stringify(requested).slice(0, 200));

  await panel.waitForTimeout(1_000);
  const extracted = await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'get-state' }));
  const extractedTasks = extracted?.result?.tasks ?? [];
  check(
    'extracted assignments reach the panel with their due dates',
    extractedTasks.length === 2 && extractedTasks.every((task) => typeof task.due?.iso === 'string'),
    extractedTasks.map((task) => `${task.title} @ ${task.due?.iso}`).join(' | ') || 'none',
  );
  check(
    'every extracted task carries provenance back to the page it came from',
    extractedTasks.every((task) => typeof task.provenance?.sourceUrl === 'string' && task.provenance.platformId === 'd2l'),
  );

  // The worker's stored view, read the way the panel reads it.
  await page.goto(`${ORIGIN}/d2l/home/999999?ou=999999`, { waitUntil: 'load' });
  await panel.waitForTimeout(800);
  const state = await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'get-state' }));
  check('side panel gets state from the worker', state?.ok === true, JSON.stringify(state?.error ?? '').slice(0, 200));
  check(
    'the observed page reaches the panel state',
    state?.result?.page?.pageType === 'course-home',
    `got ${state?.result?.page?.pageType}`,
  );

  // Extract from the navbar page itself, so this asserts what the navbar page
  // produces rather than what the assignment list left behind.
  await page.goto(`${ORIGIN}/d2l/home/999999?ou=999999`, { waitUntil: 'load' });
  await panel.evaluate(async (origin) => {
    const [tab] = await chrome.tabs.query({ url: `${origin}/*` });
    return chrome.runtime.sendMessage({ type: 'request-extraction', tabId: tab?.id });
  }, ORIGIN);
  await panel.waitForTimeout(1_000);
  const afterNavbar = await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'get-state' }));
  const tasks = afterNavbar?.result?.tasks ?? [];
  check(
    'no navigation link became a task',
    !tasks.some((task) => /^(Assignments|Quizzes|Discussions|Grades|Calendar|Course Home|Content)$/i.test((task.title ?? '').trim())),
    tasks.map((task) => task.title).join(', ') || 'no tasks stored',
  );

  // A page script must not be able to talk to the worker: `externally_connectable`
  // is omitted, so `chrome.runtime` should not even exist in the page.
  const fromPage = await page.evaluate(async (id) => {
    if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return { unavailable: true };
    try {
      return { reply: await chrome.runtime.sendMessage(id, { type: 'get-state' }) };
    } catch (error) {
      return { blocked: error instanceof Error ? error.message : String(error) };
    }
  }, extensionId);
  check('a page script cannot reach the worker', fromPage?.reply?.ok !== true, JSON.stringify(fromPage).slice(0, 160));

  // Client-side navigation: the URL changes with no load, and Motion must notice.
  await page.goto(`${ORIGIN}/d2l/home/999999?ou=999999`, { waitUntil: 'load' });
  await page.evaluate(() => history.pushState({}, '', '/d2l/lms/grades/my_grades/main.d2l?ou=999999'));
  await panel.waitForTimeout(1_600);
  const afterSpa = await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'get-state' }));
  check(
    'a history navigation is re-observed without a reload',
    afterSpa?.result?.page?.pageType === 'grades',
    `got ${afterSpa?.result?.page?.pageType}`,
  );

  // A graded attempt must not leave the previous course page on screen, and must
  // not carry the attempt's URL or title into stored state either.
  await page.goto(`${ORIGIN}/d2l/home/999999?ou=999999`, { waitUntil: 'load' });
  await panel.waitForTimeout(900);
  await page.goto(`${ORIGIN}/d2l/lms/quizzing/user/attempt/201?ou=999999`, { waitUntil: 'load' });
  await panel.waitForTimeout(900);
  const duringAttempt = await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'get-state' }));
  check(
    'a graded attempt puts the panel in restricted mode',
    duringAttempt?.result?.connection === 'restricted',
    `connection ${duringAttempt?.result?.connection}`,
  );
  check(
    'nothing from the attempt is stored',
    duringAttempt?.result?.page?.url === null && duringAttempt?.result?.page?.title === '',
    `url ${duringAttempt?.result?.page?.url}, title "${duringAttempt?.result?.page?.title}"`,
  );

  // Two tabs: a graded attempt in the active one must not inherit the other
  // tab's coursework workspace, and going back must restore it.
  const courseTab = await context.newPage();
  await courseTab.goto(`${ORIGIN}/d2l/home/999999?ou=999999`, { waitUntil: 'load' });
  await panel.waitForTimeout(900);
  const attemptTab = await context.newPage();
  await attemptTab.goto(`${ORIGIN}/d2l/lms/quizzing/user/attempt/201?ou=999999`, { waitUntil: 'load' });
  await attemptTab.bringToFront();
  await panel.waitForTimeout(900);
  const onAttemptTab = await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'get-state' }));
  check(
    'a second tab on a graded attempt does not inherit the first tab workspace',
    onAttemptTab?.result?.connection === 'restricted',
    `connection ${onAttemptTab?.result?.connection}`,
  );

  // What the worker answers is not what the student sees. Assert the rendered
  // panel: it must refresh itself when the observation changes, with no tab
  // event to prompt it.
  const renderedOnAttempt = await panel.innerText('body');
  check(
    'the rendered panel shows restricted mode beside a graded attempt',
    /Restricted mode/i.test(renderedOnAttempt) && !/Coursework workspace/i.test(renderedOnAttempt),
    renderedOnAttempt.replace(/\s+/g, ' ').slice(0, 120),
  );

  await courseTab.bringToFront();
  await panel.waitForTimeout(1_200);
  const backOnCourseTab = await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'get-state' }));
  check(
    'returning to the course tab restores its state',
    backOnCourseTab?.result?.connection === 'supported',
    `connection ${backOnCourseTab?.result?.connection}`,
  );
  check(
    'the rendered panel leaves restricted mode with it',
    !/Restricted mode/i.test(await panel.innerText('body')),
  );

  // A same-tab navigation into an attempt: the tab events fire before the
  // content script reports, so only an observation-driven refresh catches it.
  await courseTab.goto(`${ORIGIN}/d2l/lms/quizzing/user/attempt/201?ou=999999`, { waitUntil: 'load' });
  await panel.waitForTimeout(1_200);
  check(
    'navigating the same tab into an attempt reaches the rendered panel',
    /Restricted mode/i.test(await panel.innerText('body')),
    (await panel.innerText('body')).replace(/\s+/g, ' ').slice(0, 120),
  );
  await attemptTab.close();
  await courseTab.close();

  // The panel must name the state it is in, not fall back to the workspace.
  //
  // Both halves matter, and only asserting the first is what let a real defect
  // through: the worker reported `unsupported` and `signed-out` correctly while
  // the panel rendered the coursework workspace over both, because the bridge
  // recomputed the connection from whether a URL was present. A student on an
  // expired session was never told to sign in again.
  for (const [path, connection, rendered] of [
    ['/d2l/lp/whatever/unknown', 'unsupported', /Unsupported page/i],
    ['/d2l/home/424242?ou=424242', 'signed-out', /Your D2L session has ended/i],
    ['/d2l/home/999999?ou=999999', 'supported', /Coursework workspace/i],
  ]) {
    await page.goto(`${ORIGIN}${path}`, { waitUntil: 'load' });
    await panel.waitForTimeout(900);
    const current = await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'get-state' }));
    check(`${path} — panel connection state is ${connection}`, current?.result?.connection === connection, `got ${current?.result?.connection}`);

    const body = await panel.innerText('body');
    check(
      `${path} — the rendered panel says it is ${connection}`,
      rendered.test(body),
      body.replace(/\s+/g, ' ').slice(0, 120),
    );
    if (connection !== 'supported') {
      check(
        `${path} — the rendered panel does not offer the coursework workspace`,
        !/Coursework workspace/i.test(body),
      );
    }
  }

  // --- The redesign, the settings page and Prepare workspace, in a real browser. ---
  //
  // Every request from here on is recorded. The only host Motion may reach is
  // the synthetic LMS served above; fonts in particular are bundled, and a
  // font CDN request would tell a third party a student is using Motion.
  const offMachine = [];
  const recordRequest = (request) => {
    const url = request.url();
    if (!/^(?:chrome-extension|data|blob|about):/.test(url) && !url.startsWith(ORIGIN)) offMachine.push(url);
  };
  context.on('request', recordRequest);

  const settings = await context.newPage();
  await settings.goto(`chrome-extension://${extensionId}/src/options/index.html#privacy`, { waitUntil: 'load' });
  check(
    'the settings page opens on the section named in its address',
    await settings.getByRole('heading', { name: 'Privacy & data' }).isVisible(),
  );
  const sectionNames = await settings.getByRole('navigation', { name: 'Settings sections' }).getByRole('button').allInnerTexts();
  check('the settings page lists every rendered section', sectionNames.join('|') === 'AI|Browser access|Agent behaviour|Reminders|Privacy & data|About', sectionNames.join('|'));
  const serif = await settings.evaluate(async () => {
    const faces = await document.fonts.load('600 28px "Source Serif 4"');
    return {
      loaded: faces.length > 0 && faces.every((face) => face.status === 'loaded'),
      title: getComputedStyle(document.querySelector('h1')).fontFamily,
    };
  });
  check('the bundled serif loads and titles the settings page', serif.loaded && serif.title.includes('Source Serif 4'), JSON.stringify(serif));
  await settings.getByRole('button', { name: 'Reminders' }).click();
  const reminderOptIn = settings.getByRole('checkbox', { name: 'Send deadline reminders' });
  if (!(await reminderOptIn.isChecked())) {
    await reminderOptIn.click();
    await settings.waitForTimeout(800);
  }
  check('reminder opt-in toggle responds in the settings UI', await reminderOptIn.isChecked());
  await settings.reload({ waitUntil: 'load' });
  await settings.getByRole('heading', { name: 'Reminders' }).waitFor();
  check('reminder opt-in persists through the settings reload', await settings.getByRole('checkbox', { name: 'Send deadline reminders' }).isChecked());
  await settings.close();

  await page.bringToFront();
  await page.goto(`${ORIGIN}/d2l/home/999999?ou=999999`, { waitUntil: 'load' });
  await panel.waitForTimeout(1_200);
  check('the composer is offered on a readable course page', (await panel.locator('textarea').count()) === 1);
  const discoveryState = await getState();
  if (discoveryState?.result?.discovery?.optedIn === null) {
    await panel.getByRole('button', { name: 'Enable scanning' }).first().click();
    await panel.waitForTimeout(600);
  }
  const enabledDiscovery = await getState();
  check('deadline discovery requires and records explicit opt-in', enabledDiscovery?.result?.discovery?.optedIn === true);
  await panel.getByRole('button', { name: 'Scan all courses' }).first().click();
  let discovered = await getState();
  for (let attempt = 0; attempt < 60 && (discovered?.result?.discovery?.result?.deadlines ?? 0) < 2; attempt += 1) {
    await panel.waitForTimeout(250);
    discovered = await getState();
  }
  const discoveredTasks = discovered?.result?.tasks ?? [];
  check(
    'synthetic course discovery stores canonical high-confidence deadlines',
    discovered?.result?.discovery?.result?.courses === 1 &&
      discoveredTasks.some((task) => task.title === 'Chapter 1 Quiz' && task.courseId === 'd2l:101' && task.due?.confidence === 'high' && task.provenance?.strategy === 'lms-api') &&
      discoveredTasks.some((task) => task.title === 'Discussion 1' && task.courseId === 'd2l:101'),
    `${discovered?.result?.discovery?.result?.courses ?? 0} course(s), ${discoveredTasks.length} task(s)`,
  );
  // `exact` matters: the "What's due this week?" suggestion chip is also a
  // button whose accessible name contains "Week", and role-name matching is
  // substring-based, so a loose selector starts a chat session instead of
  // switching the deadline view.
  await panel.getByRole('button', { name: 'Week', exact: true }).first().click();
  const weekText = await panel.innerText('body');
  check('deadline week view shows this week and later without uncertainty labels', /This week/i.test(weekText) && /Later/i.test(weekText) && !/Needs review/i.test(weekText));
  await page.goto(`${ORIGIN}/d2l/lms/quizzing/user/attempt/201?ou=999999`, { waitUntil: 'load' });
  await panel.waitForTimeout(1_200);
  const restrictedBody = await panel.innerText('body');
  const restrictedControls = await panel.locator('button, a, textarea, input, select, form').allInnerTexts();
  check(
    'restricted mode explains the boundary and offers no page action affordance',
    /Restricted mode/i.test(restrictedBody) &&
      /will not read this page|will not .*draft/i.test(restrictedBody) &&
      restrictedControls.every((text) => !/read|draft|act|capture|submit|send|fill|click/i.test(text)),
    `${restrictedControls.join('|')} — ${restrictedBody.replace(/\s+/g, ' ').slice(0, 180)}`,
  );

  // Chrome creates the group here, and closing it must close Motion's tab and
  // leave the student's.
  await page.goto(`${ORIGIN}/d2l/lms/dropbox/user/folder_submit_files.d2l?ou=363&db=101`, { waitUntil: 'load' });
  await panel.waitForTimeout(1_200);
  const prepared = await panel.evaluate(async (origin) => {
    const [tab] = await chrome.tabs.query({ url: `${origin}/d2l/lms/dropbox/*` });
    const reply = await chrome.runtime.sendMessage({ type: 'prepare-workspace', tabId: tab.id });
    await new Promise((done) => setTimeout(done, 1_500));
    const group = (await chrome.tabGroups.query({})).find((candidate) => candidate.title?.startsWith('Motion'));
    const members = group ? await chrome.tabs.query({ groupId: group.id }) : [];
    return { reply, studentTabId: tab.id, title: group?.title ?? null, members: members.map((member) => ({ id: member.id, url: member.url })) };
  }, ORIGIN);
  check(
    'Prepare workspace creates a titled Motion tab group in a real browser',
    typeof prepared.reply?.result?.workflowId === 'string' && /^Motion · /.test(prepared.title ?? '') && prepared.members.length > 0,
    `${prepared.title} with ${prepared.members.length} tab(s); ${JSON.stringify(prepared.reply).slice(0, 160)}`,
  );
  // Asserted by tab id, not by the `motion_op` marker in the URL: a redirect can
  // drop the marker (docs/THREAT_MODEL.md T14), and ownership is recorded by id.
  check(
    'the group holds only tabs Motion opened, never the student’s tab',
    prepared.members.length > 0 && prepared.members.every((member) => member.id !== prepared.studentTabId),
    prepared.members.map((member) => `${member.id} ${member.url}`).join(', '),
  );

  const closed = await panel.evaluate(async ({ workflowId, studentTabId }) => {
    const reply = await chrome.runtime.sendMessage({ type: 'close-workspace', workflowId });
    const student = await chrome.tabs.get(studentTabId).catch(() => null);
    const groups = await chrome.tabGroups.query({});
    return { reply, studentStillOpen: Boolean(student), motionGroups: groups.filter((group) => group.title?.startsWith('Motion')).length };
  }, { workflowId: prepared.reply?.result?.workflowId, studentTabId: prepared.studentTabId });
  check(
    'closing the workspace closes Motion’s tabs and leaves the student’s tab open',
    closed.reply?.result?.closed === prepared.members.length && closed.studentStillOpen && closed.motionGroups === 0,
    JSON.stringify(closed),
  );

  // --- Lifecycle, timing and state regressions. ---
  // These use separate tab ids and explicit observations so a passing check
  // cannot be explained by whichever page happened to report most recently.

  await page.goto(`${ORIGIN}/d2l/home/999999?ou=999999`, { waitUntil: 'load' });
  await page.bringToFront();
  const spaMarkup = fixture('e2e-assignment-list');
  await page.evaluate((markup) => {
    const parsed = new DOMParser().parseFromString(markup, 'text/html');
    history.pushState({}, '', '/d2l/lms/dropbox/user/folders_list.d2l?ou=999999&spa=1');
    document.body.replaceChildren(...Array.from(parsed.body.childNodes));
  }, spaMarkup);
  const spaTabId = await activeTabId();
  await panel.waitForTimeout(1_600);
  const spaObservation = spaTabId === null ? null : await getObservation(spaTabId);
  const spaState = await getState();
  check(
    'SPA navigation updates the stored observation and panel page type',
    spaObservation?.pageType === 'assignment-list' && spaState?.result?.page?.pageType === 'assignment-list',
    `stored ${spaObservation?.pageType}, panel ${spaState?.result?.page?.pageType}`,
  );

  const delayedPage = await context.newPage();
  await delayedPage.goto(`${ORIGIN}/d2l/lms/dropbox/user/folders_list.d2l?ou=999999&delayed=1`, { waitUntil: 'load' });
  await delayedPage.bringToFront();
  await delayedPage.waitForTimeout(2_300);
  const delayedTabId = await activeTabId();
  const delayedRequest = delayedTabId === null ? null : await requestExtractionForTab(delayedTabId);
  await panel.waitForTimeout(900);
  const delayedState = await getState();
  const delayedTasks = (delayedState?.result?.tasks ?? []).filter(
    // sourceUrl is canonical (query stripped), so the rows are told apart by the
    // due dates only this fixture uses.
    (task) => task.courseId === 'd2l:999999' && task.title === 'Example Assignment' && /^2099-0[12]-2/.test(task.due?.iso ?? ''),
  );
  check(
    'delayed rendering yields one extracted task per rendered row',
    delayedRequest?.result?.requested === true && delayedTasks.length === 2,
    `request ${delayedRequest?.result?.requested}, tasks ${delayedTasks.length}`,
  );

  const courseTab1 = await context.newPage();
  await courseTab1.goto(`${ORIGIN}/d2l/home/999999?ou=999999`, { waitUntil: 'load' });
  await courseTab1.bringToFront();
  const courseTab1Id = await activeTabId();
  const courseTab1Request = courseTab1Id === null ? null : await requestExtractionForTab(courseTab1Id);
  const courseTab2 = await context.newPage();
  await courseTab2.goto(`${ORIGIN}/d2l/home/888888?ou=888888`, { waitUntil: 'load' });
  await courseTab2.bringToFront();
  const courseTab2Id = await activeTabId();
  const courseTab2Request = courseTab2Id === null ? null : await requestExtractionForTab(courseTab2Id);
  await panel.waitForTimeout(900);
  await courseTab1.bringToFront();
  await panel.waitForTimeout(450);
  const courseTab1State = await getState();
  await courseTab2.bringToFront();
  await panel.waitForTimeout(450);
  const courseTab2State = await getState();
  check(
    'active tabs retain their own extracted course context',
    courseTab1Request?.result?.requested === true && courseTab2Request?.result?.requested === true &&
      courseTab1State?.result?.course?.externalId === '999999' && courseTab1State?.result?.course?.code === 'CS101' &&
      courseTab2State?.result?.course?.externalId === '888888' && courseTab2State?.result?.course?.code === 'CS202',
    `tab 1 ${courseTab1State?.result?.course?.externalId ?? 'none'}, tab 2 ${courseTab2State?.result?.course?.externalId ?? 'none'}`,
  );

  await courseTab1.goto(`${ORIGIN}/d2l/home`, { waitUntil: 'load' });
  await courseTab1.bringToFront();
  await panel.waitForTimeout(900);
  const dashboardState = await getState();
  check(
    'dashboard navigation clears the active course context',
    dashboardState?.result?.course === null,
    `course ${dashboardState?.result?.course?.externalId ?? dashboardState?.result?.course?.name ?? 'null'}`,
  );

  const prefixPage = await context.newPage();
  await prefixPage.goto(`${ORIGIN}/d2l/home/1234?ou=1234`, { waitUntil: 'load' });
  await prefixPage.bringToFront();
  const prefixShortId = await activeTabId();
  if (prefixShortId !== null) await requestExtractionForTab(prefixShortId);
  await panel.waitForTimeout(500);
  await prefixPage.goto(`${ORIGIN}/d2l/home/12345?ou=12345`, { waitUntil: 'load' });
  await prefixPage.bringToFront();
  const prefixLongId = await activeTabId();
  if (prefixLongId !== null) await requestExtractionForTab(prefixLongId);
  await panel.waitForTimeout(700);
  await prefixPage.bringToFront();
  const prefixState = await getState();
  const prefixCourseIds = await storedCourseExternalIds();
  check(
    'course IDs that are prefixes resolve to the exact stored course',
    prefixCourseIds.includes('1234') && prefixCourseIds.includes('12345') && prefixState?.result?.course?.externalId === '12345',
    `stored ${prefixCourseIds.join(',')}, panel ${prefixState?.result?.course?.externalId ?? 'none'}`,
  );

  const headingPage = await context.newPage();
  await headingPage.goto(`${ORIGIN}/d2l/lp/ouHome/home?ou=999999`, { waitUntil: 'load' });
  await headingPage.bringToFront();
  const headingTabId = await activeTabId();
  const headingRequest = headingTabId === null ? null : await requestExtractionForTab(headingTabId);
  await headingPage.bringToFront();
  await panel.waitForTimeout(700);
  const headingState = await getState();
  check(
    'course home heading and title produce the course name',
    headingRequest?.result?.requested === true && headingState?.result?.course?.name === 'CS101 Example Course' &&
      headingState?.result?.course?.name !== 'Homepage',
    `course ${headingState?.result?.course?.name ?? 'none'}`,
  );

  const stopServiceWorker = async () => {
    const cdp = await context.newCDPSession(page);
    const targets = await cdp.send('Target.getTargets');
    const target = targets.targetInfos.find(
      (candidate) => candidate.type === 'service_worker' && candidate.url.startsWith(`chrome-extension://${extensionId}/`),
    );
    if (!target) throw new Error('extension service-worker target not found');
    await cdp.send('Target.closeTarget', { targetId: target.targetId });
    return target.url;
  };
  let stoppedWorker = '';
  try {
    stoppedWorker = await stopServiceWorker();
  } catch (error) {
    stoppedWorker = error instanceof Error ? error.message : String(error);
  }
  await panel.waitForTimeout(300);
  const restartedState = await getState();
  check(
    'service-worker restart preserves active page type and course',
    stoppedWorker.startsWith('chrome-extension://') && restartedState?.result?.page?.pageType === 'course-home' &&
      restartedState?.result?.course?.externalId === '999999',
    `${stoppedWorker || 'not stopped'}; page ${restartedState?.result?.page?.pageType}, course ${restartedState?.result?.course?.externalId ?? 'none'}`,
  );

  const slowPage = await context.newPage();
  await slowPage.goto(`${ORIGIN}/d2l/lp/ouHome/home?ou=999999&slow=1`, { waitUntil: 'load' });
  await slowPage.bringToFront();
  const slowTabId = await activeTabId();
  const slowObservationTypes = [];
  for (let sample = 0; sample < 14; sample += 1) {
    if (slowTabId !== null) slowObservationTypes.push((await getObservation(slowTabId))?.pageType ?? null);
    await panel.waitForTimeout(250);
  }
  const slowState = await getState();
  check(
    'a slow course page with a login redirect script is not signed out',
    slowObservationTypes.includes('course-home') && !slowObservationTypes.includes('signed-out') &&
      slowState?.result?.connection !== 'signed-out',
    `observed ${slowObservationTypes.join(',')}; connection ${slowState?.result?.connection}`,
  );

  await slowPage.goto(`${ORIGIN}/d2l/home/999999?ou=999999`, { waitUntil: 'load' });
  await slowPage.bringToFront();
  await panel.waitForTimeout(700);
  await slowPage.evaluate(() => {
    history.pushState({}, '', '/d2l/home/999999?ou=999999&sessionExpired=1');
    document.body.innerHTML = '<script>window.location.replace(\'/d2l/login?sessionExpired=0\')</script>';
  });
  const expiryTabId = await activeTabId();
  await panel.waitForTimeout(1_100);
  const expiryObservation = expiryTabId === null ? null : await getObservation(expiryTabId);
  const expiryState = await getState();
  check(
    'SPA session expiry surfaces signed-out state',
    expiryObservation?.pageType === 'signed-out' && expiryState?.result?.connection === 'signed-out',
    `stored ${expiryObservation?.pageType}, connection ${expiryState?.result?.connection}`,
  );

  await delayedPage.close();
  await courseTab1.close();
  await courseTab2.close();
  await prefixPage.close();
  await headingPage.close();
  await slowPage.close();

  context.off('request', recordRequest);
  check('no request left the machine except to the synthetic LMS', offMachine.length === 0, offMachine.slice(0, 3).join(', '));

  check('side panel raised no uncaught error', panelErrors.length === 0, panelErrors.join('; ').slice(0, 300));
  check('service worker logged no error', workerErrors.length === 0, workerErrors.join('; ').slice(0, 300));
} finally {
  await context.close();
  await rm(userDataDir, { recursive: true, force: true });
}

console.log(`\n${total - failures}/${total} checks passed`);
process.exit(failures === 0 ? 0 : 1);
