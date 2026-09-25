import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { temporaryRoot } from '../../scripts/prototypes/support.mjs';
import { createBrowserEngine } from '../../apps/mcp-server/src/embedding.ts';

const page = `<!doctype html><title>diag</title><p id="out">ready</p>
<script>console.log('boot', 42, {a:1}); fetch('/api/items').then(r=>r.json()).then(j=>{out.textContent=j.items.join(',')});
fetch('/missing'); setTimeout(()=>{throw new Error('late boom')},0);</script>`;

function server() {
  return http.createServer((req, res) => {
    if (req.url === '/api/items') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ items: ['a', 'b'] })); return; }
    if (req.url === '/missing') { res.statusCode = 404; res.end('nope'); return; }
    res.setHeader('content-type', 'text/html'); res.end(page);
  });
}

// Website QA needs console errors and failing requests (D21). Recording is opt-in because enabling it is visible to pages.
test('console and network are recorded only once asked for, from the first load when start collects them', async () => {
  const temp = temporaryRoot('diagnostics');
  const http1 = server();
  await new Promise(resolve => http1.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${http1.address().port}`;
  const engine = createBrowserEngine({ configDirectory: temp.root, loginSource: 'access' });
  const json = result => JSON.parse(result.content.at(-1).text);
  const until = async (read, check) => { for (let i = 0; i < 40; i++) { const value = await read(); if (check(value)) return value; await new Promise(r => setTimeout(r, 100)); } return read(); };
  try {
    // Collected from the start.
    const started = json(await engine.start({ url: `${origin}/`, collect: ['console', 'network'] }));
    const { sessionId } = started;
    const consoleRead = await until(async () => json(await engine.call('browser.console', { sessionId })).console, value => value.entries.length >= 2);
    assert.equal(consoleRead.collecting, undefined);
    assert.ok(consoleRead.entries.some(entry => entry.level === 'log' && entry.text === 'boot 42 Object'), JSON.stringify(consoleRead.entries));
    assert.ok(consoleRead.entries.some(entry => entry.level === 'error' && /late boom/.test(entry.text)));
    const errors = json(await engine.call('browser.console', { sessionId, level: 'error' })).console.entries;
    assert.ok(errors.every(entry => entry.level === 'error'));
    const network = await until(async () => json(await engine.call('browser.network', { sessionId })).network, value => value.entries.some(entry => entry.url.endsWith('/api/items') && entry.status === 200));
    assert.ok(network.entries.some(entry => entry.url === `${origin}/` && entry.resourceType === 'Document'));
    assert.equal(JSON.stringify(network).includes('content-type'), false, 'no headers');
    const failed = json(await engine.call('browser.network', { sessionId, failedOnly: true })).network.entries;
    assert.deepEqual(failed.map(entry => [entry.url, entry.status]), [[`${origin}/missing`, 404]]);
    const api = network.entries.find(entry => entry.url.endsWith('/api/items'));
    const body = json(await engine.call('browser.network', { sessionId, requestId: api.requestId })).network.response;
    assert.deepEqual(JSON.parse(body.body), { items: ['a', 'b'] });
    json(await engine.call('browser.console', { sessionId, clear: true }));
    assert.equal(json(await engine.call('browser.console', { sessionId })).console.entries.length, 0);
    await engine.stop(sessionId);

    // Not collected until the first read; a reload then records the load.
    const lazy = json(await engine.start({ url: `${origin}/` }));
    const first = json(await engine.call('browser.console', { sessionId: lazy.sessionId, clear: true })).console;
    assert.equal(first.collecting, 'started');
    // Chromium hands over the current document's earlier messages when recording starts.
    assert.ok(first.entries.some(entry => /boot/.test(entry.text)), JSON.stringify(first));
    assert.equal(json(await engine.call('browser.console', { sessionId: lazy.sessionId })).console.entries.length, 0);
    const receipt = json(await engine.call('browser.act', { sessionId: lazy.sessionId, command: { commandId: lazy.nextCommandId, action: { kind: 'reload' } } }));
    assert.equal(receipt.reason, 'completed', JSON.stringify(receipt).slice(0, 300));
    const after = await until(async () => json(await engine.call('browser.console', { sessionId: lazy.sessionId })).console, value => value.entries.length >= 2);
    assert.ok(after.entries.some(entry => /boot/.test(entry.text)));
  } finally { await engine.close(); http1.close(); temp.remove(); }
});
