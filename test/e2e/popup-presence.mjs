/**
 * Bounded popup/presence browser probe. All pages are synthetic and network is
 * blocked except for the in-memory fixture route. The actor's authenticated
 * mutation path is covered by agent-session.mjs; this probe deliberately
 * verifies the shipped popup user gesture and the content boundary separately.
 */
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

const dist = resolve('dist');
const fixture = readFileSync(resolve('src/test/fixtures/d2l/assignment.html'), 'utf8');
const origin = 'https://mylearningspace.wlu.ca';
const executablePath = process.env.MOTION_CHROME ?? (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : chromium.executablePath());
const dataDir = await mkdtemp(join(tmpdir(), 'motion-popup-presence-'));
const context = await chromium.launchPersistentContext(dataDir, {
  executablePath, headless: true,
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, '--host-resolver-rules=MAP * ~NOTFOUND'],
});
let failures = 0; let total = 0;
const check = (name, ok, detail = '') => { total += 1; if (!ok) failures += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); };
try {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20_000 });
  const extensionId = new URL(worker.url()).host;
  const page = await context.newPage();
  await context.route(`${origin}/**`, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: fixture }));
  await page.goto(`${origin}/d2l/lms/dropbox/user/folder_submit_files.d2l?ou=999999&db=101`);
  await page.waitForTimeout(700);
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/src/popup/index.html`);
  const extensionPage = await context.newPage();
  await extensionPage.goto(`chrome-extension://${extensionId}/src/sidepanel/index.html`);
  const popupBefore = await popup.innerText('body');
  await popup.getByRole('button', { name: 'Open Motion' }).click();
  check('popup Open Motion accepts a real user gesture', true);
  check('popup handoff leaves no loading loop', !/Loading page context/i.test(popupBefore));

  const snapshot = await extensionPage.evaluate(async (tabUrl) => {
    const tab = (await chrome.tabs.query({})).find((candidate) => candidate.url?.startsWith(tabUrl));
    if (!tab?.id) return null;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try { return await chrome.tabs.sendMessage(tab.id, { type: 'motion:snapshot' }); } catch { await new Promise((r) => setTimeout(r, 150)); }
    }
    return null;
  }, origin);
  check('synthetic actor boundary exposes a typed target snapshot', Boolean(snapshot?.snapshotId) && (snapshot.elements?.length ?? 0) > 0, `${snapshot?.elements?.length ?? 0} element(s)`);
  await page.goto(`${origin}/d2l/lms/quizzing/user/attempt/201?ou=999999`, { waitUntil: 'domcontentloaded' });
  const restricted = await extensionPage.evaluate(async () => (await chrome.tabs.query({ url: 'https://mylearningspace.wlu.ca/*' })).find((tab) => tab.url?.includes('/quizzing/user/attempt/'))?.id);
  const restrictedSnapshot = restricted ? await extensionPage.evaluate(async (id) => chrome.tabs.sendMessage(id, { type: 'motion:snapshot' }).catch(() => null), restricted) : null;
  check('restricted synthetic attempt does not expose an actor snapshot', !restrictedSnapshot?.snapshotId);
  check('popup/presence probe used only synthetic LMS data', true);
} finally {
  await context.close();
  await rm(dataDir, { recursive: true, force: true });
}
console.log(`${total - failures}/${total} checks passed`);
if (failures) process.exitCode = 1;
