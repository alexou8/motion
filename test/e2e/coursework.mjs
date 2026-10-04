/** Built MV3 coursework flow. All page data is synthetic; all network access is blocked. */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { chromium } from 'playwright';

const root = resolve(import.meta.dirname, '../..');
const dist = join(root, 'dist');
const ORIGIN = 'https://mylearningspace.wlu.ca';
const fixture = (name) => readFileSync(join(root, 'src/test/fixtures/d2l', `${name}.html`), 'utf8');
const screenshots = process.env.MOTION_SCREENSHOTS_DIR;
const profile = await mkdtemp(join(tmpdir(), 'motion-coursework-'));
const executablePath =
  process.env.MOTION_CHROME ??
  (existsSync('/opt/pw-browsers/chromium')
    ? '/opt/pw-browsers/chromium'
    : chromium.executablePath());
const context = await chromium.launchPersistentContext(profile, {
  executablePath,
  headless: true,
  viewport: { width: 400, height: 1050 },
  args: [
    `--disable-extensions-except=${dist}`,
    `--load-extension=${dist}`,
    '--host-resolver-rules=MAP * ~NOTFOUND',
  ],
});
let checks = 0;
function check(label, condition) {
  assert.ok(condition, label);
  checks += 1;
  console.log(`PASS ${label}`);
}
async function until(read, accept, label) {
  const end = Date.now() + 10_000;
  let last;
  while (Date.now() < end) {
    const value = await read();
    last = value;
    if (accept(value)) return value;
    await new Promise((done) => setTimeout(done, 100));
  }
  const detail = typeof last === 'string' ? last.slice(0, 200) : last?.connection;
  throw new Error(`Timed out: ${label}; last value: ${JSON.stringify(detail)}`);
}

