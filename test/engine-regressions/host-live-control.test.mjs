import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { temporaryRoot } from '../../scripts/prototypes/support.mjs';
import { discoverBrowserExecutable } from '../../apps/mcp-server/src/browser-runtime/browser-discovery.ts';
import { createNewtonIdentity, openProfileStore } from '../../apps/mcp-server/src/browser-runtime/profile-store.ts';
import { EngineHost, ownedEngineConnection } from '../../apps/mcp-server/src/browser-runtime/engine-host.ts';
import { handleEngineMcp } from '../../apps/mcp-server/src/engine-mcp.ts';

const page = `<!doctype html><title>start</title><style>@keyframes s{from{opacity:.2}to{opacity:1}}#pulse{animation:s .3s infinite alternate}</style>
<input id=field aria-label="Name" oninput="document.title='typed:'+this.value" style="position:fixed;left:0;top:0;width:300px;height:40px;z-index:1">
<div id=pulse style="margin-top:160px">live</div>
<button id=enroll style="position:fixed;left:0;top:60px" onclick="enroll()">Create passkey</button>
<button id=login style="position:fixed;left:0;top:100px" onclick="login()">Sign in with passkey</button>
<script>
const bytes=n=>crypto.getRandomValues(new Uint8Array(n));
async function enroll(){try{await navigator.credentials.create({publicKey:{rp:{id:'localhost',name:'Fixture'},user:{id:bytes(16),name:'worker',displayName:'Worker'},challenge:bytes(32),pubKeyCredParams:[{type:'public-key',alg:-7}],authenticatorSelection:{residentKey:'required',userVerification:'required'}}});document.title='enrolled'}catch(e){document.title='enroll failed '+e.name}}
async function login(){try{await navigator.credentials.get({publicKey:{challenge:bytes(32),rpId:'localhost',userVerification:'required'}});document.title='signed in'}catch(e){document.title='login failed '+e.name}}
</script>`;

test('embedding host: live frames, operator takeover on the same page, and passkeys kept out of model output', async () => {
  const temp = temporaryRoot('host-live-control');
  const server = http.createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end(page); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://localhost:${server.address().port}/`;
  const store = openProfileStore(`${temp.root}/identities`);
  const host = new EngineHost(() => ownedEngineConnection({ executablePath: discoverBrowserExecutable({ family: 'chrome' }).path, browserFamily: 'chrome',
    profileStore: store, identityId: createNewtonIdentity(store, { browserFamily: 'chrome' }).id, ephemeralIdentity: true }));
  let id = 0; const modelOutput = [];
  const call = async (name, args) => {
    const reply = await handleEngineMcp(host, { jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }, { signal: new AbortController().signal });
    const text = reply.result.content.at(-1).text; modelOutput.push(text); return JSON.parse(text);
  };
  const title = async sessionId => (await call('browser.observe', { sessionId, maxBytes: 2048 })).observation.title;
  const until = async (check, ms = 5000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await check()) return true; await new Promise(r => setTimeout(r, 100)); } return false; };
  try {
    const events = [];
    const first = await host.start({ url }, { authenticator: [], onEvent: event => events.push(event) });
    const sessionId = first.sessionId;

    const frames = [];
    const stop = await host.frames(sessionId, frame => { frames.push(frame); });
    assert.ok(await until(() => frames.length > 0), 'frames arrive for a changing page');
    assert.equal(frames[0].mimeType, 'image/jpeg'); assert.ok(frames[0].width > 0);
    await stop();

    await host.pause(sessionId, 'captcha');
    const blocked = await call('browser.act', { sessionId, command: { commandId: 1, action: { kind: 'fill', target: { kind: 'selector', selector: '#field' }, value: 'model' } } });
    assert.equal(blocked.errorCode, 'operator_control'); assert.equal(blocked.nextCommandId, 1);
    await host.operatorInput(sessionId, { type: 'mouse', action: 'move', x: 20, y: 20 });
    await host.operatorInput(sessionId, { type: 'mouse', action: 'down', x: 20, y: 20 });
    await host.operatorInput(sessionId, { type: 'mouse', action: 'up', x: 20, y: 20 });
    await host.operatorInput(sessionId, { type: 'text', text: 'operator' });
    assert.equal(await title(sessionId), 'typed:operator', 'operator input reached the page');
    host.resume(sessionId);
    await assert.rejects(host.operatorInput(sessionId, { type: 'text', text: 'late' }), /operator_control/);
    const field = await call('browser.observe', { sessionId, query: { text: 'Name' } });
    assert.equal(field.observation.nodes[0].value ?? '', '', 'observation never exposes a value the model did not verify');
    const read = await call('browser.act', { sessionId, command: { commandId: 1, action: { kind: 'type', target: { kind: 'selector', selector: '#field' }, value: '!' } } });
    assert.equal(read.observation.nodes.find(node => node.name === 'Name').value, 'operator!', 'the operator typed into the same page the model continues on');

    await call('browser.act', { sessionId, command: { commandId: 2, action: { kind: 'click', target: { kind: 'semantic', role: 'button', name: 'Create passkey' } } } });
    assert.ok(await until(async () => (await title(sessionId)) === 'enrolled'), `enrollment: ${await title(sessionId)}`);
    const created = events.find(event => event.type === 'credential_created');
    assert.ok(created, JSON.stringify(events.map(event => event.type)));
    assert.equal(created.credential.rpId, 'localhost');
    await host.stop(sessionId);
    assert.ok(events.some(event => event.type === 'closed'));

    const used = [];
    const second = await host.start({ url }, { authenticator: [created.credential], onEvent: event => used.push(event) });
    await call('browser.act', { sessionId: second.sessionId, command: { commandId: 1, action: { kind: 'click', target: { kind: 'semantic', role: 'button', name: 'Sign in with passkey' } } } });
    assert.ok(await until(async () => (await title(second.sessionId)) === 'signed in'), `sign-in: ${await title(second.sessionId)}`);
    const assertion = used.find(event => event.type === 'credential_used');
    assert.ok(assertion && assertion.signCount > created.credential.signCount);

    const combined = modelOutput.join('\n');
    assert.ok(!combined.includes(created.credential.privateKey) && !combined.includes(created.credential.credentialId), 'no key material reaches the model');
  } finally { await host.close(); await new Promise(resolve => server.close(resolve)); temp.remove(); }
});
