import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { temporaryRoot } from '../../scripts/prototypes/support.mjs';
import { createBrowserEngine } from '../../apps/mcp-server/src/embedding.ts';
import { openProfileStore, listNewtonIdentities } from '../../apps/mcp-server/src/browser-runtime/profile-store.ts';

// Shared login through the embedding API: an operator signs in once in a maintenance
// session, Done publishes, and later worker sessions start signed in from their own copy.
test('embedding: operator sign-in publishes a login source that new sessions inherit', async () => {
  const temp = temporaryRoot('embedding-sign-in');
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    if (req.url === '/login') { res.setHeader('set-cookie', 'session=worker; Max-Age=3600; Path=/'); res.end('<title>signed in</title>'); return; }
    res.end(`<title>${/session=worker/.test(req.headers.cookie ?? '') ? 'account' : 'anonymous'}</title><a href="/login">Sign in</a>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const engine = createBrowserEngine({ configDirectory: temp.root, loginSource: 'access' });
  const text = result => JSON.parse(result.content.at(-1).text);
  try {
    assert.ok(engine.tools().some(tool => tool.name === 'browser.act'));
    assert.ok(!engine.tools().some(tool => tool.name.startsWith('browser.existing.')));
    const before = text(await engine.call('browser.session.start', { url }));
    assert.equal(before.observation.title, 'anonymous');
    await engine.stop(before.sessionId);

    const signIn = text(await engine.beginSignIn('access', { url }));
    await engine.pause(signIn.sessionId, 'sign_in');
    const frames = [];
    const stopFrames = await engine.frames(signIn.sessionId, frame => { frames.push(frame); });
    // The operator follows the sign-in link through the live view.
    const link = text(await engine.call('browser.observe', { sessionId: signIn.sessionId, query: { role: 'link' } })).observation.nodes[0];
    assert.equal(link.name, 'Sign in');
    await engine.operatorInput(signIn.sessionId, { type: 'mouse', action: 'move', x: 20, y: 15 });
    await engine.operatorInput(signIn.sessionId, { type: 'mouse', action: 'down', x: 20, y: 15 });
    await engine.operatorInput(signIn.sessionId, { type: 'mouse', action: 'up', x: 20, y: 15 });
    const deadline = Date.now() + 5000; let title = '';
    while (Date.now() < deadline && title !== 'signed in') { title = text(await engine.call('browser.observe', { sessionId: signIn.sessionId, maxBytes: 2048 })).observation.title; if (title !== 'signed in') await new Promise(r => setTimeout(r, 100)); }
    assert.equal(title, 'signed in');
    assert.ok(frames.length > 0);
    await stopFrames();
    const published = await engine.finishSignIn(signIn.sessionId, true);
    assert.match(published.generation, /^[0-9a-f-]{36}$/);

    const [a, b] = await Promise.all([engine.call('browser.session.start', { url }), engine.call('browser.session.start', { url })]);
    assert.equal(text(a).observation.title, 'account', 'a worker session starts signed in');
    assert.equal(text(b).observation.title, 'account', 'two workers share the login concurrently');
    await engine.stop(text(a).sessionId); await engine.stop(text(b).sessionId);
    const store = openProfileStore(`${temp.root}/identities`);
    assert.equal(listNewtonIdentities(store).length, 1, 'only the published generation remains');
  } finally { await engine.close(); await new Promise(resolve => server.close(resolve)); temp.remove(); }
});