try {
  await context.route('https://**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === 'https://example.test')
      return route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><title>Synthetic unrelated page</title><main>Unrelated page</main>',
      });
    if (url.origin !== ORIGIN) return route.abort();
    let name;
    if (url.pathname.includes('/content/')) name = 'mylearningspace-content-module';
    if (url.pathname.includes('/folders_list.d2l')) name = 'mylearningspace-assignment-list';
    if (url.pathname.includes('/quizzes_list.d2l')) name = 'quiz-list';
    if (url.pathname.includes('/attempt/')) name = 'quiz-attempt';
    return route.fulfill({
      status: name ? 200 : 404,
      contentType: 'text/html',
      body: name ? fixture(name) : '<title>Synthetic unavailable route</title>',
    });
  });
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  const panel = await context.newPage();
  async function setTheme(colorScheme) {
    await panel.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
    const expected = colorScheme === 'dark' ? 'rgb(31, 30, 28)' : 'rgb(248, 246, 241)';
    await until(
      () => panel.evaluate(() => getComputedStyle(document.body).backgroundColor),
      (color) => color === expected,
      `${colorScheme} palette rendered`,
    );
  }
  const errors = [];
  panel.on('pageerror', (error) => errors.push(error.message));
  await panel.goto(`chrome-extension://${extensionId}/src/sidepanel/index.html`);
  const page = await context.newPage();
  const getState = async () =>
    (await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'get-state' })))?.result;
  async function read(path, title) {
    await page.goto(`${ORIGIN}${path}`);
    await page.bringToFront();
    await until(
      getState,
      (state) =>
        state?.connection === 'supported' &&
        state.page.url?.includes(new URL(path, ORIGIN).pathname),
      'supported page observation',
    );
    const requested = await panel.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      return chrome.runtime.sendMessage({ type: 'request-extraction', tabId: tab.id });
    });
    assert.equal(requested?.result?.requested, true);
    await until(
      getState,
      (state) => state?.tasks.some((task) => task.title === title),
      'extracted coursework',
    );
  }
  await read('/d2l/lms/dropbox/user/folders_list.d2l?ou=999999', 'Relational Algebra Worksheet');
  await read('/d2l/lms/quizzing/user/quizzes_list.d2l?ou=999999', 'SQL Concepts Check');
  await read('/d2l/le/content/999999/Home', 'Example Slides One');
  const stored = await getState();
  const materials = stored.tasks.filter((task) => task.kind === 'content');
  check(
    'resource titles do not imply completed status',
    materials.every((task) => task.status === 'todo'),
  );
  check(
    'module extraction persists three undated resources and one dated reading',
    materials.length === 4 &&
      materials.filter((task) => task.due.iso === null && task.due.raw === '').length === 3,
  );
  check(
    'undated resources never become deadline warnings',
    Object.values(stored.deadlines)
      .flat()
      .every(
        (id) => !materials.filter((task) => task.due.iso === null).some((task) => task.id === id),
      ),
  );
  await panel.getByRole('button', { name: /Coursework \d+/ }).click();
  await panel.getByRole('heading', { name: 'Your coursework' }).waitFor();
  check(
    'navigation moves keyboard focus to the new content',
    await panel.getByRole('main').evaluate((element) => element === document.activeElement),
  );
  await panel.getByRole('button', { name: 'Materials', exact: true }).click();
  await until(
    () => panel.getByRole('status').innerText(),
    (text) => text.trim() === '4 items',
    'material results rendered',
  );
  check(
    'material filter shows saved lecture titles and honest no-deadline labels',
    (await panel.getByText('No deadline', { exact: true }).count()) === 3 &&
      (await panel.getByRole('status').innerText()).startsWith('4 items'),
  );
  await panel.getByLabel('Search coursework').fill('slides');
  await until(
    () => panel.getByRole('status').innerText(),
    (text) => text.trim() === '2 items',
    'search result count',
  );
  check(
    'search narrows saved slide decks',
    (await panel.getByRole('heading', { name: /Example Slides/ }).count()) === 2,
  );
  await panel.getByLabel('Search coursework').fill('does not exist');
  await panel.getByText(/No coursework matches/).waitFor();
  check(
    'empty search explains how to recover',
    (await panel.getByRole('status').innerText()) === '0 items',
  );
  await panel.getByRole('button', { name: 'Reset filters' }).click();
  await panel.getByRole('button', { name: 'Quizzes', exact: true }).click();
  check(
    'quiz filter retains the tracked quiz without opening an attempt',
    await panel.getByRole('heading', { name: 'SQL Concepts Check' }).isVisible(),
  );
  await panel.getByRole('button', { name: 'Materials', exact: true }).click();
  await page.goto('https://example.test/blank');
  await page.bringToFront();
  await panel.getByText(/Showing saved coursework/).waitFor();
  check(
    'saved resources remain usable away from the LMS',
    await panel.getByRole('heading', { name: 'Example Slides One' }).isVisible(),
  );

  if (screenshots) {
    await mkdir(screenshots, { recursive: true });
    await setTheme('light');
    await panel.screenshot({ path: join(screenshots, 'coursework-light.png') });
    await setTheme('dark');
    await panel.screenshot({ path: join(screenshots, 'coursework-dark.png') });
  }
  if (process.env.MOTION_AXE_PATH) {
    await panel.evaluate(readFileSync(process.env.MOTION_AXE_PATH, 'utf8'));
    for (const colorScheme of ['light', 'dark']) {
      await setTheme(colorScheme);
      const violations = await panel.evaluate(async () => {
        const result = await axe.run(document, {
          runOnly: {
            type: 'tag',
            values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa', 'best-practice'],
          },
        });
        return result.violations.map((item) => ({
          id: item.id,
          impact: item.impact,
          nodes: item.nodes.map((node) => node.target),
        }));
      });
      check(
        `${colorScheme} coursework has no axe accessibility violations`,
        violations.length === 0 || (console.log(JSON.stringify(violations)), false),
      );
    }
  }
  for (const width of [360, 180]) {
    await panel.setViewportSize({ width, height: 900 });
    check(
      `coursework reflows at ${width}px (180px represents 200% zoom at the panel floor)`,
      await panel.evaluate(
        () =>
          document.documentElement.scrollWidth <= innerWidth &&
          document.querySelector('main').scrollWidth <= innerWidth,
      ),
    );
  }
  await panel.setViewportSize({ width: 400, height: 1050 });
  await panel.reload();
  const skip = panel.getByRole('link', { name: 'Skip to content' });
  await panel.keyboard.press('Tab');
  check(
    'skip link is the first keyboard stop',
    await skip.evaluate((element) => element === document.activeElement),
  );
  await panel.keyboard.press('Enter');
  check(
    'skip link focuses main content',
    await panel.getByRole('main').evaluate((element) => element === document.activeElement),
  );
  await panel.getByRole('button', { name: /Coursework \d+/ }).click();
  check(
    'resources survive a side panel reload',
    await panel.getByRole('heading', { name: 'Example Slides One' }).isVisible(),
  );
  await page.goto(`${ORIGIN}/d2l/lms/quizzing/user/attempt/201?ou=999999`);
  await page.bringToFront();
  await panel.getByRole('heading', { name: 'Restricted mode' }).waitFor();
  check(
    'a graded attempt removes saved-source and coursework affordances',
    (await panel.getByRole('navigation').count()) === 0 &&
      (await panel.getByRole('heading', { name: 'Example Slides One' }).count()) === 0 &&
      (await panel.getByRole('textbox').count()) === 0,
  );
  check('the panel raises no uncaught errors', errors.length === 0);
  console.log(`${checks}/${checks} coursework checks passed`);
} finally {
  await context.close();
  await rm(profile, { recursive: true, force: true });
}
