import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { temporaryRoot } from '../../scripts/prototypes/support.mjs';
import { discoverBrowserExecutable } from '../../apps/mcp-server/src/browser-runtime/browser-discovery.ts';
import { createNewtonIdentity, openProfileStore } from '../../apps/mcp-server/src/browser-runtime/profile-store.ts';
import { ownedEngineConnection } from '../../apps/mcp-server/src/browser-runtime/engine-host.ts';
import { PageExecutor } from '../../packages/driver/src/page-executor.ts';
import { SessionEngine } from '../../packages/driver/src/session-engine.ts';

// Storefront conditions from 2026-10-03 QA of a live store and its theme preview: third-party
// frames that attach and vanish, a hidden 0x0 sync frame, a <details> mega menu, a signup popup
// over the header, an always-running slideshow, and app widgets in closed shadow roots.
function storeMarkup(port) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Storefront fixture</title><style>
  body { margin: 0; font: 16px sans-serif; }
  header { height: 80px; display: flex; gap: 24px; align-items: center; padding: 0 24px; }
  details { position: relative; } .panel { position: absolute; top: 32px; left: 0; width: 300px; background: #eee; padding: 12px; }
  #slide { position: absolute; top: 400px; left: 600px; width: 200px; height: 120px; }
  #signup { display: none; position: fixed; inset: 0; z-index: 9; background: rgba(0,0,0,.4); }
  #signup.open { display: block; }
  #sync { width: 0; height: 0; border: 0; position: absolute; }
</style></head><body>
<header><details id="menu"><summary>Energy Balls</summary><div class="panel"><a href="/cookie">Cookie Dough</a></div></details><a href="/about">About</a></header>
<main><h1>Storefront fixture</h1><button id="buy" style="position:absolute;top:200px;left:40px;width:160px;height:40px">Add to cart</button><button id="offer">Show offer</button><p id="log">none</p>
<x-reviews></x-reviews><div id="slide"></div></main>
<iframe id="sync" title="sync" src="http://localhost:${port}/frame"></iframe>
<div id="signup"><form aria-label="Mystery offer"><p>Mystery offer</p><button type="button">No thanks</button></form></div>
<script>
  const menu = document.getElementById('menu');
  menu.addEventListener('mouseenter', () => { menu.open = true; document.getElementById('log').textContent = 'menu:open'; });
  document.getElementById('buy').addEventListener('click', () => { document.getElementById('log').textContent = 'buy:clicked'; });
  document.getElementById('offer').addEventListener('click', () => document.getElementById('signup').classList.add('open'));
  customElements.define('x-reviews', class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: 'closed' }).innerHTML = '<p>Closed widget review text</p><slot></slot>'; } });
  let hue = 0; setInterval(() => { document.getElementById('slide').style.background = 'hsl(' + (hue = (hue + 40) % 360) + ' 80% 50%)'; }, 50);
  // Cross-site frames that attach and are removed at once, as storefront apps do while loading.
  let churn = 0;
  const timer = setInterval(() => {
    const frame = document.createElement('iframe');
    frame.src = 'http://localhost:${port}/frame?' + churn;
    document.body.append(frame);
    setTimeout(() => frame.remove(), 5);
    if (++churn >= 12) clearInterval(timer);
  }, 150);
</script></body></html>`;
}

async function withStore(callback) {
  const temp = temporaryRoot('storefront-pages');
  let server;
  let executor;
  await new Promise((resolve, reject) => {
    server = http.createServer((request, response) => {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.setHeader('cache-control', 'no-store');
      response.end(request.url.startsWith('/frame') ? '<!doctype html><p>frame</p>' : storeMarkup(server.address().port));
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const store = openProfileStore(`${temp.root}/identities`);
    const identity = createNewtonIdentity(store, { browserFamily: 'chrome' });
    const connection = await ownedEngineConnection({ executablePath: discoverBrowserExecutable({ family: 'chrome' }).path, browserFamily: 'chrome', profileStore: store, identityId: identity.id, ephemeralIdentity: true });
    executor = new PageExecutor(connection);
    await executor.start(`http://127.0.0.1:${server.address().port}/`, { viewport: { width: 1280, height: 800 } });
    const engine = new SessionEngine('storefront-pages', executor);
    let commandId = 0;
    const act = (action, observe = 'none') => engine.submit({ commandId: ++commandId, action, timeoutMs: 10000, maxBytes: 16384, observe });
    await callback({ engine, executor, act });
  } finally {
    await executor?.close();
    await new Promise(resolve => server.close(resolve));
    temp.remove();
  }
}

