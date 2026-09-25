import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { temporaryRoot } from '../../scripts/prototypes/support.mjs';
import { createBrowserEngine } from '../../apps/mcp-server/src/embedding.ts';

// Hosted workers browse the public internet only: a page on this machine stays unreachable,
// including through a public page that tries to load it.
test('public egress: loopback is unreachable, public sites load', async () => {
  const temp = temporaryRoot('egress-public');
  let localRequests = 0;
  const server = http.createServer((_req, res) => { localRequests++; res.setHeader('content-type', 'text/html'); res.end('<title>internal</title>'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const local = `http://127.0.0.1:${server.address().port}/`;
  const engine = createBrowserEngine({ configDirectory: temp.root, loginSource: 'access', env: { ...process.env, NEWTON_BROWSER_EGRESS: 'public' } });
  const text = result => JSON.parse(result.content.at(-1).text);
  try {
    const started = text(await engine.start({ url: 'https://example.com/' }));
    assert.equal(started.observation.title, 'Example Domain');
    const blocked = text(await engine.call('browser.act', { sessionId: started.sessionId, command: { commandId: started.nextCommandId, action: { kind: 'navigate', url: local } } }));
    assert.notEqual(blocked.observation?.title, 'internal');
    assert.equal(localRequests, 0, 'the local server was never reached');
    await engine.stop(started.sessionId);
  } finally { await engine.close(); server.close(); temp.remove(); }
});
