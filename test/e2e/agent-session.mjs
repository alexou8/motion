/**
 * AgentSession end-to-end coverage for the built extension.
 *
 * All LMS pages and provider responses are synthetic. The provider test
 * replaces fetch inside Motion's service worker after the worker is running;
 * no request is allowed to leave this process.
 */
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { observePresence } from './presence-browser-observer.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const distPath = resolve(here, '../../dist');
const fixtureDir = resolve(here, '../../src/test/fixtures/d2l');
const ORIGIN = 'https://mylearningspace.wlu.ca';
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

const fixture = (name) => readFileSync(join(fixtureDir, `${name}.html`), 'utf8');
const assignmentList = fixture('e2e-assignment-list');
const assignment = fixture('e2e-agent-assignment');

const userDataDir = await mkdtemp(join(tmpdir(), 'motion-agent-e2e-'));
const context = await chromium.launchPersistentContext(userDataDir, {
  executablePath,
  headless: true,
  args: [
    `--disable-extensions-except=${distPath}`,
    `--load-extension=${distPath}`,
    '--host-resolver-rules=MAP * ~NOTFOUND',
  ],
});

const workerErrors = [];
const panelErrors = [];
const optionsErrors = [];
const pageErrors = [];

function observeWorker(worker) {
  worker.on('console', (message) => {
    if (message.type() === 'error') workerErrors.push(message.text());
  });
  return worker;
}

async function waitForWorker() {
  const existing = context.serviceWorkers().find((candidate) => candidate.url().startsWith('chrome-extension://'));
  if (existing) return observeWorker(existing);
  return observeWorker(await context.waitForEvent('serviceworker', { timeout: 20_000 }));
}

async function waitFor(predicate, timeoutMs = 15_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await panel.waitForTimeout(250);
  }
  return await predicate();
}

let panel;
const send = (message) => panel.evaluate((payload) => chrome.runtime.sendMessage(payload), message);
const state = async () => (await send({ type: 'get-state' }))?.result ?? null;
const activeTabId = async () => panel.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id ?? null);
const refreshPanel = async () => { await panel.reload({ waitUntil: 'domcontentloaded' }); await panel.waitForTimeout(500); };

async function storageDump() {
  return panel.evaluate(async () => {
    const local = await chrome.storage.local.get(null);
    const session = await chrome.storage.session.get(null);
    const stores = await new Promise((resolve) => {
      const request = indexedDB.open('motion');
      request.onerror = () => resolve({});
      request.onsuccess = () => {
        const db = request.result;
        const names = [...db.objectStoreNames];
        const result = {};
        if (names.length === 0) { db.close(); resolve(result); return; }
        let remaining = names.length;
        for (const name of names) {
          const read = db.transaction(name, 'readonly').objectStore(name).getAll();
          read.onsuccess = () => { result[name] = read.result; remaining -= 1; if (remaining === 0) { db.close(); resolve(result); } };
          read.onerror = () => { result[name] = []; remaining -= 1; if (remaining === 0) { db.close(); resolve(result); } };
        }
      };
    });
    return { local, session, stores };
  });
}

async function stopServiceWorker(tab) {
  const cdp = await context.newCDPSession(tab);
  const targets = await cdp.send('Target.getTargets');
  const target = targets.targetInfos.find((candidate) => candidate.type === 'service_worker' && candidate.url.startsWith('chrome-extension://'));
  if (!target) return false;
  await cdp.send('Target.closeTarget', { targetId: target.targetId });
  return true;
}