test('frames that attach and vanish do not block targets or screenshots', async () => {
  await withStore(async ({ engine, executor, act }) => {
    const hover = await act({ kind: 'hover', target: { kind: 'selector', selector: '#menu summary' } });
    assert.equal(hover.reason, 'completed', JSON.stringify(hover));
    // The churn runs for about two seconds; capture during and after it.
    for (let index = 0; index < 4; index++) {
      const shot = await engine.screenshot({});
      assert.equal(shot.state, 'available', JSON.stringify({ ...shot, imageData: undefined }));
      await new Promise(resolve => setTimeout(resolve, 400));
    }
    assert.equal(executor.pendingAttachments.size, 0);
    const reload = await act({ kind: 'navigate', url: (await engine.observe({})).url });
    assert.equal(reload.reason, 'completed', JSON.stringify(reload));
    const after = await engine.screenshot({ options: { fullPage: true } });
    assert.equal(after.state, 'available', JSON.stringify({ ...after, imageData: undefined }));
  });
});

test('a <summary> disclosure is a button control and a semantic hover target', async () => {
  await withStore(async ({ engine, act }) => {
    const view = await engine.observe({ query: { text: 'Energy Balls' } });
    const summary = view.nodes.find(node => node.name === 'Energy Balls');
    assert.deepEqual({ role: summary?.role, expanded: summary?.expanded }, { role: 'button', expanded: false }, JSON.stringify(view.nodes));
    const hover = await act({ kind: 'hover', target: { kind: 'semantic', role: 'button', name: 'Energy Balls' }, waitFor: { text: 'menu:open', timeoutMs: 2000 } });
    assert.equal(hover.postcondition.state, 'met', JSON.stringify(hover));
    const open = await engine.observe({ query: { text: 'Energy Balls' } });
    assert.equal(open.nodes.find(node => node.name === 'Energy Balls')?.expanded, true);
  });
});

test('a covered target names what covers it', async () => {
  await withStore(async ({ act }) => {
    const opened = await act({ kind: 'click', target: { kind: 'selector', selector: '#offer' } });
    assert.equal(opened.reason, 'completed', JSON.stringify(opened));
    const hover = await act({ kind: 'hover', target: { kind: 'selector', selector: '#menu summary' } });
    assert.deepEqual({ errorCode: hover.errorCode, dispatch: hover.dispatch, coveredBy: hover.steps[0]?.coveredBy }, { errorCode: 'target_covered', dispatch: 'not_started', coveredBy: 'form "Mystery offer"' });
  });
});

test('coordinates stay valid while animation runs elsewhere, and go stale where the page changed', async () => {
  await withStore(async ({ engine, act }) => {
    const shot = await engine.screenshot({});
    assert.equal(shot.state, 'available');
    const view = await engine.observe({ query: { text: 'Add to cart' } });
    assert.ok(view.nodes.some(node => node.name === 'Add to cart'));
    // #buy spans (40, 200)-(200, 240); the slideshow at (600, 400) changes every 50 ms.
    await new Promise(resolve => setTimeout(resolve, 300));
    const click = await act({ kind: 'click_at', captureId: shot.provenance.captureId, x: 120, y: 220 });
    assert.equal(click.reason, 'completed', JSON.stringify(click));
    assert.match((await engine.observe({ mode: 'document' })).text, /buy:clicked/);
    const animated = await engine.screenshot({});
    await new Promise(resolve => setTimeout(resolve, 300));
    const stale = await act({ kind: 'click_at', captureId: animated.provenance.captureId, x: 700, y: 460 });
    assert.equal(stale.errorCode, 'stale_target', JSON.stringify(stale));
  });
});

test('document reads include closed shadow roots', async () => {
  await withStore(async ({ engine }) => {
    const read = await engine.observe({ mode: 'document', maxBytes: 16384 });
    assert.match(read.text, /Closed widget review text/);
    assert.equal(read.complete, true);
  });
});
