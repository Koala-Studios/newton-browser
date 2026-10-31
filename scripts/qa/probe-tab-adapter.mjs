// Live probe of the tab adapter in a disposable Chromium (isolated HOME): does it free claims when a client dies or a
// command times out, can release close a created tab that asks "Leave site?", where does input sent during a plain
// screenshot land under an emulated device scale factor, and does a top-level click over a cross-site frame of a
// background tab reach the frame.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { spawn, fork, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launchChromium } from '../../apps/mcp-server/src/browser-runtime/chromium-process.ts';
import { temporaryRoot, pageConnection, navigate, deadline } from '../prototypes/support.mjs';

const temp = temporaryRoot('claim-release');
const packed = path.join(temp.root, 'packed'); await fs.mkdir(packed);
const version = JSON.parse(await fs.readFile(new URL('../../apps/mcp-server/package.json', import.meta.url), 'utf8')).version;
await promisify(execFile)('tar', ['-xf', path.resolve(`artifacts/newton-browser-${version}.tgz`), '-C', packed]);
const { unregisterNativeLocal } = await import(pathToFileURL(path.join(packed, 'package/dist/native-install.js')).href);
const candidate = pathToFileURL(path.join(packed, 'package/dist/embedding.js')).href;
const { connectNative } = await import(candidate);
const cli = path.join(packed, 'package/dist/index.js');
const isolatedHome = path.join(temp.root, 'home');
const userConfig = path.join(isolatedHome, 'Library', 'Application Support');
await fs.mkdir(userConfig, { recursive: true, mode: 0o700 });
const homeEnv = { HOME: isolatedHome };
const qaBrowserArgs = ['--enable-unsafe-extension-debugging', '--disable-features=DisableLoadExtensionCommandLineSwitch', '--use-mock-keychain'];
const cliCall = async (operation, ...args) => JSON.parse((await promisify(execFile)(process.execPath, [cli, 'adapter', operation, ...args], { env: { ...process.env, ...homeEnv, NEWTON_BROWSER_CONFIG_DIR: temp.root } })).stdout);
async function executable() {
  const cache = path.join(process.env.HOME, 'Library/Caches/ms-playwright');
  const build = (await fs.readdir(cache)).filter(name => /^chromium-\d+$/.test(name)).sort().at(-1);
  const mac = path.join(cache, build, (await fs.readdir(path.join(cache, build))).find(name => name.startsWith('chrome-mac')));
  const app = (await fs.readdir(mac)).find(name => name.endsWith('.app'));
  return path.join(mac, app, 'Contents', 'MacOS', app.slice(0, -4));
}
async function mirror(...profiles) {
  const chrome = path.join(userConfig, 'Google', 'Chrome', 'NativeMessagingHosts');
  for (const target of [path.join(userConfig, 'Chromium', 'NativeMessagingHosts'), path.join(userConfig, 'Google', 'Chrome for Testing', 'NativeMessagingHosts'), ...profiles.map(p => path.join(p, 'NativeMessagingHosts'))]) {
    await fs.mkdir(target, { recursive: true, mode: 0o700 });
    for (const name of await fs.readdir(chrome)) await fs.copyFile(path.join(chrome, name), path.join(target, name));
  }
}
const RECORD = `<script>window.hits=[];document.addEventListener('mousedown',e=>hits.push([e.clientX,e.clientY]));</script>`;
const server = http.createServer((req, res) => {
  res.setHeader('content-type', 'text/html');
  if (req.url === '/frame') return res.end(`<style>html,body{margin:0;height:100%}</style><button style="width:100%;height:100%">frame</button>${RECORD}`);
  if (req.url === '/input') return res.end(`<style>body{margin:0}iframe{position:absolute;left:300px;top:200px;width:200px;height:150px;border:0}</style>
<div style="height:2000px"></div><iframe src="http://localhost:${server.address().port}/frame"></iframe>${RECORD}`);
  res.end(`<title>Unsaved</title><button id=b onclick="window.dirty=true;this.textContent='dirty'">Edit</button>
<script>addEventListener('beforeunload',e=>{if(window.dirty){e.preventDefault();e.returnValue='';}});</script>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/`;
let browser, installation, extensionId; const results = {};
const withHomeUnregister = async (root, id) => { const previous = process.env.HOME; process.env.HOME = isolatedHome; try { await unregisterNativeLocal(root, id); } finally { process.env.HOME = previous; } };
const ms = (start) => Math.round(performance.now() - start);
try {
  const prepared = await cliCall('prepare'); extensionId = prepared.extensionId;
  await cliCall('setup');
  installation = { root: path.join(temp.root, 'tab-adapter-native') };
  const profile = path.join(temp.root, 'profile'); await fs.mkdir(profile);
  await mirror();
  browser = await launchChromium({ executablePath: process.env.NEWTON_BROWSER_PROTOTYPE_EXECUTABLE ?? await executable(), userDataDir: profile, browserFamily: 'chrome', headless: process.env.HEADED !== '1',
    spawn: (exe, args, options) => spawn(exe, [...args, ...qaBrowserArgs, `--load-extension=${prepared.directory}`], { ...options, env: { ...(options?.env ?? process.env), ...homeEnv } }) });
  await mirror(profile);
  const transport = browser.transport;
  const dev = await pageConnection(transport, (await transport.send('Target.createTarget', { url: 'about:blank' })).targetId);
  await navigate(dev, 'chrome://extensions/');
  const ax = await dev.send('Accessibility.getFullAXTree');
  const toggle = ax.nodes.find(node => node.name?.value === 'Developer mode' && node.backendDOMNodeId && ['switch', 'button', 'checkbox'].includes(node.role?.value));
  if (!toggle.properties?.some(p => ['checked', 'pressed'].includes(p.name) && p.value?.value === 'true')) {
    const { model } = await dev.send('DOM.getBoxModel', { backendNodeId: toggle.backendDOMNodeId });
    const x = (model.border[0] + model.border[4]) / 2, y = (model.border[1] + model.border[5]) / 2;
    await dev.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await dev.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  }
  const control = await pageConnection(transport, (await transport.send('Target.createTarget', { url: 'about:blank' })).targetId);
  await navigate(control, `chrome-extension://${extensionId}/setup.html`);
  const hello = (await deadline(control.send('Runtime.evaluate', { expression: "chrome.runtime.sendMessage({type:'status'})", awaitPromise: true, returnByValue: true }), 'status')).result?.value;
  assert.ok(hello?.epoch, 'adapter ready');
  const connectionDir = path.join(installation.root, 'connections');
  const advertisement = path.join(connectionDir, (await fs.readdir(connectionDir))[0]);
  const claimedTabs = async () => { const c = await connectNative(advertisement); try { return (await c.call('inventory', {}, true)).tabs.filter(tab => tab.claimed).map(tab => tab.tabId); } finally { c.close(); } };
  const tabCount = async () => (await transport.send('Target.getTargets')).targetInfos.filter(t => t.type === 'page' && t.url.startsWith(url)).length;
  const dirtyTab = async (client) => {
    const token = await client.call('create_tab', {});
    await client.call('command', { token, method: 'Page.enable', params: {} });
    await client.call('command', { token, method: 'Page.navigate', params: { url } });
    await new Promise(resolve => setTimeout(resolve, 500));
    await client.call('command', { token, method: 'Emulation.setFocusEmulationEnabled', params: { enabled: true } });
    for (const type of ['mousePressed', 'mouseReleased']) await client.call('command', { token, method: 'Input.dispatchMouseEvent', params: { type, x: 20, y: 15, button: 'left', clickCount: 1 } });
    const dirty = await client.call('command', { token, method: 'Runtime.evaluate', params: { expression: 'window.dirty===true', returnByValue: true } }, true);
    assert.equal(dirty.result.value, true, 'page has unsaved state');
    return token;
  };
  const wait = async (label, predicate, timeout = 15000) => { const end = Date.now() + timeout; while (Date.now() < end) { if (await predicate()) return true; await new Promise(r => setTimeout(r, 100)); } return false; };

  // A: client process dies holding a claim.
  {
    const child = fork(fileURLToPath(new URL('./probe-claim-holder.mjs', import.meta.url)), [candidate, advertisement], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    const [claimed] = await once(child, 'message');
    child.kill('SIGKILL'); await once(child, 'exit');
    const freed = await wait('A', async () => !(await claimedTabs()).includes(claimed.tabId));
    results.clientDied = { tabId: claimed.tabId, freed, claimedAfter: await claimedTabs() };
  }
  // B: a non-read-only command runs past the 10 s client limit.
  {
    const client = await connectNative(advertisement);
    const token = await client.call('create_tab', {});
    const start = performance.now();
    const outcome = await client.call('command', { token, method: 'Runtime.evaluate', params: { expression: 'new Promise(()=>{})', awaitPromise: true } }).then(() => 'resolved', error => error.message);
    const freed = await wait('B', async () => !(await claimedTabs()).includes(token.tabId));
    results.commandTimeout = { outcome, afterMs: ms(start), tabId: token.tabId, freed, claimedAfter: await claimedTabs(), closed: client.signal.aborted };
  }
  // B2: same, with the command stalled behind an open alert.
  {
    const client = await connectNative(advertisement);
    const token = await client.call('create_tab', {});
    await client.call('command', { token, method: 'Page.enable', params: {} });
    const outcome = await client.call('command', { token, method: 'Runtime.evaluate', params: { expression: 'alert("stall")' } }).then(() => 'resolved', error => error.message);
    const freed = await wait('B2', async () => !(await claimedTabs()).includes(token.tabId));
    results.commandTimeoutDialog = { outcome, tabId: token.tabId, freed, claimedAfter: await claimedTabs() };
  }
  // C: release with close on a created tab whose page asks "Leave site?".
  {
    const client = await connectNative(advertisement);
    const token = await dirtyTab(client);
    const before = await tabCount();
    const start = performance.now();
    const outcome = await client.call('release', { token, close: true }).then(() => 'released', error => error.message);
    const closed = await wait('C', async () => (await tabCount()) < before, 5000);
    results.releaseBeforeUnload = { outcome, afterMs: ms(start), tabClosed: closed, claimedAfter: await claimedTabs() };
    client.close();
  }
  // D: release without close of a tab with a pending "Leave site?" (navigation abandoned).
  {
    const client = await connectNative(advertisement);
    const token = await dirtyTab(client);
    const nav = client.call('command', { token, method: 'Page.navigate', params: { url: 'about:blank' } }).then(() => 'navigated', error => error.message);
    await new Promise(resolve => setTimeout(resolve, 500));
    const start = performance.now();
    const outcome = await client.call('release', { token }).then(() => 'released', error => error.message);
    const target = (await transport.send('Target.getTargets')).targetInfos.find(t => t.type === 'page' && t.url === url);
    const page = await deadline(pageConnection(transport, target.targetId), 'kept_page_attach', 3000).catch(() => undefined);
    const responsive = !page ? 'kept_page_attach_deadline' : await deadline(page.send('Runtime.evaluate', { expression: 'location.href+"|"+window.dirty', returnByValue: true }), 'kept_page', 3000).then(r => r.result.value, error => error.message);
    results.releasePendingDialog = { outcome, afterMs: ms(start), navigate: await nav, keptPage: responsive, claimedAfter: await claimedTabs() };
    client.close();
  }
  // E: input sent while a plain screenshot is in flight, with an emulated device scale factor twice the display's.
  // F: a top-level click over a cross-site frame of a background tab.
  {
    const client = await connectNative(advertisement);
    const frames = [];
    client.onEvent(message => { const event = message.event; if (event?.method === 'Target.attachedToTarget' && event.params.targetInfo?.type === 'iframe') frames.push(event.params.sessionId); });
    const token = await client.call('create_tab', {});
    const send = (method, params = {}, sessionId) => client.call('command', { token, method, params, ...(sessionId ? { sessionId } : {}) }, method.startsWith('Runtime.') || method === 'Page.captureScreenshot');
    const value = async (expression, sessionId) => (await send('Runtime.evaluate', { expression, returnByValue: true }, sessionId)).result.value;
    await send('Page.enable');
    await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    await send('Page.navigate', { url: url + 'input' });
    await wait('frame', async () => frames.length > 0 && await value('document.readyState').catch(() => '') === 'complete');
    const click = async (x, y) => { for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }); };
    const visibility = await value('document.visibilityState');
    const dpr = await value('devicePixelRatio');
    await send('Emulation.setDeviceMetricsOverride', { width: 800, height: 600, deviceScaleFactor: dpr * 2, mobile: false });
    await value('hits.length=0');
    const capturing = send('Page.captureScreenshot', { format: 'png' });
    await click(100, 100);
    await capturing;
    results.inputDuringCapture = { sentAt: [100, 100], landed: await value('hits.slice()') };
    await send('Emulation.clearDeviceMetricsOverride');
    await value('hits.length=0'); await value('hits.length=0', frames[0]);
    await click(400, 275);
    await new Promise(resolve => setTimeout(resolve, 300));
    results.backgroundFrameInput = { visibility, top: await value('hits.slice()'), frame: await value('hits.slice()', frames[0]) };
    await client.call('release', { token, close: true });
    client.close();
  }
} finally {
  if (browser) await browser.close().catch(() => undefined);
  if (installation) await withHomeUnregister(installation.root, extensionId).catch(() => undefined);
  await new Promise(resolve => server.close(resolve));
  temp.remove();
}
console.log(JSON.stringify(results, null, 2));
