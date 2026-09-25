import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { temporaryRoot } from '../../scripts/prototypes/support.mjs';
import { createBrowserEngine } from '../../apps/mcp-server/src/embedding.ts';

// D20: a model's Command chord on macOS must not stall the page (M3) and must reach the field.
test('Meta+A then Backspace clears a field promptly on macOS, with a frame on the page', { skip: process.platform !== 'darwin' && 'macOS shortcut' }, async () => {
  const page = '<!doctype html><title>t</title><input aria-label="Query" value="hello world"><iframe srcdoc="<p>frame</p>"></iframe>';
  const server = http.createServer((_request, response) => { response.setHeader('content-type', 'text/html'); response.end(page); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const temp = temporaryRoot('meta-chord');
  const engine = createBrowserEngine({ configDirectory: temp.root, loginSource: 'access' });
  const json = result => JSON.parse(result.content.at(-1).text);
  try {
    const started = json(await engine.start({ url: `http://127.0.0.1:${server.address().port}/` }));
    const { sessionId } = started;
    const ref = json(await engine.call('browser.observe', { sessionId })).observation.nodes.find(node => node.name === 'Query').ref;
    let next = started.nextCommandId;
    for (const keys of [['Meta', 'a'], ['Backspace']]) {
      const began = performance.now();
      const receipt = json(await engine.call('browser.act', { sessionId, command: { commandId: next, action: { kind: 'press', target: { kind: 'ref', ref }, keys } } }));
      assert.equal(receipt.reason, 'completed', JSON.stringify(receipt).slice(0, 300));
      assert.ok(performance.now() - began < 3000, `${keys.join('+')} took ${Math.round(performance.now() - began)} ms`);
      next = receipt.nextCommandId;
    }
    const field = json(await engine.call('browser.observe', { sessionId })).observation.nodes.find(node => node.name === 'Query');
    assert.equal(field.value ?? '', '');
  } finally { await engine.close(); server.close(); temp.remove(); }
});
