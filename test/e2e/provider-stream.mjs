/**
 * OpenAI provider stream + stop, driven from a real extension page.
 *
 * `agent-session.mjs` exercises this same path against the production
 * `dist/` build, but headless Chromium cannot grant the OpenAI *optional*
 * host permission from a scripted click, so that check silently SKIPs there.
 * This script instead loads `dist-e2e-provider/` (built by
 * `npm run build:e2e-provider-hosts`), a test-only variant whose manifest
 * declares a local `http://127.0.0.1` origin as a required host permission
 * (see `src/manifest.config.ts`) and whose OpenAI adapter is built with that
 * same origin as its base URL (see `E2E_PROVIDER_BASE_URL` in
 * `src/platform/ai/http.ts`). With the host already granted at install,
 * `chrome.permissions.contains` is satisfied with no runtime grant step, so
 * the same provider path in `src/background/sessions.ts` /
 * `src/background/modelTurn.ts` runs for real: SSE deltas accumulate into the
 * session conversation, and `stop-generation` aborts the in-flight request.
 *
 * Root cause this design works around: Playwright's `context.route`
 * intercepts fetches from pages/frames it controls, but this provider
 * request is made from the MV3 *service worker*, and `context.route` never
 * fires for it (confirmed with request logging + reading the SW's console
 * via CDP). `PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS=1` only adds
 * requestfinished/requestfailed *observability* for the SW, not routing, and
 * Playwright's `newCDPSession` only accepts a Page/Frame, not a
 * ServiceWorker, so there is no supported way to attach `Fetch.enable` to
 * the SW target either. So instead of interception, a real local HTTP
 * server (`local-openai-server.mjs`) stands in for `api.openai.com`: the
 * fetch is genuine, real bytes cross a real socket, and nothing ever reaches
 * the actual OpenAI API. The production build never sets
 * `MOTION_E2E_PROVIDER_HOSTS`, so its endpoints stay the fixed
 * `https://api.openai.com/*` (see `src/manifest.config.test.ts` and
 * `src/platform/ai/http.test.ts`).
 *
 * Run with: npm run build:e2e-provider-hosts && npm run test:provider-stream
 */
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startLocalOpenAIServer } from './local-openai-server.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const distPath = resolve(here, `../../${process.env.MOTION_E2E_PROVIDER_DIST ?? 'dist-e2e-provider'}`);
const providerBaseUrl = process.env.MOTION_E2E_PROVIDER_BASE_URL ?? 'http://127.0.0.1:8934';
const providerPort = Number(new URL(providerBaseUrl).port);
const CANARY = 'sk-test-CANARY1234567890';
const executablePath =
  process.env.MOTION_CHROME ??
  (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : chromium.executablePath());

let failures = 0;
let total = 0;
function check(name, passed, detail = '') {
  total += 1;
  if (!passed) failures += 1;
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

if (!existsSync(distPath)) {
  console.log(`FAIL  provider stream+stop — ${distPath} does not exist; run "npm run build:e2e-provider-hosts" first`);
  process.exit(1);
}

const localServer = await startLocalOpenAIServer({ port: providerPort });

const userDataDir = await mkdtemp(join(tmpdir(), 'motion-provider-e2e-'));
const context = await chromium.launchPersistentContext(userDataDir, {
  executablePath,
  headless: true,
  args: [
    `--disable-extensions-except=${distPath}`,
    `--load-extension=${distPath}`,
    // `MAP * ~NOTFOUND` alone also swallows loopback fetches (confirmed by
    // direct testing: a bare `fetch('http://127.0.0.1:PORT/...')` from the
    // service worker fails with "Failed to fetch" until 127.0.0.1 is
    // excluded), which would silently break the local OpenAI stand-in this
    // check depends on — see local-openai-server.mjs.
    '--host-resolver-rules=MAP * ~NOTFOUND,EXCLUDE 127.0.0.1',
  ],
});

async function waitForWorker() {
  const existing = context.serviceWorkers().find((candidate) => candidate.url().startsWith('chrome-extension://'));
  if (existing) return existing;
  return context.waitForEvent('serviceworker', { timeout: 20_000 });
}

let panel;
async function waitFor(predicate, timeoutMs = 15_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await panel.waitForTimeout(200);
  }
  return predicate();
}

const send = (message) => panel.evaluate((payload) => chrome.runtime.sendMessage(payload), message);
const state = async () => (await send({ type: 'get-state' }))?.result ?? null;

try {
  const worker = await waitForWorker();
  const extensionId = new URL(worker.url()).host;
  check('e2e-provider extension loads and declares the local provider host permission', Boolean(extensionId));

  const manifestGranted = await context.newPage().then(async (page) => {
    await page.goto(`chrome-extension://${extensionId}/manifest.json`, { waitUntil: 'load' });
    const text = await page.locator('body').innerText();
    await page.close();
    return text.includes(`${providerBaseUrl}/*`);
  });
  check(`the e2e-provider manifest declares ${providerBaseUrl} as a required host`, manifestGranted);

  panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/src/sidepanel/index.html`, { waitUntil: 'domcontentloaded' });

  await send({ type: 'set-provider-key', providerId: 'openai', key: CANARY });
  await send({ type: 'accept-cloud-disclosure', providerId: 'openai', accepted: true });
  await send({ type: 'set-ai-preferences', providerId: 'openai', model: 'gpt-5' });

  // `session-create` with no related resources runs a model turn immediately
  // (src/background/sessions.ts createSession -> runModelTurn), so this alone
  // drives the first real provider request. The build under test
  // (dist-e2e-provider, MOTION_E2E_PROVIDER_HOSTS=1) points OpenAI's base URL
  // at `providerBaseUrl` (see src/platform/ai/http.ts), so this is a real
  // fetch from the service worker to `localServer`, over a real socket.
  const created = await send({ type: 'session-create', goal: 'Use the connected provider.', tabId: null });
  const sessionId = created?.result?.session?.id;
  check('session-create resolves without needing a runtime permission prompt', Boolean(sessionId));

  const streamed = await waitFor(async () => {
    const current = await state();
    return current?.activeSession?.conversation?.some((entry) => entry.text === 'Streamed from OpenAI') ? current.activeSession : null;
  }, 20_000);
  check(
    'extension-page-driven provider stream accumulates deltas across SSE events',
    Boolean(streamed) && localServer.responseCount === 1,
    JSON.stringify(streamed?.conversation?.map((entry) => entry.text)),
  );

  const stopMessage = send({ type: 'session-message', sessionId, text: 'Hold this response.', tabId: null });
  await waitFor(() => localServer.secondRequestSeen, 10_000);
  await send({ type: 'session-command', sessionId, command: 'stop-generation' });
  await stopMessage.catch(() => undefined);
  await waitFor(() => localServer.secondRequestAborted, 10_000);
  check(
    'stopping an extension-page-driven stream aborts the in-flight provider request',
    localServer.responseCount === 2 && localServer.secondRequestAborted,
  );
} finally {
  await context.close();
  await rm(userDataDir, { recursive: true, force: true });
  await localServer.close();
}

console.log(`\n${total - failures}/${total} checks passed`);
process.exit(failures === 0 ? 0 : 1);