async function installMockFetch(worker, responses, mode = 'stream') {
  await worker.evaluate(({ nextResponses, nextMode }) => {
    globalThis.__motionMockResponses = [...nextResponses];
    globalThis.__motionMockMode = nextMode;
    globalThis.fetch = async (input, init = {}) => {
      const url = String(input);
      if (globalThis.__motionMockMode === '401') {
        return new Response(JSON.stringify({ error: { message: 'invalid api key' } }), { status: 401, headers: { 'content-type': 'application/json' } });
      }
      if (url.endsWith('/v1/models')) {
        return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      const responseText = globalThis.__motionMockResponses.shift() ?? '{"reply":"No mocked response.","plan":[]}';
      const encoder = new TextEncoder();
      const event = (text) => `event: response.output_text.delta\ndata: ${JSON.stringify({ delta: text })}\n\n`;
      if (responseText === '__HOLD__') {
        return new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(event('{"reply":"streaming')));
            const onAbort = () => controller.error(new DOMException('Request cancelled.', 'AbortError'));
            init.signal?.addEventListener('abort', onAbort, { once: true });
          },
        }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
      return new Response(new ReadableStream({
        start(controller) {
          const middle = Math.max(1, Math.floor(responseText.length / 2));
          controller.enqueue(encoder.encode(event(responseText.slice(0, middle))));
          setTimeout(() => { controller.enqueue(encoder.encode(event(responseText.slice(middle)))); controller.close(); }, 20);
        },
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };
  }, { nextResponses: responses, nextMode: mode });
}

async function seedWorkflow({ id, sessionId, action, title, input }) {
  await panel.evaluate(async ({ workflowId, currentSessionId, workflowAction, workflowTitle, workflowInput }) => {
    const now = new Date().toISOString();
    await new Promise((resolve, reject) => {
      const request = indexedDB.open('motion');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction(['workflows', 'sessions'], 'readwrite');
        tx.objectStore('workflows').put({
          id: workflowId,
          definitionId: 'agent-turn',
          definitionVersion: 1,
          title: workflowTitle,
          courseId: null,
          params: { sessionId: currentSessionId },
          steps: [{
            id: `e2e-${workflowId}`,
            title: workflowTitle,
            action: workflowAction,
            risk: workflowAction === 'submit-assignment' ? 'high' : 'medium',
            input: workflowInput,
            status: 'pending',
            attempt: 0,
            result: null,
            error: null,
            sourcesVisited: [],
            approvalId: null,
            consumedApprovalId: null,
            intent: null,
            startedAt: null,
            finishedAt: null,
          }],
          status: 'paused',
          currentStepId: `e2e-${workflowId}`,
          lease: null,
          retryAt: null,
          tabGroupId: null,
          warnings: [],
          createdAt: now,
          updatedAt: now,
        });
        const sessionRequest = tx.objectStore('sessions').get(currentSessionId);
        sessionRequest.onsuccess = () => {
          const session = sessionRequest.result;
          if (session) tx.objectStore('sessions').put({ ...session, workflowIds: [...new Set([...(session.workflowIds ?? []), workflowId])], updatedAt: now });
        };
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      };
    });
  }, { workflowId: id, currentSessionId: sessionId, workflowAction: action, workflowTitle: title, workflowInput: input });
}

try {
  const worker = await waitForWorker();
  const extensionId = new URL(worker.url()).host;
  check('extension installs in Chromium', Boolean(extensionId), `extension id ${extensionId}`);

  panel = await context.newPage();
  panel.on('pageerror', (error) => panelErrors.push(error.message));
  panel.on('console', (message) => { if (message.type() === 'error') panelErrors.push(message.text()); });
  await panel.goto(`chrome-extension://${extensionId}/src/sidepanel/index.html`, { waitUntil: 'domcontentloaded' });
  check('panel document opens at the shipped extension URL', panel.url() === `chrome-extension://${extensionId}/src/sidepanel/index.html` && (await panel.innerText('body')).includes('Motion'));

  await context.route(`${ORIGIN}/**`, (route) => {
    const url = new URL(route.request().url());
    let body = '<!doctype html><title>Not found</title><body>404</body>';
    if (url.pathname === '/d2l/lms/dropbox/user/folders_list.d2l') body = assignmentList;
    if (url.pathname === '/d2l/lms/dropbox/user/folder_submit_files.d2l') body = assignment;
    if (url.pathname === '/d2l/home/999999') body = fixture('course-home');
    if (url.pathname.startsWith('/d2l/lms/quizzing/user/attempt/')) body = assignment;
    return route.fulfill({ status: body.includes('Not found') ? 404 : 200, contentType: 'text/html', body });
  });

  const listPage = await context.newPage();
  listPage.on('pageerror', (error) => pageErrors.push(error.message));
  await listPage.goto(`${ORIGIN}/d2l/lms/dropbox/user/folders_list.d2l?ou=999999`, { waitUntil: 'load' });
  await panel.waitForTimeout(900);
  const listTabId = await activeTabId();
  await send({ type: 'request-extraction', tabId: listTabId });
  await panel.waitForTimeout(900);

  const studentPage = await context.newPage();
  studentPage.on('pageerror', (error) => pageErrors.push(error.message));
  studentPage.on('console', (message) => { if (message.type() === 'error') pageErrors.push(message.text()); });
  await studentPage.goto(`${ORIGIN}/d2l/lms/dropbox/user/folder_submit_files.d2l?ou=999999&db=101`, { waitUntil: 'load' });
  const studentTabId = await activeTabId();
  await waitFor(async () => (await state())?.page?.pageType === 'assignment');
  check('D2L assignment page is detected', (await state())?.connection === 'supported' && (await state())?.page?.pageType === 'assignment');

  const studentGoal = 'Work on Example Assignment';
  const homeComposer = panel.locator('#home-composer');
  await homeComposer.fill(studentGoal);
  await panel.getByRole('button', { name: 'Start' }).click();
  const created = await waitFor(async () => (await state())?.activeSession, 20_000);
  check('AgentSession is created through the panel composer', Boolean(created?.id) && created?.goal === studentGoal, created?.title ?? 'none');
  check('session resolves the synthetic assignment context', created?.taskId !== null && created?.courseId !== null, `${created?.courseId ?? 'no course'} / ${created?.taskId ?? 'no task'}`);

  const localState = await send({ type: 'ai-status' });
  const localDiagnostic = localState?.result?.providers?.find((provider) => provider.providerId === 'chrome-local');
  check('unsupported local AI degrades to a resumable UI state', Boolean(localDiagnostic) && ['available', 'downloadable', 'downloading', 'unavailable', 'needs-document-context'].includes(localDiagnostic.status));

  const directProbe = async (target) => target.evaluate(async () => {
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
  const panelProbe = await directProbe(panel);
  const workerProbe = await worker.evaluate(async () => {
    const kind = typeof globalThis.LanguageModel;
    let availability = 'timeout';
    if (kind === 'function') availability = await Promise.race([globalThis.LanguageModel.availability(), new Promise((resolve) => setTimeout(() => resolve('timeout'), 2_000))]);
    return { kind, availability };
  });
  check('Chrome built-in AI diagnostics match direct panel and worker probes', panelProbe.kind === workerProbe.kind && typeof localDiagnostic?.status === 'string', `${panelProbe.kind}/${panelProbe.availability}; ${workerProbe.kind}/${workerProbe.availability}; UI ${localDiagnostic?.status}`);

  // Prepare workspace exercises the real tab-group path. The current tab is
  // never included, so its ownership remains the student's.
  const preparedReply = await send({ type: 'prepare-workspace', tabId: studentTabId });
  const preparedWorkflowId = preparedReply?.result?.workflowId;
  await waitFor(async () => (await state())?.workflows?.some((workflow) => workflow.id === preparedWorkflowId && workflow.status === 'completed'), 15_000);
  const groups = await panel.evaluate(() => chrome.tabGroups.query({}));
  const motionGroup = groups.find((group) => group.title?.startsWith('Motion ·'));
  const groupMembers = motionGroup ? await panel.evaluate(async (id) => (await chrome.tabs.query({ groupId: id })).map((tab) => ({ id: tab.id, url: tab.url })), motionGroup.id) : [];
  const motionOwnedTabId = groupMembers.find((member) => member.id !== studentTabId)?.id;
  check('tab group is created with Motion-owned synthetic tabs', Boolean(preparedWorkflowId) && /^Motion · /.test(motionGroup?.title ?? '') && Boolean(motionOwnedTabId), `${motionGroup?.title ?? 'no group'} / ${groupMembers.length} member(s)`);
  check('student tab remains outside the Motion-owned group', !groupMembers.some((member) => member.id === studentTabId));

  const createdSession = await waitFor(async () => (await state())?.activeSession, 20_000);
  check('AgentSession is available alongside the prepared workspace', Boolean(createdSession?.id) && motionOwnedTabId !== undefined);

  // Explicitly adopt the student tab into the session. It remains student-owned,
  // even though it is now available as a workspace context.
  await studentPage.bringToFront();
  await panel.getByRole('button', { name: 'Add this tab' }).click();
  const adopted = await waitFor(async () => {
    const current = (await state())?.activeSession;
    return current?.workspace?.adoptedTabIds?.includes(studentTabId) ? current : null;
  });
  check('student and workspace tabs retain explicit ownership records', Boolean(adopted) && !adopted.workspace.ownedTabIds.includes(studentTabId));

  const workspaceUi = await waitFor(async () => {
    const tabs = (await state())?.workspaceTabs ?? [];
    return tabs.length > 0 ? tabs : null;
  });
  const workspaceText = await panel.innerText('body');
  check('workspace renders human metadata without raw tab ids', workspaceUi?.every((tab) => tab.title && tab.ownership && !workspaceText.includes(`#${tab.tabId}`)) && /Motion tab|Your tab/.test(workspaceText), `${workspaceUi?.length ?? 0} workspace row(s)`);
  const focusButton = panel.getByRole('button', { name: 'Focus' }).first();
  if (await focusButton.count()) {
    const focusedTab = workspaceUi?.find((tab) => !tab.current);
    await focusButton.click();
    const focusedState = await waitFor(async () => {
      const tabs = (await state())?.workspaceTabs ?? [];
      return tabs.some((tab) => tab.current && tab.tabId === focusedTab?.tabId) ? tabs : null;
    });
    check('workspace Focus targets a non-current workspace tab', Boolean(focusedTab) && Boolean(focusedState));
  } else {
    check('workspace Focus is absent when all live workspace tabs are current', !workspaceUi?.some((tab) => !tab.current), 'no non-current workspace tab was exposed');
  }

  const actorTabId = studentTabId;
  const actorPage = studentPage;
  const presenceObserver = await observePresence(context, actorPage);

  // Snapshot through the real content actor, then seed a normal paused
  // agent-turn workflow so the worker policy and approval engine are exercised.
  const snapshot = await panel.evaluate(async (id) => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        return await chrome.tabs.sendMessage(id, { type: 'motion:snapshot' });
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    return null;
  }, actorTabId);
  await panel.evaluate(async ({ tabId, value }) => {
    const stored = (await chrome.storage.session.get('motion.snapshots'))['motion.snapshots'] ?? {};
    await chrome.storage.session.set({ 'motion.snapshots': { ...stored, [tabId]: value } });
  }, { tabId: actorTabId, value: snapshot });
  const field = snapshot?.elements?.find((element) => element.tag === 'input' && element.type === 'text');
  const submit = snapshot?.elements?.find((element) => element.type === 'submit' || /submit/i.test(element.label));
  check('actor snapshot is typed, bounded, and available to the session', Boolean(snapshot?.snapshotId) && Boolean(field) && Boolean(submit), `${snapshot?.elements?.length ?? 0} element(s)`);

  // A tabs.connect opened by this extension page is delivered to the content
  // script too, but its browser-provided sender URL is the page URL rather
  // than the service-worker URL. Send a fully valid consequential request
  // over that forged port and assert it is disconnected before the synthetic
  // submit handler can run.
  const forgedActorResult = await panel.evaluate(async ({ tabId, snapshotId, handle }) => new Promise((resolve) => {
    const port = chrome.tabs.connect(tabId, { name: 'motion-actor' });
    let replies = 0;
    let settled = false;
    const finish = (disconnected) => { if (!settled) { settled = true; resolve({ disconnected, replies }); } };
    port.onMessage.addListener(() => { replies += 1; });
    port.onDisconnect.addListener(() => setTimeout(() => finish(true), 0));
    port.postMessage({
      type: 'motion:act',
      requestId: crypto.randomUUID(),
      request: {
        type: 'click',
        snapshotId,
        handle,
        authorization: { nonce: crypto.randomUUID(), consequentialCapability: crypto.randomUUID() },
      },
    });
    setTimeout(() => finish(false), 1_000);
  }), { tabId: actorTabId, snapshotId: snapshot?.snapshotId ?? '', handle: submit?.handle ?? '' });
  check('forged extension-page actor request is denied before submit', forgedActorResult?.disconnected === true && forgedActorResult?.replies === 0 && (await actorPage.locator('#form-result').textContent()) !== 'SUBMITTED');

  const fillValue = 'A'.repeat(90);
  const intendedFieldRect = await actorPage.locator('#draft-field').evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  });
  await seedWorkflow({ id: 'e2e-fill-workflow', sessionId: createdSession.id, action: 'fill-form-field', title: 'Fill the draft field', input: { tabId: actorTabId, snapshotId: snapshot?.snapshotId ?? '', handle: field?.handle ?? '', value: fillValue, target: 'Draft field' } });
  await send({ type: 'workflow-command', workflowId: 'e2e-fill-workflow', command: 'resume' });
  await refreshPanel();
  const fillApproval = await waitFor(async () => (await state())?.approvals?.find((approval) => approval.action === 'fill-form-field'));
  check('configurable actor action waits for approval', Boolean(fillApproval) && (await actorPage.locator('#draft-field').inputValue()) === '', fillApproval?.summary ?? 'no approval');
  const fillPresence = await presenceObserver.during(() => panel.getByRole('button', { name: 'Allow once' }).click());
  await waitFor(async () => (await actorPage.locator('#draft-field').inputValue()) === fillValue, 10_000);
  const fillHalo = fillPresence?.layers.find((layer) => layer.className.includes('__halo'));
  const fillPointer = fillPresence?.layers.find((layer) => layer.className.includes('__pointer'));
  const fillLabel = fillPresence?.layers.find((layer) => layer.className.includes('__label'));
  check('approved fill exposes a closed-shadow target cue before the real field changes',
    Boolean(fillPresence) && /pointer-events:\s*none/.test(fillPresence.host.style ?? '') &&
      Math.abs((fillHalo?.left ?? Number.NaN) - intendedFieldRect.left) < 2 &&
      Math.abs((fillHalo?.top ?? Number.NaN) - intendedFieldRect.top) < 2 &&
      Math.abs((fillPointer?.left ?? Number.NaN) - (intendedFieldRect.left + intendedFieldRect.width / 2 + 7)) < 2 &&
      /Typing: A{71}…/.test(fillLabel?.text ?? '') && !(fillLabel?.text ?? '').includes(fillValue),
    JSON.stringify({ host: fillPresence?.host, halo: fillHalo, pointer: fillPointer, label: fillLabel }));
  check('approved actor fills the synthetic workspace field', (await actorPage.locator('#draft-field').inputValue()) === fillValue);

  await actorPage.waitForTimeout(650);
  check('presence cleans up after an authorized action completes', (await presenceObserver.snapshot()) === null);

  // Automatic scroll/focus tools use the same typed snapshot handle and actor
  // channel. Make the synthetic page deliberately long so the scroll outcome
  // is observable rather than inferred from a role match.
  await actorPage.evaluate(() => {
    document.body.style.minHeight = '2400px';
    const target = document.querySelector('#draft-field');
    if (target instanceof HTMLElement) target.style.marginTop = '1800px';
    window.scrollTo(0, 0);
  });
  const scrollStart = await actorPage.evaluate(() => window.scrollY);
  await seedWorkflow({ id: 'e2e-scroll-workflow', sessionId: createdSession.id, action: 'scroll-to', title: 'Find the draft field', input: { tabId: actorTabId, snapshotId: snapshot?.snapshotId ?? '', handle: field?.handle ?? '', target: 'Draft field' } });
  await send({ type: 'workflow-command', workflowId: 'e2e-scroll-workflow', command: 'resume' });
  const scrollPresence = await presenceObserver.during(async () => waitFor(async () => {
    const y = await actorPage.evaluate(() => window.scrollY);
    return y > scrollStart ? y : null;
  }));
  check('approved scroll-to moves the synthetic target into view with presence feedback',
    Boolean(scrollPresence) && (await actorPage.evaluate(() => window.scrollY)) > scrollStart);
  await seedWorkflow({ id: 'e2e-focus-workflow', sessionId: createdSession.id, action: 'focus-element', title: 'Focus the draft field', input: { tabId: actorTabId, snapshotId: snapshot?.snapshotId ?? '', handle: field?.handle ?? '', target: 'Draft field' } });
  await send({ type: 'workflow-command', workflowId: 'e2e-focus-workflow', command: 'resume' });
  const focusPresence = await presenceObserver.during(() => waitFor(async () => {
    const focused = await actorPage.evaluate(() => document.activeElement?.id === 'draft-field');
    return focused ? true : null;
  }));
  check('approved focus-element focuses the intended synthetic target with presence feedback',
    Boolean(focusPresence) && (await actorPage.evaluate(() => document.activeElement?.id === 'draft-field')));

  await send({ type: 'set-ai-preferences', showOnPagePointer: false });
  await seedWorkflow({ id: 'e2e-no-presence-fill', sessionId: createdSession.id, action: 'fill-form-field', title: 'Fill without pointer', input: { tabId: actorTabId, snapshotId: snapshot?.snapshotId ?? '', handle: field?.handle ?? '', value: 'pointer disabled', target: 'Draft field' } });
  await send({ type: 'workflow-command', workflowId: 'e2e-no-presence-fill', command: 'resume' });
  await refreshPanel();
  const disabledApproval = await waitFor(async () => (await state())?.approvals?.find((approval) => approval.action === 'fill-form-field' && approval.status === 'pending'));
  const disabledPresence = await presenceObserver.during(() => send({ type: 'decide-approval', approvalId: disabledApproval?.id, approved: true }), 700);
  await waitFor(async () => (await actorPage.locator('#draft-field').inputValue()) === 'pointer disabled', 10_000);
  check('turning off the trusted on-page pointer removes only the cue, not the approved fill', disabledPresence === null && (await actorPage.locator('#draft-field').inputValue()) === 'pointer disabled');
  await send({ type: 'set-ai-preferences', showOnPagePointer: true });

  await actorPage.emulateMedia({ reducedMotion: 'reduce' });
  await seedWorkflow({ id: 'e2e-reduced-motion-fill', sessionId: createdSession.id, action: 'fill-form-field', title: 'Fill with reduced motion', input: { tabId: actorTabId, snapshotId: snapshot?.snapshotId ?? '', handle: field?.handle ?? '', value: 'reduced motion', target: 'Draft field' } });
  await send({ type: 'workflow-command', workflowId: 'e2e-reduced-motion-fill', command: 'resume' });
  await refreshPanel();
  const reducedApproval = await waitFor(async () => (await state())?.approvals?.find((approval) => approval.action === 'fill-form-field' && approval.status === 'pending'));
  const reducedPresence = await presenceObserver.during(() => send({ type: 'decide-approval', approvalId: reducedApproval?.id, approved: true }));
  await waitFor(async () => (await actorPage.locator('#draft-field').inputValue()) === 'reduced motion', 10_000);
  check('reduced-motion feedback has no animated pointer travel',
    Boolean(reducedPresence?.layers.some((layer) => layer.className === 'motion-presence')) &&
      !reducedPresence?.layers.some((layer) => layer.className.includes('--animated')));
  await actorPage.emulateMedia({ reducedMotion: 'no-preference' });

  await seedWorkflow({ id: 'e2e-submit-workflow', sessionId: createdSession.id, action: 'submit-assignment', title: 'Submit assignment', input: { tabId: actorTabId, snapshotId: snapshot?.snapshotId ?? '', handle: submit?.handle ?? '', target: 'Synthetic Example Assignment', effect: 'This will create a final LMS submission.' } });
  await send({ type: 'workflow-command', workflowId: 'e2e-submit-workflow', command: 'resume' });
  await refreshPanel();
  const submitApproval = await waitFor(async () => (await state())?.approvals?.find((approval) => approval.action === 'submit-assignment'), 20_000);
  check('fresh approval blocks synthetic Submit', Boolean(submitApproval) && (await actorPage.locator('#form-result').textContent()) !== 'SUBMITTED', submitApproval?.effect ?? 'no approval');
  await panel.getByRole('button', { name: 'Review' }).click();
  const dialog = panel.getByRole('dialog');
  check('approval dialog explains target/effect and has no always-allow option', await dialog.isVisible() && (await dialog.innerText()).includes('Effect:') && !(await dialog.innerText()).toLowerCase().includes('always')); 
  await panel.keyboard.press('Tab');
  // `ConfirmDialog` is a native <dialog> opened with showModal(), so Chrome
  // traps focus for us. It carries the dialog role implicitly and has no
  // role attribute, so containment must be tested against the element, not
  // against a `[role="dialog"]` attribute selector.
  const approvalFocusTrapped = await panel.evaluate(() => {
    const open = document.querySelector('dialog[open]');
    return Boolean(open && document.activeElement && open.contains(document.activeElement));
  });
  check('approval dialog keeps keyboard focus inside the dialog', approvalFocusTrapped);
  await panel.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden', timeout: 3_000 });
  const focusRestored = await panel.evaluate(() => document.activeElement instanceof HTMLElement && /Review|Allow once/.test(document.activeElement.innerText));
  check('Escape cancels approval and restores focus to its action', focusRestored);
  await panel.getByRole('button', { name: 'Review' }).click();
  const submitPresence = await presenceObserver.during(() => dialog.getByRole('button', { name: 'Confirm' }).click());
  await waitFor(async () => (await actorPage.locator('#form-result').textContent()) === 'SUBMITTED', 10_000);
  check('confirmed synthetic Submit is the only path that submits and shows a closed-shadow click pulse',
    Boolean(submitPresence?.layers.some((layer) => layer.className.includes('__pulse'))) &&
      (await actorPage.locator('#form-result').textContent()) === 'SUBMITTED');
  const approvalReplay = await send({ type: 'decide-approval', approvalId: submitApproval.id, approved: true });
  check('stale or replayed approval cannot execute again', approvalReplay?.result === undefined || approvalReplay?.result === null || (await actorPage.locator('#form-result').textContent()) === 'SUBMITTED', 'single-use approval remains consumed');

  // A pending approval is deliberately expired in durable storage, then the
  // worker is stopped through CDP. The fresh worker must reject the old target
  // approval and ask again without touching the synthetic form.
  await actorPage.evaluate(() => { document.querySelector('#form-result').textContent = ''; });
  await seedWorkflow({ id: 'e2e-stale-approval-workflow', sessionId: createdSession.id, action: 'submit-assignment', title: 'Stale synthetic submit', input: { tabId: actorTabId, snapshotId: snapshot?.snapshotId ?? '', handle: submit?.handle ?? '', target: 'Synthetic Example Assignment', effect: 'This will create a final LMS submission.' } });
  await send({ type: 'workflow-command', workflowId: 'e2e-stale-approval-workflow', command: 'resume' });
  const pendingApproval = await waitFor(async () => (await state())?.approvals?.find((approval) => approval.action === 'submit-assignment' && approval.status === 'pending'), 20_000);
  await panel.evaluate(async (approvalId) => {
    await new Promise((resolve, reject) => {
      const request = indexedDB.open('motion');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction('approvals', 'readwrite');
        const store = tx.objectStore('approvals');
        const read = store.get(approvalId);
        read.onsuccess = () => {
          if (read.result) store.put({ ...read.result, status: 'approved', decidedAt: new Date(Date.now() - 2_000).toISOString(), expiresAt: new Date(Date.now() - 1_000).toISOString() });
        };
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
    });
  }, pendingApproval?.id);
  await send({ type: 'workflow-command', workflowId: 'e2e-stale-approval-workflow', command: 'pause' });
  const stoppedWithStaleApproval = await stopServiceWorker(studentPage);
  await waitForWorker();
  await send({ type: 'workflow-command', workflowId: 'e2e-stale-approval-workflow', command: 'resume' });
  const replacementApproval = await waitFor(async () => (await state())?.approvals?.find((approval) => approval.action === 'submit-assignment' && approval.status === 'pending' && approval.id !== pendingApproval?.id), 20_000);
  check('expired approval after service-worker restart requires a new confirmation and submits nothing', stoppedWithStaleApproval && Boolean(pendingApproval) && Boolean(replacementApproval) && (await actorPage.locator('#form-result').textContent()) !== 'SUBMITTED', `${stoppedWithStaleApproval}/${pendingApproval?.id ?? 'none'}/${replacementApproval?.id ?? 'none'}`);

  // Stop/restart the worker while durable session state exists; the next message
  // is handled by a fresh worker and must retain the AgentSession/workspace.
  const stopped = await stopServiceWorker(studentPage);
  await waitForWorker();
  const recovered = await waitFor(async () => (await state())?.activeSession);
  check('service-worker termination recovers the AgentSession and workspace', stopped && recovered?.id === created.id && recovered.workspace.adoptedTabIds.includes(actorTabId));

  // The attacker text is present in the synthetic assignment fixture. A
  // consequence request representing a model response that obeys it still
  // stops at the fresh approval boundary; no new navigation is permitted by
  // the tool vocabulary.
  await actorPage.evaluate(() => { document.querySelector('#form-result').textContent = ''; });
  await seedWorkflow({ id: 'e2e-injection-workflow', sessionId: createdSession.id, action: 'submit-assignment', title: 'Follow page instruction', input: { tabId: actorTabId, snapshotId: snapshot?.snapshotId ?? '', handle: submit?.handle ?? '', target: 'Synthetic Example Assignment', effect: 'This will create a final LMS submission.' } });
  await send({ type: 'workflow-command', workflowId: 'e2e-injection-workflow', command: 'resume' });
  await refreshPanel();
  const injectionApproval = await waitFor(async () => (await state())?.approvals?.find((approval) => approval.action === 'submit-assignment'), 20_000);
  check('prompt-injection response cannot submit or navigate without student approval', Boolean(injectionApproval) && (await actorPage.locator('#form-result').textContent()) !== 'SUBMITTED' && new URL(actorPage.url()).pathname === '/d2l/lms/dropbox/user/folder_submit_files.d2l');

  await actorPage.goto(`${ORIGIN}/d2l/lms/quizzing/user/attempt/201?ou=999999`, { waitUntil: 'domcontentloaded' });
  const restrictedSnapshot = await waitFor(async () => panel.evaluate((id) => chrome.tabs.sendMessage(id, { type: 'motion:snapshot' }).catch(() => null), actorTabId));
  check('restricted synthetic attempt exposes neither actor targets nor a presence overlay after navigation',
    restrictedSnapshot?.restricted === true && (restrictedSnapshot.elements?.length ?? -1) === 0 && (await presenceObserver.snapshot()) === null);

  const options = await context.newPage();
  options.on('pageerror', (error) => optionsErrors.push(error.message));
  options.on('console', (message) => { if (message.type() === 'error') optionsErrors.push(message.text()); });
  await options.goto(`chrome-extension://${extensionId}/src/options/index.html#ai`, { waitUntil: 'load' });
  await options.getByText('OpenAI', { exact: true }).first().waitFor({ state: 'visible', timeout: 10_000 }).catch(() => undefined);
  const optionsText = await options.locator('body').innerText();
  check('settings offers BYOK when local AI is unavailable', optionsText.includes('OpenAI') && optionsText.includes('API key'));

  await send({ type: 'set-provider-key', providerId: 'openai', key: CANARY });

  // Exercise the real extension-page -> worker provider path. Context routing
  // is used because the request originates in the MV3 service worker while
  // the panel is the extension document driving the turn.
  await send({ type: 'accept-cloud-disclosure', providerId: 'openai', accepted: true });
  await options.reload({ waitUntil: 'load' });
  const openAiRadio = options.locator('input[name="provider"]').nth(1);
  await openAiRadio.click();
  const openAiSelected = await waitFor(() => openAiRadio.isChecked(), 3_000);
  if (!openAiSelected) {
    console.log('SKIP  extension-page provider stream/cancel — Chromium did not grant the optional OpenAI host permission in headless mode');
  } else {
    await send({ type: 'set-ai-preferences', providerId: 'openai', model: 'gpt-5' });

    let responseCount = 0;
    let heldResponse;
    let releaseHeldResponse;
    let heldResponseReleased = false;
    const heldResponseDone = new Promise((resolve) => { releaseHeldResponse = resolve; });
    let providerRequestFailed = false;
    const onProviderRequestFailed = (request) => {
      if (request.url() === 'https://api.openai.com/v1/responses') providerRequestFailed = true;
    };
    context.on('requestfailed', onProviderRequestFailed);
    await context.route('https://api.openai.com/v1/models', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [{ id: 'gpt-5' }] }) });
    });
    await context.route('https://api.openai.com/v1/responses', async (route) => {
      responseCount += 1;
      if (responseCount === 1) {
        const event = (delta) => `event: response.output_text.delta\ndata: ${JSON.stringify({ delta })}\n\n`;
        await route.fulfill({ status: 200, contentType: 'text/event-stream', body: event('{"reply":"Streamed from OpenAI","plan":[]}') });
        return;
      }
      heldResponse = route;
      await heldResponseDone;
      if (!heldResponseReleased) return;
      await route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' }).catch(() => undefined);
    });

    await send({ type: 'session-message', sessionId: createdSession.id, text: 'Use the connected provider.', tabId: studentTabId });
    const streamed = await waitFor(async () => {
      const current = await state();
      return current?.activeSession?.conversation?.some((entry) => entry.text === 'Streamed from OpenAI') ? current.activeSession : null;
    }, 20_000);
    check('extension-page-driven provider stream renders and accumulates deltas', Boolean(streamed) && responseCount === 1);

    const stopMessage = send({ type: 'session-message', sessionId: createdSession.id, text: 'Hold this response.', tabId: studentTabId });
    await waitFor(() => responseCount === 2, 10_000);
    await send({ type: 'session-command', sessionId: createdSession.id, command: 'stop-generation' });
    if (heldResponse) await heldResponse.abort().catch(() => undefined);
    heldResponseReleased = true;
    releaseHeldResponse();
    await stopMessage.catch(() => undefined);
    check('stopping an extension-page-driven stream aborts the provider request', providerRequestFailed && responseCount === 2);
    context.off('requestfailed', onProviderRequestFailed);
    await context.unroute('https://api.openai.com/v1/models');
    await context.unroute('https://api.openai.com/v1/responses');
  }

  await installMockFetch(await waitForWorker(), [], '401');
  const invalid = await send({ type: 'test-provider', providerId: 'openai' });
  check('invalid API key gives understandable feedback', /API key is no longer valid/i.test(invalid?.result?.availability?.message ?? ''), 'worker/provider message is redacted and student-readable');

  // Secrets: only the session area may contain the canary, and no UI/IDB/log
  // path may echo it. This check intentionally never prints the key.
  const secretDump = await storageDump();
  const secretText = JSON.stringify({ local: secretDump.local, stores: secretDump.stores, state: await state(), workerErrors, panelErrors, optionsErrors, pageErrors });
  check('canary key is absent from local storage, every IndexedDB store, panel state, and logs', !secretText.includes(CANARY));
  check('canary key is not persisted outside session storage', JSON.stringify(secretDump.local).indexOf(CANARY) === -1 && !Object.values(secretDump.stores).some((records) => JSON.stringify(records).includes(CANARY)));
  await send({ type: 'forget-provider-key', providerId: 'openai' });
  const forgotten = await storageDump();
  check('forget key removes it from chrome.storage.session', !JSON.stringify(forgotten.session).includes(CANARY));

  await studentPage.bringToFront();
  await panel.waitForTimeout(300);
  const releaseButton = panel.getByRole('button', { name: 'Release' }).first();
  if (await releaseButton.count()) {
    await releaseButton.click();
    const released = await waitFor(async () => {
      const current = await state();
      return current?.activeSession?.workspace?.adoptedTabIds?.includes(studentTabId) ? null : current;
    });
    check('workspace Release removes the student tab from the live workspace', Boolean(released));
  } else {
    check('workspace Release removes the student tab from the live workspace', false, 'no Release control rendered');
  }

  // 200% zoom is checked against the actual rendered panel and options page.
  await panel.evaluate(() => { document.documentElement.style.zoom = '2'; });
  const panelZoom = await panel.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
  await options.evaluate(() => { document.documentElement.style.zoom = '2'; });
  const optionsZoom = await options.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
  check('panel and settings remain free of horizontal scroll at 200% zoom', panelZoom.scrollWidth <= panelZoom.clientWidth && optionsZoom.scrollWidth <= optionsZoom.clientWidth, `${panelZoom.scrollWidth}/${panelZoom.clientWidth}; ${optionsZoom.scrollWidth}/${optionsZoom.clientWidth}`);

  await studentPage.close();
  await listPage.close();
  await options.close();
  check('extension contexts raised no uncaught page errors', panelErrors.length === 0 && optionsErrors.length === 0 && pageErrors.length === 0, [...panelErrors, ...optionsErrors, ...pageErrors].join('; ').slice(0, 300));
  check('service worker raised no uncaught console errors', workerErrors.length === 0, workerErrors.join('; ').slice(0, 300));
} finally {
  await context.close();
  await rm(userDataDir, { recursive: true, force: true });
}

console.log(`\n${total - failures}/${total} checks passed`);
process.exit(failures === 0 ? 0 : 1);
