/** Built MV3 document flow. Fixtures are synthetic and all external networking is blocked. */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

const root = resolve(import.meta.dirname, '../..');
const dist = join(root, 'dist');
const fixtures = join(root, 'test/fixtures/documents');
const origin = 'https://mylearningspace.wlu.ca';
const topic = `${origin}/d2l/le/content/999999/viewContent/999001/View`;
const pdfUrl = '/content/enforced/999999-SYNTHETIC/Synthetic%20lecture.pdf?ou=999999';
const pptxUrl = '/content/enforced/999999-SYNTHETIC/Synthetic.pptx?ou=999999';
const html = `<!doctype html><html lang="en"><title>Synthetic Lecture - Synthetic Course</title><body><main><h1>Synthetic Lecture</h1><iframe title="Synthetic lecture PDF" src="/d2l/common/assets/pdfjs-d2l-dist/web/viewer.html?file=${encodeURIComponent(pdfUrl)}"></iframe><a href="${pptxUrl}">Synthetic PowerPoint</a></main></body></html>`;
const profile = await mkdtemp(join(tmpdir(), 'motion-documents-'));
const context = await chromium.launchPersistentContext(profile, {
  executablePath:
    process.env.MOTION_CHROME ??
    (existsSync('/opt/pw-browsers/chromium')
      ? '/opt/pw-browsers/chromium'
      : chromium.executablePath()),
  headless: true,
  viewport: { width: 400, height: 1100 },
  args: [
    `--disable-extensions-except=${dist}`,
    `--load-extension=${dist}`,
    '--host-resolver-rules=MAP * ~NOTFOUND',
  ],
});
let checks = 0;
const errors = [];
let fileFetches = 0;
const check = (label, condition) => {
  assert.ok(condition, label);
  checks += 1;
  console.log(`PASS ${label}`);
};
async function until(read, accept, label) {
  const end = Date.now() + 45_000;
  while (Date.now() < end) {
    const value = await read();
    if (accept(value)) return value;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`Timed out: ${label}`);
}

