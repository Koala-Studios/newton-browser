import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { temporaryRoot } from '../../scripts/prototypes/support.mjs';
import { createBrowserEngine } from '../../apps/mcp-server/src/embedding.ts';

const page = `<!doctype html><title>shop</title><style>.tile{cursor:pointer;padding:12px;display:inline-block}
#promo{position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center}
#promo .card{background:#fff;padding:24px}</style>
<main><h1>Products</h1><div class="tile" id="tile">Peanut balls</div><p id="out">none</p>
<a href="#top">Top</a></main>
<div id="promo"><div class="card">Get 10% off your first order<button id="close" onclick="promo.remove()">Close</button><div class="tile" onclick="promo.remove()">No thanks</div></div></div>
<script>tile.addEventListener('click',()=>{out.textContent='opened'})</script>`;

// Workers must see script-driven controls (D29) and a promotion covering the page (D4).
test('observe reports a covering layer first and role-less clickable elements the model can click', async () => {
  const temp = temporaryRoot('page-extras');
  const server = http.createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end(page); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const engine = createBrowserEngine({ configDirectory: temp.root, loginSource: 'access' });
  const json = result => JSON.parse(result.content.at(-1).text);
  try {
    const started = json(await engine.start({ url: `http://127.0.0.1:${server.address().port}/` }));
    const { sessionId } = started;
    let observed = json(await engine.call('browser.observe', { sessionId })).observation;
    assert.match(observed.cover?.text ?? '', /10% off/);
    assert.deepEqual(observed.nodes.slice(0, 2).map(node => node.name), ['Close', 'No thanks'], 'the covering layer\'s controls come first');
    const dismiss = observed.nodes.find(node => node.name === 'No thanks');
    assert.equal(dismiss.role, 'clickable');
    let receipt = json(await engine.call('browser.act', { sessionId, command: { commandId: started.nextCommandId, action: { kind: 'click', target: { kind: 'ref', ref: dismiss.ref } } } }));
    assert.equal(receipt.reason, 'completed', JSON.stringify(receipt).slice(0, 400));
    observed = json(await engine.call('browser.observe', { sessionId })).observation;
    assert.equal(observed.cover, undefined, 'no cover once dismissed');
    const tile = observed.nodes.find(node => node.name === 'Peanut balls');
    assert.equal(tile?.role, 'clickable', 'a script-driven div is discoverable');
    receipt = json(await engine.call('browser.act', { sessionId, command: { commandId: receipt.nextCommandId, action: { kind: 'click', target: { kind: 'ref', ref: tile.ref } } } }));
    assert.equal(receipt.reason, 'completed');
    const text = json(await engine.call('browser.document.read', { sessionId })).observation.text;
    assert.match(text, /opened/);
  } finally { await engine.close(); server.close(); temp.remove(); }
});
