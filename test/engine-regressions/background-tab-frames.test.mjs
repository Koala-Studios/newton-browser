import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { temporaryRoot } from '../../scripts/prototypes/support.mjs';
import { createBrowserEngine } from '../../apps/mcp-server/src/embedding.ts';

// A link that opens a new tab moves Chrome's front to that tab. The session still works on its selected page,
// which Chrome no longer paints: live frames stopped and a person taking over saw nothing. Using a page fronts it.
test('the live view and reads of a page stay live after the site opens another tab', async () => {
  const temp = temporaryRoot('background-tab-frames');
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    if (req.url === '/b') res.end('<title>B</title><h1>Opened tab</h1>');
    else res.end('<title>A</title><a href="/b" target="_blank">open B</a>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const engine = createBrowserEngine({ configDirectory: temp.root, loginSource: 'access' });
  const json = result => JSON.parse(result.content.at(-1).text);
  try {
    const started = json(await engine.start({ url: `${origin}/a`, timeoutMs: 15_000 }));
    const link = started.observation.nodes.find(node => node.name?.includes('open B'));
    const clicked = json(await engine.call('browser.act', { sessionId: started.sessionId,
      command: { commandId: started.nextCommandId, action: { kind: 'click', target: { kind: 'ref', ref: link.ref } } } }));
    assert.equal(clicked.reason, 'completed', JSON.stringify(clicked).slice(0, 400));
    let pages = [];
    for (const deadline = Date.now() + 5000; Date.now() < deadline && pages.length < 2;) {
      pages = json(await engine.call('browser.pages.list', { sessionId: started.sessionId })).pages;
      if (pages.length < 2) await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(pages.length, 2);
    await new Promise(resolve => setTimeout(resolve, 1000)); // Let the opened tab take the front.
    const first = pages.find(page => page.url.endsWith('/a'));
    let frames = 0;
    const stop = await engine.frames(started.sessionId, () => { frames++; }, { pageId: first.pageId });
    await new Promise(resolve => setTimeout(resolve, 2000));
    await stop();
    assert.ok(frames > 0, 'the page the session works on keeps painting');
  } finally { await engine.close(); server.close(); temp.remove(); }
});
