/** Real macOS Keychain + Chrome Native Messaging, with a synthetic key only. */
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn, execFileSync} from 'node:child_process';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {chromium} from 'playwright';

if (process.platform !== 'darwin') {
  console.log('SKIP native-channel restart check: requires macOS Keychain and branded Chrome.');
  process.exit(0);
}
const CANARY = 'sk-test-SYNTHETIC-KEYCHAIN-CANARY-20260928';
const directory = await mkdtemp(join(tmpdir(), 'motion-keychain-e2e-'));
const profile = join(directory, 'chrome');
const companion = join(directory, 'companion');
const port = 39428;
let browser, chromeProcess, extensionId, saved = false;
const captured = [];
let checks = 0;
let authorizedModelRequests = 0;
const modelServer = http.createServer((request,response)=>{
  if(request.url!=='/v1/models'||request.method!=='GET') {response.writeHead(404);response.end();return;}
  if(request.headers.authorization!==`Bearer ${CANARY}`) {response.writeHead(401);response.end();return;}
  authorizedModelRequests++;
  response.writeHead(200,{'content-type':'application/json'});
  response.end(JSON.stringify({data:[{id:'gpt-6-luna'}]}));
});
await new Promise((resolve,reject)=>{modelServer.once('error',reject);modelServer.listen(8934,'127.0.0.1',resolve);});
function pass(name) {checks++; console.log(`PASS  ${name}`);}
async function launch() {
  chromeProcess = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--enable-unsafe-extension-debugging',
  ], {stdio:'ignore'});
  let endpoint;
  for (let i = 0; i < 100; i++) {
    try {endpoint = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); break;}
    catch {await new Promise(r => setTimeout(r, 200));}
  }
  assert(endpoint, 'isolated Chrome did not start');
  browser = await chromium.connectOverCDP(endpoint.webSocketDebuggerUrl);
  const context = browser.contexts()[0];
  const cdp = await browser.newBrowserCDPSession();
  const loaded = await cdp.send('Extensions.loadUnpacked', {path:resolve('dist-e2e-keychain')});
  const worker = context.serviceWorkers().find(w=>w.url().includes(loaded.extensionId ?? loaded.id))
    ?? await context.waitForEvent('serviceworker');
  extensionId = loaded.extensionId ?? loaded.id ?? new URL(worker.url()).host;
  worker.on('console', message => captured.push(message.text()));
  return {context, worker};
}
async function close() {
  await browser?.close().catch(()=>undefined);
  chromeProcess?.kill('SIGTERM');
  browser = null;
  await new Promise(r=>setTimeout(r, 500));
}
function installation(action) {
  execFileSync('python3', ['native/install.py', action, '--extension-id', extensionId,
    '--browser', 'chrome', '--profile-dir', profile, '--install-dir', companion], {stdio:'pipe'});
}
async function nativeStatus(worker) {
  return worker.evaluate(()=>chrome.runtime.sendNativeMessage('com.motion.keychain',
    {version:1,operation:'status',providerId:'openai'}));
}
async function settings(context) {
  const page = await context.newPage();
  page.on('console', message=>captured.push(message.text()));
  await page.goto(`chrome-extension://${extensionId}/src/options/index.html#ai`);
  await page.locator('#openai-key').waitFor();
  return page;
}
async function status(page) {
  return page.evaluate(()=>chrome.runtime.sendMessage({type:'ai-status'}));
}
try {
  let {context, worker} = await launch();
  installation('--install');
  const initial = await nativeStatus(worker);
  assert.equal(initial.ok, true);
  assert.equal(initial.backend, 'macos-keychain');
  assert.equal(initial.present, false, 'existing key found; refusing to overwrite it');
  pass('isolated Chrome connects to the installed OS keychain companion');
  let page = await settings(context);
  let form = page.locator('form').filter({has:page.locator('#openai-key')});
  await form.getByLabel('Remember key securely on this device').check();
  await form.locator('#openai-key').fill(CANARY);
  saved = true;
  await form.getByRole('button',{name:'Save in OS keychain',exact:true}).click();
  await page.getByText('OpenAI key saved in your OS keychain.',{exact:true}).waitFor();
  let ai = await status(page);
  assert.equal(ai.ok,true);
  assert(ai.result.providers.some(p=>p.providerId==='openai'&&p.configured&&p.keyStorage==='keychain'));
  pass('Settings saves a synthetic key in the real macOS vault');
  let local = await page.evaluate(()=>chrome.storage.local.get(null));
  assert(!JSON.stringify(local).includes(CANARY));
  assert(!JSON.stringify(ai).includes(CANARY));
  assert(!(await page.locator('body').innerText()).includes(CANARY));
  pass('the key is absent from persistent browser storage, diagnostics and rendered UI');
  await close();
  ({context,worker} = await launch());
  const cacheCleared = await worker.evaluate(async()=>{
    const stored=await chrome.storage.session.get('motion.secret.openai');
    return stored['motion.secret.openai']===undefined;
  });
  assert(cacheCleared,'the restart did not clear the trusted session cache');
  page = await settings(context);
  ai = await status(page);
  assert(ai.result.providers.some(p=>p.providerId==='openai'&&p.configured&&p.keyStorage==='keychain'));
  form = page.locator('form').filter({has:page.locator('#openai-key')});
  await form.getByRole('button',{name:'Test connection',exact:true}).click();
  await page.getByText('OpenAI connection test succeeded.',{exact:true}).waitFor();
  assert(authorizedModelRequests>0,'the local provider did not receive the restored synthetic key');
  const restored = await worker.evaluate(async()=>{
    const stored=await chrome.storage.session.get('motion.secret.openai');
    return typeof stored['motion.secret.openai']==='string';
  });
  assert(restored);
  pass('a browser restart restores the remembered key into trusted session storage');
  form = page.locator('form').filter({has:page.locator('#openai-key')});
  await form.getByRole('button',{name:'Forget key',exact:true}).click();
  await page.getByText('OpenAI key forgotten.',{exact:true}).waitFor();
  assert.equal((await nativeStatus(worker)).present,false);
  ai = await status(page);
  assert(ai.result.providers.some(p=>p.providerId==='openai'&&!p.configured&&p.keyStorage==='session'));
  saved = false;
  pass('Forget key removes the vault entry and the current session copy');
  local = await page.evaluate(()=>chrome.storage.local.get(null));
  assert(!JSON.stringify(local).includes(CANARY));
  assert(!captured.join('\n').includes(CANARY));
  pass('native save, restart and forget do not log or persist the synthetic secret');
  console.log(`\n${checks}/${checks} checks passed`);
} finally {
  // Cleanup only our known synthetic entry, never an entry found at startup.
  if(saved) {
    // Even a failed UI wait may follow a committed vault write. Delete only
    // this test's exact canary, never another Motion profile's existing key.
    execFileSync('python3',['-c',
      'import sys;sys.path.insert(0,"native");from keychain_host import MacOSKeychainVault;v=MacOSKeychainVault();v.delete("openai") if v.get("openai")=="sk-test-SYNTHETIC-KEYCHAIN-CANARY-20260928" else None'],{stdio:'pipe'});
  }
  await close();
  if(extensionId) installation('--uninstall');
  await rm(directory,{recursive:true,force:true});
  await new Promise(resolve=>modelServer.close(resolve));
}
