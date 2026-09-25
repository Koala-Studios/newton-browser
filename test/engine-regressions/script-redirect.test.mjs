import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { temporaryRoot } from '../../scripts/prototypes/support.mjs';
import { createBrowserEngine } from '../../apps/mcp-server/src/embedding.ts';

// Sign-in pages (Shopify admin among them) replace themselves by script while still parsing, so the document
// Page.navigate started never reaches DOMContentLoaded. Start and navigate must settle on the replacing document
// instead of waiting for the abandoned one until the deadline.
test('start and navigate settle on a document that replaced the requested one by script', async () => {
  const temp = temporaryRoot('script-redirect');
  const held = [];
  const server = http.createServer((req, res) => {
    if (req.url === '/slow.js') { held.push(res); return; } // Never answers: the first document cannot finish parsing.
    res.setHeader('content-type', 'text/html');
    if (req.url?.startsWith('/entry')) res.end(`<!doctype html><title>entry</title><script>location.replace('/signed-out')</script><script src="/slow.js"></script><p>never</p>`);
    else res.end('<!doctype html><title>Log in</title><label>Email <input name="email"></label>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const engine = createBrowserEngine({ configDirectory: temp.root, loginSource: 'access' });
  const json = result => JSON.parse(result.content.at(-1).text);
  try {
    let begun = performance.now();
    const started = json(await engine.start({ url: `${origin}/entry`, timeoutMs: 15_000 }));
    assert.ok(started.sessionId, JSON.stringify(started));
    assert.ok(performance.now() - begun < 8_000, `start settled in ${Math.round(performance.now() - begun)} ms`);
    assert.equal(started.observation.url, `${origin}/signed-out`);
    assert.ok(started.observation.nodes.some(node => node.name?.includes('Email')), JSON.stringify(started.observation).slice(0, 600));
    begun = performance.now();
    const receipt = json(await engine.call('browser.act', { sessionId: started.sessionId,
      command: { commandId: started.nextCommandId, timeoutMs: 15_000, action: { kind: 'navigate', url: `${origin}/entry?again` } } }));
    assert.equal(receipt.reason, 'completed', JSON.stringify(receipt).slice(0, 600));
    assert.ok(performance.now() - begun < 8_000, `navigate settled in ${Math.round(performance.now() - begun)} ms`);
  } finally {
    await engine.close(); held.forEach(res => res.destroy()); server.close(); temp.remove();
  }
});
