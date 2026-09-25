import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { temporaryRoot } from '../../scripts/prototypes/support.mjs';
import { discoverBrowserExecutable } from '../../apps/mcp-server/src/browser-runtime/browser-discovery.ts';
import { createNewtonIdentity, openProfileStore } from '../../apps/mcp-server/src/browser-runtime/profile-store.ts';
import { ownedEngineConnection } from '../../apps/mcp-server/src/browser-runtime/engine-host.ts';
import { PageExecutor } from '../../packages/driver/src/page-executor.ts';
import { SessionEngine } from '../../packages/driver/src/session-engine.ts';

function rootMarkup(port) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Pointer fixture</title>
<style>
  #covered-wrap { position: relative; width: 220px; height: 70px; }
  #covered-target, #cover { position: absolute; inset: 0; width: 220px; height: 70px; }
  #cover { z-index: 2; background: rgba(0,0,0,.05); }
  iframe { display: block; width: 280px; height: 140px; margin: 24px 0 0 140px; border: 4px solid #444; }
</style></head><body><main>
<h1>Pointer fixture</h1>
<button id="hover-target">Hover target</button>
<button id="click-target">Click target</button>
<div id="covered-wrap"><button id="covered-target">Covered target</button><div id="cover"></div></div>
<pre id="event-log">none</pre>
<iframe title="Offset child" src="http://127.0.0.1:${port}/child"></iframe>
<div style="height:60px;overflow:auto"><button id="clipped-target" style="margin-top:240px" onclick="record('clipped:trusted='+event.isTrusted)">Clipped target</button></div>
<div style="height:1300px"></div><button id="offscreen-target" onclick="record('offscreen:trusted='+event.isTrusted+':scroll='+scrollY)">Offscreen target</button>
<script>
  const log = document.querySelector('#event-log');
  const events = [];
  function record(value) { events.push(value); log.textContent = events.join('|'); }
  document.querySelector('#hover-target').addEventListener('pointerenter', event => record('hover:pointerenter:trusted=' + event.isTrusted));
  document.querySelector('#click-target').addEventListener('click', event => record('click:' + event.button + ':' + event.detail));
  document.querySelector('#click-target').addEventListener('dblclick', event => record('dblclick:' + event.detail + ':trusted=' + event.isTrusted));
  document.querySelector('#click-target').addEventListener('contextmenu', event => { event.preventDefault(); record('contextmenu:' + event.button); });
  document.querySelector('#covered-target').addEventListener('click', () => record('covered:click'));
</script></main></body></html>`;
}

function childMarkup() {
  return `<!doctype html><html><body><main><button id="frame-target">Frame target</button><p id="frame-result">frame:initial</p>
<script>document.querySelector('#frame-target').addEventListener('click', () => { document.querySelector('#frame-result').textContent = 'frame:clicked'; });</script>
</main></body></html>`;
}

async function withFixture(callback) {
  const temp = temporaryRoot('pointer-actions');
  let server;
  let executor;
  await new Promise((resolve, reject) => {
    server = http.createServer((request, response) => {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.setHeader('cache-control', 'no-store');
      response.end(request.url === '/child' ? childMarkup() : rootMarkup(server.address().port));
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const store = openProfileStore(`${temp.root}/identities`);
    const identity = createNewtonIdentity(store, { browserFamily: 'chrome' });
    const connection = await ownedEngineConnection({ executablePath: discoverBrowserExecutable({ family: 'chrome' }).path, browserFamily: 'chrome', profileStore: store, identityId: identity.id, ephemeralIdentity: true });
    executor = new PageExecutor(connection);
    await executor.start(`http://127.0.0.1:${server.address().port}/`);
    await callback({ executor, engine: new SessionEngine('pointer-actions', executor) });
  } finally {
    if (executor) await executor.close();
    await new Promise((resolve) => server.close(resolve));
    temp.remove();
  }
}

async function submit(engine, commandId, action) {
  try {
    return await engine.submit({ commandId, timeoutMs: 2000, observe: 'local', maxBytes: 8192, action });
  } catch (error) {
    return { reason: 'thrown', errorCode: error?.code ?? error?.message, dispatch: 'not_started' };
  }
}

async function readFixture(engine) {
  const observation = await engine.observe({ mode: 'document', maxBytes: 8192, timeoutMs: 2000 });
  return observation.text ?? '';
}

