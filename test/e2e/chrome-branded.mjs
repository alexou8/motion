/**
 * Branded Chrome verification. Uses a temporary profile and synthetic D2L
 * routing only; no real LMS or provider endpoint is contacted.
 */
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const distPath = resolve(repo, 'dist');
const fixturePath = resolve(repo, 'src/test/fixtures/d2l/course-home.html');
const ORIGIN = 'https://mylearningspace.wlu.ca';
const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

let failures = 0;
let total = 0;
function check(name, passed, detail = '') {
  total += 1;
  if (!passed) failures += 1;
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const probe = async (target) => target.evaluate(async () => {
  const kind = typeof globalThis.LanguageModel;
  let availability = 'timeout';
  if (kind === 'function') {
    availability = await Promise.race([
      globalThis.LanguageModel.availability({ expectedInputs: [{ type: 'text', languages: ['en'] }], expectedOutputs: [{ type: 'text', languages: ['en'] }] }),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 2_000)),
    ]);
  }
  return { kind, availability };
});

if (!existsSync(chromePath)) {
  check('branded Chrome is installed', false, `${chromePath} not found`);
} else {
  const userDataDir = await mkdtemp(join(tmpdir(), 'motion-chrome-e2e-'));
  const port = 38_000 + Math.floor(Math.random() * 1_000);
  const process = spawn(chromePath, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--enable-unsafe-extension-debugging',
    '--host-resolver-rules=MAP * ~NOTFOUND',
  ], { stdio: 'ignore' });
  let browser;
  try {
    const started = Date.now();
    let version;
    while (Date.now() - started < 20_000) {
      try {
        version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    if (!version?.webSocketDebuggerUrl) throw new Error('Chrome remote debugging endpoint did not start.');
    browser = await chromium.connectOverCDP(version.webSocketDebuggerUrl);
    const context = browser.contexts()[0];
    const cdp = await browser.newBrowserCDPSession();
    const loaded = await cdp.send('Extensions.loadUnpacked', { path: distPath });
    const worker = await (async () => {
      const existing = context.serviceWorkers().find((candidate) => candidate.url().startsWith('chrome-extension://'));
      return existing ?? context.waitForEvent('serviceworker', { timeout: 20_000 });
    })();
    const extensionId = loaded.extensionId ?? loaded.id ?? new URL(worker.url()).host;
    check('branded Chrome loads the unpacked extension over CDP', typeof extensionId === 'string' && extensionId.length > 0, `Chrome ${version.Browser ?? 'unknown'}`);
    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${extensionId}/src/sidepanel/index.html`, { waitUntil: 'domcontentloaded' });
    check('branded Chrome opens the Motion panel', (await panel.innerText('body')).includes('Motion'));

    await context.route(`${ORIGIN}/**`, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: readFileSync(fixturePath, 'utf8') }));
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/d2l/home/999999?ou=999999`, { waitUntil: 'load' });
    await panel.waitForTimeout(1_200);
    const panelState = await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'get-state' }));
    check('branded Chrome detects the synthetic D2L page', panelState?.result?.page?.pageType === 'course-home' && panelState?.result?.connection === 'supported', panelState?.result?.page?.pageType ?? 'none');

    const panelProbe = await probe(panel);
    const workerProbe = await probe(worker);
    check('LanguageModel diagnostics match direct branded-Chrome probes', panelProbe.kind === workerProbe.kind, `${panelProbe.kind}/${panelProbe.availability}; ${workerProbe.kind}/${workerProbe.availability}`);
    check('branded Chrome probe is time-bounded', ['available', 'downloadable', 'downloading', 'unavailable', 'timeout'].includes(panelProbe.availability) && ['available', 'downloadable', 'downloading', 'unavailable', 'timeout'].includes(workerProbe.availability));

    await page.close();
    await panel.close();
  } catch (error) {
    check('branded Chrome CDP verification completes', false, error instanceof Error ? error.message : String(error));
  } finally {
    await browser?.close().catch(() => undefined);
    process.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (!process.killed) process.kill('SIGKILL');
    await rm(userDataDir, { recursive: true, force: true });
  }
}

console.log(`\n${total - failures}/${total} checks passed`);
process.exit(failures === 0 ? 0 : 1);
