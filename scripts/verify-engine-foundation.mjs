import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { EngineHost, ownedEngineConnection } from '../apps/mcp-server/src/browser-runtime/engine-host.ts';
import { openProfileStore, createNewtonIdentity } from '../apps/mcp-server/src/browser-runtime/profile-store.ts';
import { discoverBrowserExecutable } from '../apps/mcp-server/src/browser-runtime/browser-discovery.ts';
import { handleMcpMessage } from '../apps/mcp-server/src/mcp-server.ts';
import { temporaryRoot } from './prototypes/support.mjs';

const temp = temporaryRoot('engine-foundation');
const family = process.env.NEWTON_BROWSER_FAMILY ?? 'chrome';
const executable = discoverBrowserExecutable({ family }); assert.ok(executable);
const store = openProfileStore(path.join(temp.root, 'identities'));
let lastUrl; let fixtureValue; let crossReady;
const crossLoaded=new Promise(resolve=>{crossReady=resolve;});
const server = http.createServer((req, res) => {
  if(req.url==='/frames') { res.setHeader('Content-Type','text/html');res.end(`<label>Parent<input></label><iframe src="/child"></iframe><iframe src="http://localhost:${server.address().port}/child?cross"></iframe>`);return; }
  if(req.url==='/cross-ready') { crossReady();res.end('ok');return; }
  if(req.url.startsWith('/child')) { res.setHeader('Content-Type','text/html');res.end(`<label>${req.url.includes('cross')?'Cross frame':'Child'}<input></label>${req.url.includes('cross')?"<script>addEventListener('load',()=>fetch('/cross-ready'))</script>":''}`);return; }
  if (req.url.startsWith('/deep/')) lastUrl = req.url;
  if (req.url === '/saved') { fixtureValue = ''; req.on('data', chunk => { fixtureValue += chunk; }); res.end('ok'); return; }
  res.setHeader('Content-Type', 'text/html');
  res.end(`<title>Foundation fixture</title><label>Normal <input id="normal" oninput="fetch('/saved',{method:'POST',body:this.value})"></label><label>Sensitive on focus <input id="changing" onfocus="this.type='password'"></label>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const host = new EngineHost(async () => {
  const identity = createNewtonIdentity(store, { browserFamily: family });
  const connection=await ownedEngineConnection({ executablePath: executable.path, browserFamily: family, profileStore: store, identityId: identity.id, ephemeralIdentity: true });
  return connection;
});
let id = 0;
async function call(name, args) {
  const reply = await handleMcpMessage(host, { jsonrpc: '2.0', id: ++id, method: 'tools/call', params: {
    _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} }, name, arguments: args,
  } });
  assert.ok(!reply.error, JSON.stringify(reply));
  const result = JSON.parse(reply.result.content[0].text);
  assert.ok(!reply.result.isError, JSON.stringify(result)); return result;
}
const evidence = { date: new Date().toISOString(), family, checks: [] };
try {
  const launchAt=performance.now();
  const initial = await call('browser.session.start', { url: `http://127.0.0.1:${server.address().port}/deep/path?q=kept#fragment` });
  evidence.startMs=Math.round(performance.now()-launchAt);
  assert.equal(lastUrl, '/deep/path?q=kept');
  const target = initial.observation.nodes.find(node => node.name.trim() === 'Normal'); assert.ok(target, JSON.stringify(initial));
  const command = { commandId: 1, action: { kind: 'fill', target: { kind: 'ref', ref: target.ref }, value: 'real typed text' } };
  const actionAt=performance.now();const filled = await call('browser.act', { sessionId: initial.sessionId, command });
  evidence.fillMs=Math.round(performance.now()-actionAt);evidence.fillReceiptBytes=Buffer.byteLength(JSON.stringify(filled));
  assert.equal(filled.dispatch, 'acknowledged'); assert.equal(filled.postcondition.state, 'met');
  assert.equal(fixtureValue, 'real typed text');
  assert.deepEqual(await call('browser.act', { sessionId: initial.sessionId, command }), filled);
  const observed=await call('browser.observe',{sessionId:initial.sessionId});assert.equal(observed.nextCommandId,2);
  const sensitive = await call('browser.act', { sessionId: initial.sessionId, command: { commandId: 2, action: { kind: 'fill', target: { kind: 'selector', selector: '#changing' }, value: 'must-never-type' } } });
  assert.equal(sensitive.errorCode, 'sensitive_target'); assert.equal(sensitive.dispatch, 'acknowledged');
  assert.ok(!JSON.stringify(sensitive).includes('must-never-type'));
  await call('browser.session.stop', { sessionId: initial.sessionId });
  evidence.checks.push('MCP full URL / initial refs / typed fill / application-side effect / dedup / sensitive-on-focus / stop');
  const framed=await call('browser.session.start',{url:`http://127.0.0.1:${server.address().port}/frames`});
  let frameCommandId=1;
  for(const name of ['Child','Cross frame']) {
    let observation=framed.observation;
    if(name==='Cross frame') {await crossLoaded;observation=(await call('browser.observe',{sessionId:framed.sessionId})).observation;}
    const node=observation.nodes.find(node=>node.name.trim()===name);assert.ok(node,JSON.stringify(observation));
    const result=await call('browser.act',{sessionId:framed.sessionId,command:{commandId:frameCommandId++,action:{kind:'fill',target:{kind:'ref',ref:node.ref},value:'frame scoped value'},observe:'none'}});
    assert.equal(result.postcondition.state,'met',JSON.stringify(result));
  }
  await call('browser.session.stop',{sessionId:framed.sessionId});
  evidence.checks.push('same-origin and cross-site iframe refs resolve and fill independently');
  const online = await call('browser.session.start', { url: 'https://www.wikipedia.org/' });
  const search = online.observation.nodes.find(node => ['searchbox', 'textbox'].includes(node.role)); assert.ok(search, JSON.stringify(online));
  const onlineFill = await call('browser.act', { sessionId: online.sessionId, command: { commandId: 1, action: { kind: 'fill', target: { kind: 'ref', ref: search.ref }, value: 'Browser automation' } } });
  assert.equal(onlineFill.postcondition.state, 'met'); await call('browser.session.stop', { sessionId: online.sessionId });
  evidence.checks.push('Wikipedia real-page initial controls and verified native fill');
  evidence.pass = true;
} finally {
  await host.close(); await new Promise(resolve => server.close(resolve)); temp.remove();
  fs.writeFileSync(new URL(`../test/evidence/foundation-engine-${family}.json`, import.meta.url), JSON.stringify(evidence, null, 2) + '\n');
}
console.log(JSON.stringify(evidence));