function receiptSummary(receipt) {
  return JSON.stringify({ reason: receipt.reason, errorCode: receipt.errorCode, dispatch: receipt.dispatch, postcondition: receipt.postcondition });
}

function collect(failures, label, assertion) {
  try {
    assertion();
  } catch (error) {
    failures.push(`${label}: ${error.code ?? error.name}: ${String(error.message).split('\n', 1)[0]}`);
  }
}

test('hover and click variants produce trusted pointer effects', async () => {
  await withFixture(async ({ engine }) => {
    const failures = [];
    let commandId = 1;
    const hover = await submit(engine, commandId++, { kind: 'hover', target: { kind: 'selector', selector: '#hover-target' }, waitFor: { text: 'hover:pointerenter', timeoutMs: 1000 } });
    const hoverText = await readFixture(engine);
    collect(failures, 'hover receipt', () => assert.equal(hover.postcondition?.state, 'met', receiptSummary(hover)));
    collect(failures, 'trusted pointerenter effect', () => assert.match(hoverText, /hover:pointerenter:trusted=true/));

    const right = await submit(engine, commandId++, { kind: 'click', target: { kind: 'selector', selector: '#click-target' }, button: 'right', clickCount: 1, waitFor: { text: 'contextmenu:2', timeoutMs: 1000 } });
    const rightText = await readFixture(engine);
    collect(failures, 'right-click receipt', () => assert.equal(right.postcondition?.state, 'met', receiptSummary(right)));
    collect(failures, 'contextmenu effect', () => assert.match(rightText, /contextmenu:2/));
    collect(failures, 'right-click no left effect', () => assert.doesNotMatch(rightText, /click:0:/));

    const double = await submit(engine, commandId++, { kind: 'click', target: { kind: 'selector', selector: '#click-target' }, button: 'left', clickCount: 2, waitFor: { text: 'dblclick:2', timeoutMs: 1000 } });
    const doubleText = await readFixture(engine);
    collect(failures, 'double-click receipt', () => assert.equal(double.postcondition?.state, 'met', receiptSummary(double)));
    collect(failures, 'double-click detail effect', () => assert.match(doubleText, /click:0:2/));
    collect(failures, 'dblclick effect', () => assert.match(doubleText, /dblclick:2:trusted=true/));
    assert.equal(failures.length, 0, failures.join('\n'));
  });
});

test('covered targets refuse before pointer down', async () => {
  await withFixture(async ({ engine }) => {
    const before = await readFixture(engine);
    const receipt = await submit(engine, 1, { kind: 'click', target: { kind: 'selector', selector: '#covered-target' }, button: 'left', clickCount: 1 });
    const after = await readFixture(engine);
    const failures = [];
    collect(failures, 'covered target refusal code', () => assert.equal(receipt.errorCode, 'target_moved', receiptSummary(receipt)));
    collect(failures, 'covered target refusal dispatch', () => assert.equal(receipt.dispatch, 'not_started', receiptSummary(receipt)));
    collect(failures, 'covered target no click effect', () => assert.doesNotMatch(`${before}|${after}`, /covered:click/));
    assert.equal(failures.length, 0, failures.join('\n'));
  });
});

test('pointer targeting accounts for iframe offsets', async () => {
  await withFixture(async ({ engine }) => {
    const receipt = await submit(engine, 1, { kind: 'click', target: { kind: 'selector', selector: '#frame-target' }, button: 'left', clickCount: 1, waitFor: { text: 'frame:clicked', timeoutMs: 1000 } });
    assert.equal(receipt.postcondition?.state, 'met', receiptSummary(receipt));
  });
});

test('offscreen and overflow-clipped targets scroll through native CDP before one trusted click',async()=>{
  await withFixture(async({engine})=>{
    for(const [index,name] of ['offscreen','clipped'].entries()) {
      const receipt=await submit(engine,index+1,{kind:'click',target:{kind:'selector',selector:`#${name}-target`},waitFor:{text:`${name}:trusted=true`,timeoutMs:500}});
      assert.equal(receipt.postcondition?.state,'met',JSON.stringify(receipt));
      assert.equal(receipt.dispatch,'acknowledged');
    }
    assert.match(await readFixture(engine),/offscreen:trusted=true:scroll=[1-9]/);
  });
});
