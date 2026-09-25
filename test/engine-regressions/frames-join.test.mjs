import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { temporaryRoot } from '../../scripts/prototypes/support.mjs';
import { createBrowserEngine } from '../../apps/mcp-server/src/embedding.ts';

// A still page produces no new screencast frames: a viewer that joins later (someone takes
// control while another is watching) must still see the page.
test('a frame listener joining a running screencast of a still page receives the current frame', async () => {
  const temp = temporaryRoot('frames-join');
  const server = http.createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end('<title>still</title><h1>Still page</h1>'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const engine = createBrowserEngine({ configDirectory: temp.root, loginSource: 'access' });
  const until = async (check, ms = 5000) => { const end = Date.now() + ms; while (Date.now() < end) { if (check()) return true; await new Promise(r => setTimeout(r, 50)); } return check(); };
  try {
    const { sessionId } = JSON.parse((await engine.start({ url: `http://127.0.0.1:${server.address().port}/` })).content.at(-1).text);
    const first = [], second = [];
    const stopFirst = await engine.frames(sessionId, frame => { first.push(frame); });
    assert.ok(await until(() => first.length > 0), 'the first viewer sees the page');
    await new Promise(resolve => setTimeout(resolve, 500));
    const stopSecond = await engine.frames(sessionId, frame => { second.push(frame); });
    assert.ok(await until(() => second.length > 0, 2000), 'the joining viewer sees the page without waiting for a change');
    await stopSecond(); await stopFirst();
  } finally { await engine.close(); server.close(); temp.remove(); }
});
