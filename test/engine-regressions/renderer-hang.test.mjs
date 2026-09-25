import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { temporaryRoot } from '../../scripts/prototypes/support.mjs';
import { createBrowserEngine } from '../../apps/mcp-server/src/embedding.ts';

const page = `<!doctype html><title>app</title><p id="who"></p><button id="hang" onclick="for(;;){}">Freeze</button>
<script>who.textContent = 'cookie:' + document.cookie</script>`;

// A page that stops answering is reopened in the same session and identity instead of losing the session (D11).
test('a hung renderer is replaced by a new page at its address with the same sign-in', async () => {
  const temp = temporaryRoot('renderer-hang');
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    if (req.url === '/login') res.setHeader('set-cookie', 'session=kept; Path=/');
    res.end(page);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const engine = createBrowserEngine({ configDirectory: temp.root, loginSource: 'access' });
  const json = result => JSON.parse(result.content.at(-1).text);
  try {
    const started = json(await engine.start({ url: `${origin}/login` }));
    const { sessionId } = started;
    let receipt = json(await engine.call('browser.act', { sessionId, command: { commandId: started.nextCommandId, action: { kind: 'navigate', url: `${origin}/app` } } }));
    assert.equal(receipt.reason, 'completed');
    const freeze = json(await engine.call('browser.observe', { sessionId })).observation.nodes.find(node => node.name === 'Freeze');
    receipt = json(await engine.call('browser.act', { sessionId, command: { commandId: receipt.nextCommandId, timeoutMs: 3000, action: { kind: 'click', target: { kind: 'ref', ref: freeze.ref } } } }));
    assert.notEqual(receipt.reason, 'completed');
    assert.equal(receipt.pageRestarted?.url, `${origin}/app`, JSON.stringify(receipt).slice(0, 500));
    assert.equal(engine.sessions().find(item => item.sessionId === sessionId)?.state, 'open', 'the session stays open');
    let text = '';
    for (let i = 0; i < 40 && !/cookie:session=kept/.test(text); i++) {
      text = json(await engine.call('browser.document.read', { sessionId })).observation.text ?? '';
      if (!/cookie:/.test(text)) await new Promise(r => setTimeout(r, 100));
    }
    assert.match(text, /cookie:session=kept/, 'the new page has the same sign-in');
    const pages = json(await engine.call('browser.pages.list', { sessionId })).pages;
    assert.equal(pages.length, 1, 'the hung page is gone');
    assert.equal(pages[0].pageId, receipt.pageRestarted.pageId);
    receipt = json(await engine.call('browser.act', { sessionId, command: { commandId: receipt.nextCommandId, action: { kind: 'reload' } } }));
    assert.equal(receipt.reason, 'completed', JSON.stringify(receipt).slice(0, 600));
  } finally { await engine.close(); server.close(); temp.remove(); }
});
