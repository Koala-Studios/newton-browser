// Live probe: where does raw CDP input land in a background tab (1) while a capture is in flight under an emulated
// device scale factor and (2) over a cross-site frame, with and without focus emulation. Owned headless Chrome; a
// second tab in front hides the page, as an operator's background tab is.
import http from 'node:http';
import { temporaryRoot } from '../prototypes/support.mjs';
import { discoverBrowserExecutable } from '../../apps/mcp-server/src/browser-runtime/browser-discovery.ts';
import { createNewtonIdentity, openProfileStore } from '../../apps/mcp-server/src/browser-runtime/profile-store.ts';
import { ownedEngineConnection } from '../../apps/mcp-server/src/browser-runtime/engine-host.ts';

const FRAME = `<!doctype html><style>html,body{margin:0;height:100%}button{width:100%;height:100%}</style><button id=b>frame</button>
<script>window.hits=[];document.addEventListener('mousedown',e=>hits.push([e.clientX,e.clientY]));</script>`;
const page = (port) => `<!doctype html><style>body{margin:0}iframe{position:absolute;left:300px;top:200px;width:200px;height:150px;border:0}</style>
<div style="height:3000px;background:linear-gradient(red,blue)"></div><iframe src="http://localhost:${port}/frame"></iframe>
<script>window.hits=[];document.addEventListener('mousedown',e=>hits.push([e.clientX,e.clientY]));</script>`;
const root = temporaryRoot('capture-input');
const server = http.createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end(req.url === '/frame' ? FRAME : page(server.address().port)); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const browser = discoverBrowserExecutable({ family: 'chrome', env: process.env });
const store = openProfileStore(`${root.root}/identities`);
const owned = await ownedEngineConnection({ executablePath: browser.path, browserFamily: 'chrome', profileStore: store, identityId: createNewtonIdentity(store, { browserFamily: 'chrome' }).id, ephemeralIdentity: true });
const wire = owned.wire;
const results = {};
try {
  const { targetId } = await wire.send('Target.createTarget', { url: `http://127.0.0.1:${port}/` });
  const { sessionId: tab } = await wire.send('Target.attachToTarget', { targetId, flatten: true });
  await wire.send('Target.createTarget', { url: 'about:blank' }); // in front: the probe tab is hidden
  const send = (method, params = {}, session = tab) => wire.send(method, params, session);
  await send('Page.enable'); await send('Runtime.enable');
  const frames = new Map();
  wire.onEvent(event => { if (event.method === 'Target.attachedToTarget' && event.params.targetInfo.type === 'iframe') frames.set(event.params.sessionId, event.params.targetInfo.url); });
  await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  await new Promise(resolve => setTimeout(resolve, 1500));
  const evaluate = async (expression, session = tab) => (await send('Runtime.evaluate', { expression, returnByValue: true }, session)).result.value;
  const click = async (x, y, session = tab) => { for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }, session); };
  const shot = (params = {}) => send('Page.captureScreenshot', { format: 'png', ...params });
  const screenDpr = await evaluate('devicePixelRatio');
  results.visibility = await evaluate('document.visibilityState');
  results.screenDpr = screenDpr;
  // (1) Emulated DPR differs from the display; input with a capture in flight.
  results.emulatedDpr = [];
  const captures = { plain: {}, clipScaled: { clip: { x: 0, y: 0, width: 800, height: 600, scale: 0.5 } }, beyond: { captureBeyondViewport: true, clip: { x: 0, y: 0, width: 800, height: 3000, scale: 1 } } };
  for (const rendering of [false, true]) for (const factor of [0.5, 2]) for (const [shape, params] of Object.entries(captures)) for (const delay of [0, 5, 20]) {
    await send('Emulation.setFocusEmulationEnabled', { enabled: rendering });
    await send('Emulation.setDeviceMetricsOverride', { width: 800, height: 600, deviceScaleFactor: screenDpr * factor, mobile: false });
    await evaluate('hits.length=0');
    const capturing = shot(params);
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    await click(100, 100);
    await capturing;
    const hits = await evaluate('hits.slice()');
    if (JSON.stringify(hits) !== '[[100,100]]') results.emulatedDpr.push({ rendering, factor, shape, delay, hits });
  }
  results.emulatedDprCases = 2 * 2 * 3 * 3;
  await send('Emulation.clearDeviceMetricsOverride');
  await send('Emulation.setFocusEmulationEnabled', { enabled: false });
  // (2) A top-level click over the cross-site frame, hidden, then with focus emulation.
  const frame = [...frames.keys()][0];
  for (const emulate of [false, true]) {
    await send('Emulation.setFocusEmulationEnabled', { enabled: emulate });
    await new Promise(resolve => setTimeout(resolve, 300));
    await evaluate('hits.length=0'); await evaluate('hits.length=0', frame);
    await click(400, 275);
    await new Promise(resolve => setTimeout(resolve, 300));
    results[emulate ? 'frameInputRendering' : 'frameInputHidden'] = { visibility: await evaluate('document.visibilityState'), top: await evaluate('hits.slice()'), frame: await evaluate('hits.slice()', frame) };
  }
} finally {
  await owned.close?.().catch(() => undefined);
  await owned.browser?.close?.().catch(() => undefined);
  server.close(); root.remove();
}
console.log(JSON.stringify(results, null, 2));
process.exit(0);
