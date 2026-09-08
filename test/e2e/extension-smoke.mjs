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
  { path: '/d2l/lp/whatever/unknown', fixture: 'broken', expect: 'unsupported' },
  // The document a signed-out D2L serves for any route.
  { path: '/d2l/home/424242?ou=424242', fixture: 'signed-out-redirect', expect: 'signed-out' },
];

const userDataDir = await mkdtemp(join(tmpdir(), 'motion-e2e-'));
const context = await chromium.launchPersistentContext(userDataDir, {
  executablePath,
  headless: true,
  args: [`--disable-extensions-except=${distPath}`, `--load-extension=${distPath}`],
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
    const path = new URL(route.request().url()).pathname;
    const match = ROUTES.find((candidate) => new URL(candidate.path, ORIGIN).pathname === path);
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
  for (const [path, connection] of [
    ['/d2l/lp/whatever/unknown', 'unsupported'],
    ['/d2l/home/424242?ou=424242', 'signed-out'],
    ['/d2l/home/999999?ou=999999', 'supported'],
  ]) {
    await page.goto(`${ORIGIN}${path}`, { waitUntil: 'load' });
    await panel.waitForTimeout(900);
    const current = await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'get-state' }));
    check(`${path} — panel connection state is ${connection}`, current?.result?.connection === connection, `got ${current?.result?.connection}`);
  }

  check('side panel raised no uncaught error', panelErrors.length === 0, panelErrors.join('; ').slice(0, 300));
  check('service worker logged no error', workerErrors.length === 0, workerErrors.join('; ').slice(0, 300));
} finally {
  await context.close();
  await rm(userDataDir, { recursive: true, force: true });
}

console.log(`\n${total - failures}/${total} checks passed`);
process.exit(failures === 0 ? 0 : 1);
