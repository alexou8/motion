import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { spawnSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';

// A recording of the shipped UI during an isolated, synthetic walkthrough.
// Captions identify the fixture boundary; this is not a live institution test.
const dist = resolve('dist');
const fixtures = resolve('src/test/fixtures/d2l');
const output = resolve('docs/store-assets');
const origin = 'https://mylearningspace.wlu.ca';
const executablePath = process.env.MOTION_CHROME ?? chromium.executablePath();
assert(existsSync(join(dist, 'manifest.json')), 'Build the production extension first.');
const temporary = await mkdtemp(join(tmpdir(), 'motion-reviewer-demo-'));
const externalRequests = [];
const errors = [];
const chapters = [];
await mkdir(output, { recursive: true });
const fixture = (name) => readFile(join(fixtures, name), 'utf8');
const calendar = JSON.parse(await fixture('discovery-calendar-events.json'));
const today = new Date();
today.setHours(23, 59, 0, 0);
const later = new Date(today);
later.setDate(later.getDate() + 14);
calendar.Items[0].EndDateTime = today.toISOString();
calendar.Items[1].EndDateTime = later.toISOString();
const context = await chromium.launchPersistentContext(join(temporary, 'profile'), {
  executablePath,
  headless: true,
  viewport: { width: 480, height: 710 },
  colorScheme: 'light',
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, '--host-resolver-rules=MAP * ~NOTFOUND'],
});
context.on('request', (request) => {
  const url = new URL(request.url());
  if (/^(?:chrome-extension|data|blob|about):$/.test(url.protocol)) return;
  if (url.origin !== origin && url.origin !== 'https://ordinary.example') externalRequests.push(url.href);
});
let displayBrowser;
let displayContext;
let display;
let video;
let started;
try {
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (/^(?:chrome-extension|data|blob|about):$/.test(url.protocol)) return route.continue();
    if (url.origin === 'https://ordinary.example') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Synthetic ordinary website</title><h1>Synthetic ordinary website</h1><p>No coursework on this page.</p>' });
    if (url.origin !== origin) {
      externalRequests.push(url.href);
      return route.abort();
    }
    let body;
    let contentType = 'text/html';
    if (url.pathname === '/d2l/api/versions/') {
      contentType = 'application/json';
      body = JSON.stringify({ Items: [{ ProductCode: 'lp', LatestVersion: '1.48' }, { ProductCode: 'le', LatestVersion: '1.48' }] });
    } else if (url.pathname.includes('/enrollments/myenrollments/')) {
      contentType = 'application/json';
      body = await fixture('discovery-enrollments.json');
    } else if (url.pathname.includes('/calendar/events/myEvents/')) {
      contentType = 'application/json';
      body = JSON.stringify(calendar);
    } else if (url.pathname === '/d2l/home/999999') body = await fixture('course-home-navbar.html');
    else if (url.pathname.includes('/quizzing/user/attempt/')) body = await fixture('quiz-attempt.html');
    else if (url.pathname === '/d2l/home/424242') body = await fixture('signed-out-redirect.html');
    else return route.fulfill({ status: 404, contentType, body: '<!doctype html><title>Synthetic missing resource</title>' });
    return route.fulfill({ status: 200, contentType, body });
  });
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20_000 });
  const extensionId = new URL(worker.url()).host;
  const panel = await context.newPage();
  panel.on('pageerror', (error) => errors.push(error.message));
  await panel.goto(`chrome-extension://${extensionId}/src/sidepanel/index.html`);
  const site = await context.newPage();
  await site.goto('https://ordinary.example');
  await site.bringToFront();
  await panel.getByText('Unsupported page', { exact: true }).waitFor();
  // A separate window keeps the presentation from changing the LMS active tab.
  displayBrowser = await chromium.launch({ executablePath, headless: true, args: ['--host-resolver-rules=MAP * ~NOTFOUND'] });
  displayContext = await displayBrowser.newContext({ viewport: { width: 1280, height: 800 }, recordVideo: { dir: join(temporary, 'video'), size: { width: 1280, height: 800 } } });
  await displayContext.route('**/*', (route) => route.abort());
  display = await displayContext.newPage();
  video = display.video();
  const serif = (await readFile('src/assets/fonts/source-serif-4-var.woff2')).toString('base64');
  const sans = (await readFile('src/assets/fonts/ibm-plex-sans-var.woff2')).toString('base64');
  await display.setContent(`<!doctype html><style>
    @font-face{font-family:Serif;src:url(data:font/woff2;base64,${serif})}
    @font-face{font-family:Sans;src:url(data:font/woff2;base64,${sans})}
    *{box-sizing:border-box}body{margin:0;background:#330072;color:#fff;font-family:Sans;width:1280px;height:800px;padding:44px 48px;display:flex;align-items:center;gap:48px}
    aside{width:400px;flex:none}.brand{font:32px Serif;margin:0 0 32px;color:#f2a900}h1{font:42px/1.15 Serif;margin:0 0 24px}p{font-size:21px;line-height:1.5;color:#e9def4;margin:0 0 24px}.label{font-size:15px;border-top:1px solid #7f5b9e;padding-top:24px}.number{font-size:16px;letter-spacing:2px;color:#f2a900;margin-bottom:18px}
    figure{margin:0;flex:1;height:710px;display:flex;justify-content:center;align-items:center}img{max-width:100%;max-height:710px;box-shadow:0 10px 40px #18003377;border-radius:6px}
    </style><aside><div class="brand">Motion</div><div class="number" id="number"></div><h1 id="title"></h1><p id="copy"></p><p class="label">Synthetic coursework only<br>Production UI · Snapshot walkthrough<br>No live LMS, provider, or credentials</p></aside><figure><img id="screen" alt="Captured production extension UI"></figure>`);
  await display.evaluate(async () => { await document.fonts.ready; });
  started = Date.now();
  async function chapter(title, copy, page = panel, seconds = 4) {
    const at = Math.round((Date.now() - started) / 1000);
    chapters.push({ at, title, copy });
    console.log(`DEMO ${String(at).padStart(2, '0')}s: ${title}`);
    await display.evaluate(({ title, copy, number }) => {
      document.getElementById('title').textContent = title;
      document.getElementById('copy').textContent = copy;
      document.getElementById('number').textContent = number;
    }, { title, copy, number: `${String(chapters.length).padStart(2, '0')} / REVIEWER WALKTHROUGH` });
    const until = Date.now() + seconds * 1000;
    do {
      const screenshot = await page.screenshot();
      await display.evaluate(async (source) => {
        const image = document.getElementById('screen');
        image.src = source;
        await image.decode();
      }, `data:image/png;base64,${screenshot.toString('base64')}`);
      await display.waitForTimeout(200);
    } while (Date.now() < until);
  }
  await chapter('A focused workspace', 'On an ordinary website, Motion explains that the page is unsupported. Settings and your saved work remain accessible.');
  await site.goto(`${origin}/d2l/home/999999?ou=999999`);
  await site.bringToFront();
  await panel.getByRole('button', { name: 'Enable scanning', exact: true }).waitFor();
  const extracted = await panel.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return chrome.runtime.sendMessage({ type: 'request-extraction', tabId: tab.id });
  });
  assert.equal(extracted?.result?.requested, true);
  await chapter('Choose what to read', 'This Brightspace course is a synthetic fixture. Scanning stays off until the student explicitly enables it.');
  await panel.getByRole('button', { name: 'Enable scanning', exact: true }).click();
  await panel.getByRole('button', { name: 'Scan all courses', exact: true }).waitFor();
  await panel.getByRole('button', { name: 'Scan all courses', exact: true }).click();
  await panel.getByRole('heading', { name: 'Chapter 1 Quiz', exact: true }).waitFor();
  await panel.getByLabel('Filter by course').selectOption('d2l:101');
  await panel.locator('main').evaluate((main) => {
    const section = document.getElementById('deadlines-title')?.closest('section');
    if (section) main.scrollTop += section.getBoundingClientRect().top - main.getBoundingClientRect().top - 16;
  });
  await chapter('Source-linked deadlines', 'The real extension scans local fixture responses, saves two deadlines, and filters them to PSYCH101. Exact times and source links stay visible.');
  await panel.getByRole('button', { name: 'Week', exact: true }).click();
  assert.match(await panel.innerText('body'), /This week/);
  await chapter('Plan this week', 'Week view separates this week from later coursework. Changing views preserves the selected course.');
  await panel.getByRole('button', { name: 'List', exact: true }).click();
  await chapter('Keep later work visible', 'List view retains the deadline two weeks away. Dates use the browser time zone; students check the LMS before submitting.');
  await panel.getByRole('button', { name: 'Library', exact: true }).click();
  await panel.getByRole('button', { name: 'Import a PDF or PowerPoint', exact: true }).waitFor();
  await chapter('Local document library', 'Students can explicitly import a PDF or PowerPoint. Indexing is local and does not require an AI provider. This recording shows the import control, not a completed import.');
  const settings = await context.newPage();
  await settings.setViewportSize({ width: 760, height: 710 });
  settings.on('pageerror', (error) => errors.push(error.message));
  await settings.goto(`chrome-extension://${extensionId}/src/options/index.html#ai`);
  await settings.getByRole('heading', { name: 'AI', exact: true }).waitFor();
  await chapter('Optional AI', 'Local AI depends on the review device. OpenAI and Anthropic require disclosure, endpoint permission, and the student’s own key. No key is entered here.', settings);
  await settings.getByRole('button', { name: 'Reminders', exact: true }).click();
  assert.equal(await settings.getByRole('checkbox', { name: 'Send deadline reminders' }).isChecked(), false);
  await chapter('Reminders start off', 'Students choose whether to enable reminders, then configure lead times and quiet hours. The fresh-profile checkbox is off.', settings);
  await settings.getByRole('button', { name: 'Privacy & data', exact: true }).click();
  await chapter('Clear privacy controls', 'Settings explains local records and optional cloud requests. Delete all Motion data removes browser records and configured keys; it does not alter the LMS.', settings);
  await settings.close();
  assert.deepEqual(externalRequests, [], 'Unexpected remote request attempted.');
  assert.deepEqual(errors, [], 'Unexpected production UI error.');
  await displayContext.close();
  displayContext = undefined;
  const rawVideo = join(temporary, 'raw.webm');
  await video.saveAs(rawVideo);
  const cache = chromium.executablePath().split(/[/\\]chromium[-_]/)[0];
  const ffmpegDirectory = (await readdir(cache)).filter((name) => /^ffmpeg-\d+$/.test(name)).sort((a, b) => Number(b.slice(7)) - Number(a.slice(7)))[0];
  assert(ffmpegDirectory, 'Playwright bundled ffmpeg is needed to remove recorder lead-in.');
  const ffmpeg = join(cache, ffmpegDirectory, process.platform === 'darwin' ? 'ffmpeg-mac' : process.platform === 'win32' ? 'ffmpeg-win64.exe' : 'ffmpeg-linux');
  const encoding = spawnSync(ffmpeg, ['-loglevel', 'error', '-y', '-ss', '0.8', '-i', rawVideo, '-c:v', 'libvpx', '-b:v', '1M', '-deadline', 'realtime', '-cpu-used', '8', join(output, 'reviewer-demo.webm')], { encoding: 'utf8' });
  assert.equal(encoding.status, 0, encoding.stderr || 'Reviewer video encoding failed.');
  const manifest = JSON.parse(await readFile(join(dist, 'manifest.json'), 'utf8'));
  const stamp = (seconds) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  await writeFile(join(output, 'reviewer-demo.md'), `# Motion snapshot-based reviewer walkthrough\n\nCaptured ${new Date().toISOString()} from production dist version ${manifest.version}.\n\nVideo: reviewer-demo.webm (1280×800, VP8 WebM, silent with visible captions; chapter timestamps are approximate). Reproduce after a production build with \`node scripts/capture-reviewer-demo.mjs\`.\n\nThe demonstration captures the actual production side-panel/options documents in headless Chromium, sampling their rendered UI into a separate captioned recording window. Course/API responses come only from synthetic repository fixtures. All unmatched HTTPS requests are aborted; Chromium DNS is disabled. No live LMS, AI provider, account, credential, or real course data is used.\n\n${chapters.map((entry) => `- ${stamp(entry.at)} — ${entry.title}: ${entry.copy}`).join('\n')}\n\nObserved: two scanned deadlines, PSYCH101 course filter, List and Week views, and fresh-profile reminders off. Unexpected external requests: ${externalRequests.length}. Production UI page errors: ${errors.length}.\n\nLimits: this is a reviewer aid, not an authenticated institution test or reviewer login. No completed file import, AI generation, native-companion installation, consequential submission/upload/post, active assessment, deletion, or real browser-toolbar/side-panel opening is demonstrated. The extension documents are captured directly; browser chrome is not recorded.\n`);
  console.log(`Saved ${join(output, 'reviewer-demo.webm')}`);
} finally {
  if (displayContext) await displayContext.close();
  if (displayBrowser) await displayBrowser.close();
  await context.close();
  await rm(temporary, { recursive: true, force: true });
}