try {
  await context.route('https://**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === 'https://example.test')
      return route.fulfill({
        contentType: 'text/html',
        body: '<title>Synthetic off-LMS page</title><main>Synthetic</main>',
      });
    if (url.origin !== origin) return route.abort();
    if (url.pathname === '/content/enforced/999999-SYNTHETIC/Synthetic%20lecture.pdf') {
      fileFetches += 1;
      return route.fulfill({
        contentType: 'application/pdf',
        body: readFileSync(join(fixtures, 'synthetic-lecture.pdf')),
      });
    }
    if (url.pathname === '/content/enforced/999999-SYNTHETIC/Synthetic.pptx') {
      fileFetches += 1;
      return route.fulfill({
        contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        body: readFileSync(join(fixtures, 'synthetic-slides.pptx')),
      });
    }
    if (url.pathname.includes('/attempt/'))
      return route.fulfill({
        contentType: 'text/html',
        body: readFileSync(join(root, 'src/test/fixtures/d2l/quiz-attempt.html'), 'utf8'),
      });
    return route.fulfill({
      contentType: 'text/html',
      body: url.pathname.includes('viewContent')
        ? html
        : '<title>Synthetic embedded viewer</title>',
    });
  });
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  const panel = await context.newPage();
  panel.on('pageerror', (error) => errors.push(error.message));
  await panel.goto(`chrome-extension://${id}/src/sidepanel/index.html`);
  const page = await context.newPage();
  await page.goto(topic);
  await page.bringToFront();
  const ask = (message) =>
    panel.evaluate((payload) => chrome.runtime.sendMessage(payload), message);
  const list = async () => (await ask({ type: 'get-documents' }))?.result?.documents ?? [];
  const read = async (documentId) =>
    (await ask({ type: 'get-document', id: documentId }))?.result?.document;
  await until(
    async () => (await ask({ type: 'get-state' }))?.result?.connection,
    (value) => value === 'supported',
    'supported topic',
  );
  await panel.getByRole('button', { name: 'Library', exact: true }).click();
  await panel.getByRole('heading', { name: 'Your material library' }).waitFor();
  check(
    'library starts empty without downloading any course files',
    (await list()).length === 0 && fileFetches === 0,
  );
  await panel.getByRole('button', { name: 'Find files on this page' }).click();
  const sources = panel.getByRole('list', { name: 'Files on this page' });
  await sources.waitFor();
  check(
    'observed embedded PDF and PowerPoint appear as source choices',
    (await sources.getByRole('button', { name: /^Index / }).count()) === 2,
  );
  await sources.getByRole('button', { name: /^Index .*PDF/ }).click();
  const remotePdf = await until(
    list,
    (items) => items.some((item) => item.format === 'pdf'),
    'PDF indexed through the source handle',
  );
  const pdf = await read(remotePdf.find((item) => item.format === 'pdf').id);
  check(
    'bundled PDF worker extracts selectable text and Unicode',
    pdf.units.length === 2 &&
      pdf.units[0].text.includes('Café') &&
      pdf.units[1].text.includes('spaced repetition'),
  );
  check(
    'LMS index retains its actual topic and resource provenance',
    pdf.sourcePageUrl === topic && pdf.sourceUrl === `${origin}${pdfUrl}`,
  );
  check('indexing downloads only the selected observed PDF', fileFetches === 1);
  await panel.getByLabel('Search document text').fill('spaced repetition');
  await panel.getByRole('button', { name: 'Search library' }).click();
  await panel.getByText('Page 2', { exact: true }).waitFor();
  check(
    'full-text search identifies the matching PDF page',
    await panel.getByText(/Synthetic page two: spaced repetition/).isVisible(),
  );
  await panel.getByRole('button', { name: `Read text from ${pdf.title}`, exact: true }).click();
  await panel.getByLabel('Page', { exact: true }).waitFor();
  check(
    'text preview opens at the search match and moves keyboard focus',
    (await panel.getByLabel('Page', { exact: true }).inputValue()) === '2' &&
      (await panel
        .getByRole('heading', { name: `Text from ${pdf.title}` })
        .evaluate((element) => element === document.activeElement)),
  );
  await panel.getByRole('button', { name: 'Close text preview' }).click();
  await panel.getByLabel('Search document text').fill('');
  await panel.getByRole('button', { name: 'Search library' }).click();
  await panel.getByRole('button', { name: 'Find files on this page' }).click();
  await sources.getByRole('button', { name: 'Index Synthetic PowerPoint', exact: true }).click();
  const remoteSlides = await until(
    list,
    (items) => items.some((item) => item.format === 'pptx'),
    'slides indexed through source handle',
  );
  const slides = await read(remoteSlides.find((item) => item.format === 'pptx').id);
  check(
    'PowerPoint text follows presentation order and preserves Unicode',
    slides.units[0].text === 'Synthetic first slide: retrieval practice.' &&
      slides.units[1].text.includes('café & Unicode 🎓'),
  );
  check(
    'speaker notes and embedded content are excluded',
    slides.units.every((unit) => !unit.text.includes('speaker notes')),
  );
  await panel.getByRole('button', { name: 'Find files on this page' }).click();
  await sources.getByRole('button', { name: /^Index .*PDF/ }).click();
  await until(
    async () => (await panel.getByRole('status').allTextContents()).join(' '),
    (text) => text.includes('pages indexed locally'),
    'reindex complete',
  );
  check('reindexing one LMS source updates its existing index', (await list()).length === 2);

  await page.goto('https://example.test/blank');
  await page.bringToFront();
  const choose = panel.getByLabel('Choose a PDF or PowerPoint');
  await choose.setInputFiles(join(fixtures, 'synthetic-image-only.pdf'));
  await until(list, (items) => items.length === 3, 'image-only PDF recorded');
  await panel.getByText(/No selectable text was found/).waitFor();
  check(
    'image-only PDF explicitly reports missing text rather than fabricated content',
    (await list()).find((item) => item.title === 'synthetic-image-only.pdf')?.hasText === false,
  );
  await choose.setInputFiles(join(fixtures, 'synthetic-corrupt.pdf'));
  await panel
    .getByRole('alert')
    .filter({ hasText: /PDF.*corrupt/ })
    .waitFor();
  check('corrupt PDF reports an error and creates no index', (await list()).length === 3);
  await choose.setInputFiles(join(fixtures, 'synthetic-malicious-xml.pptx'));
  await panel
    .getByRole('alert')
    .filter({ hasText: /PowerPoint.*corrupt/ })
    .waitFor();
  check('unsafe slide XML is rejected without storing a document', (await list()).length === 3);
  await choose.setInputFiles(join(fixtures, 'synthetic-slides.pptx'));
  await until(list, (items) => items.length === 4, 'local slides imported');
  check(
    'downloaded files can be indexed away from the LMS',
    (await list()).some(
      (item) => item.title === 'synthetic-slides.pptx' && item.sourceUrl === null,
    ),
  );
  await panel.reload();
  await panel.getByRole('button', { name: 'Library', exact: true }).click();
  await panel.getByRole('heading', { name: 'synthetic-slides.pptx', exact: true }).waitFor();
  check('library survives extension document reloads', (await list()).length === 4);
  await panel.getByRole('button', { name: 'Remove synthetic-slides.pptx', exact: true }).click();
  await until(list, (items) => items.length === 3, 'local index removed');
  check('removing an index retains other documents', (await list()).length === 3);
  await panel.getByLabel('Search document text').fill('retrieval practice');
  await panel.getByRole('button', { name: 'Search library' }).click();
  await panel.getByText('Slide 1', { exact: true }).waitFor();

  if (process.env.MOTION_SCREENSHOTS_DIR || process.env.MOTION_AXE_PATH) {
    if (process.env.MOTION_SCREENSHOTS_DIR)
      await mkdir(process.env.MOTION_SCREENSHOTS_DIR, { recursive: true });
    if (process.env.MOTION_AXE_PATH)
      await panel.evaluate(readFileSync(process.env.MOTION_AXE_PATH, 'utf8'));
    for (const theme of ['light', 'dark']) {
      await panel.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
      await until(
        () => panel.evaluate(() => getComputedStyle(document.body).backgroundColor),
        (color) => color === (theme === 'dark' ? 'rgb(31, 30, 28)' : 'rgb(248, 246, 241)'),
        `${theme} palette`,
      );
      if (process.env.MOTION_SCREENSHOTS_DIR)
        await panel.screenshot({
          path: join(process.env.MOTION_SCREENSHOTS_DIR, `library-${theme}.png`),
        });
      if (process.env.MOTION_AXE_PATH) {
        const violations = await panel.evaluate(async () =>
          (
            await axe.run(document, {
              runOnly: {
                type: 'tag',
                values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa', 'best-practice'],
              },
            })
          ).violations.map((item) => item.id),
        );
        check(
          `${theme} library has no scoped axe accessibility violations`,
          violations.length === 0 || (console.log(violations), false),
        );
      }
    }
  }
  for (const width of [360, 180]) {
    await panel.setViewportSize({ width, height: 1100 });
    check(
      `library reflows at ${width}px`,
      await panel.evaluate(
        () =>
          document.documentElement.scrollWidth <= innerWidth &&
          document.querySelector('main').scrollWidth <= innerWidth,
      ),
    );
  }
  if (process.env.MOTION_REAL_DOCUMENT_PATH) {
    await choose.setInputFiles({
      name: 'Private lecture verification.pdf',
      mimeType: 'application/pdf',
      buffer: readFileSync(process.env.MOTION_REAL_DOCUMENT_PATH),
    });
    const privateItems = await until(
      list,
      (items) => items.some((item) => item.title === 'Private lecture verification.pdf'),
      'private lecture indexed',
    );
    const privateDocument = await read(
      privateItems.find((item) => item.title === 'Private lecture verification.pdf').id,
    );
    check(
      'a PDF downloaded from the authenticated LMS indexes successfully in the built extension',
      privateDocument.totalUnits > 0 &&
        privateDocument.units.some((unit) => unit.text.trim().length > 0),
    );
    console.log(
      `Private PDF verification: ${privateDocument.units.length}/${privateDocument.totalUnits} pages, ${privateDocument.units.reduce((sum, unit) => sum + unit.text.length, 0)} characters; content is not logged or saved in fixtures.`,
    );
    await ask({ type: 'delete-document', id: privateDocument.id });
  }
  const staleImport = await ask({ type: 'begin-document-import' });
  const deletion = await ask({ type: 'delete-local-data', confirm: 'DELETE' });
  assert.equal(deletion.ok, true, 'explicit local data deletion must succeed');
  await until(list, (items) => items.length === 0, 'all local indexes removed');
  await panel.getByText('No indexed documents match. Add a file or try another search.').waitFor();
  check('deleting local data clears the persisted library and live panel', deletion.ok === true);
  const staleCommit = await ask({
    type: 'store-document-local',
    token: staleImport.result.token,
    title: 'Synthetic stale import.pdf',
    courseId: null,
    parsed: {
      format: pdf.format,
      units: pdf.units,
      totalUnits: pdf.totalUnits,
      truncated: pdf.truncated,
      warnings: pdf.warnings,
    },
  });
  check(
    'imports begun before deletion cannot restore old data',
    staleCommit.ok === false && (await list()).length === 0,
  );
  await page.goto(`${origin}/d2l/lms/quizzing/user/attempt/201?ou=999999`);
  await page.bringToFront();
  await panel.getByRole('heading', { name: 'Restricted mode' }).waitFor();
  check(
    'graded attempt hides library, text and import controls',
    (await panel.getByRole('button', { name: 'Library', exact: true }).count()) === 0 &&
      (await choose.count()) === 0,
  );
  const refused = await panel.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return chrome.runtime.sendMessage({ type: 'get-document-sources', tabId: tab.id });
  });
  check('worker refuses document source access inside the attempt', refused.ok === false);
  check(
    'document parsing raises no uncaught panel errors',
    errors.length === 0 || (console.log(errors), false),
  );
  console.log(`${checks}/${checks} document checks passed`);
} finally {
  await context.close();
  await rm(profile, { recursive: true, force: true });
}
