// Diagnostic reproductions for the 2026-09-07 audit. This is not a passing
// conformance suite: `defectObserved` records current failures of the desired
// contract. All browser inputs and pages are synthetic, with isolated identities.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { performance } from 'node:perf_hooks';
import { createConfiguredDirectBrowserHost } from '../apps/mcp-server/src/browser-runtime/configured-direct-host.ts';
import { handleMcpMessage } from '../apps/mcp-server/src/mcp-server.ts';
import { startDirectDriverSession } from '../packages/driver/dist/direct-session-runtime.js';
import { createNewtonBrowserDriver } from '../packages/driver/dist/driver.js';
import { SessionCommandPump } from '../packages/driver/dist/session-command-pump.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newton-adversarial-audit-'));
const rows = [];
let driver;
let bootstrapTransport;
let calls = [];
let requestId = 0;
const html = `<!doctype html><html><head><title>Audit fixture</title></head><body>
<label>Read only<input id="readonly" readonly value="original"></label>
<label>Ordinary field<input id="ordinary" value="original"></label>
<label>Dynamic field<input id="dynamic" onfocus="this.type='password'"></label>
<label>Choice<select id="choice" onchange="document.querySelector('#accepted').textContent=event.isTrusted?'accepted':'ignored'"><option value="a">Alpha</option><option value="b">Beta</option></select></label>
<div id="accepted">untouched</div><button id="visible">Always visible</button>
<section>${Array.from({length: 100}, (_, i) => `<button id="b${i}" style="display:block">Control ${i}</button>`).join('')}</section>
<main>${'Synthetic readable text. '.repeat(1000)}</main>
</body></html>`;
const server = http.createServer((req, res) => {
  if (req.url === '/network-failure') { req.socket.destroy(); return; }
  res.writeHead(200, {'content-type':'text/html; charset=utf-8'}); res.end(html);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const host = createConfiguredDirectBrowserHost({
  profileStoreRoot: path.join(root, 'identities'),
  browserFamily: process.env.NEWTON_BROWSER_QA_BROWSER === 'edge' ? 'edge' : 'chrome',
  headless: true,
  startDriverSession: options => { bootstrapTransport=options.bootstrap.transport; return startDirectDriverSession({ ...options, driverFactory: config => {
    const port = config.debuggerPort;
    const wrapped = {
      attach: () => port.attach(), detach: () => port.detach(),
      onDebuggerEvent: listener => port.onDebuggerEvent(listener),
      sendCommand: (...args) => { calls.push(args[1]); return port.sendCommand(...args); },
    };
    driver = createNewtonBrowserDriver({...config, debuggerPort: wrapped}); return driver;
  }}); },
});
async function tool(name, args) {
  const start = performance.now(); calls = [];
  const response = await handleMcpMessage(host, {jsonrpc:'2.0',id:++requestId,method:'tools/call',params:{
    _meta:{'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientCapabilities':{}}, name, arguments:args,
  }});
  if (response?.error) return {rpcError:response.error,elapsedMs:Math.round(performance.now()-start)};
  const content = response?.result?.content?.find(x=>x.type==='text');
  return {...(content ? JSON.parse(content.text) : {}),elapsedMs:Math.round(performance.now()-start),cdpCalls:calls.length,axCalls:calls.filter(x=>x==='Accessibility.getFullAXTree').length};
}
function record(id, result) { rows.push({id,...result}); process.stdout.write(JSON.stringify(rows.at(-1))+'\n'); }
try {
  const invalid = await tool('browser.session.start',{origin:origin+'/deep/path'});
  record('start_full_url_rejected',{defectObserved:Boolean(invalid.rpcError),result:invalid});
  const start = await tool('browser.session.start',{origin});
  assert.ok(start.sessionId, JSON.stringify(start));
  const sessionId = start.sessionId;
  record('startup',{elapsedMs:start.elapsedMs,cdpCalls:start.cdpCalls});
  const version = await bootstrapTransport.send('Browser.getVersion',{});
  record('browser_version',{product:version.product,protocolVersion:version.protocolVersion});
  const act = action => tool('browser.act',{sessionId,action});
  const text = await tool('browser.observe',{sessionId,mode:'text',maxChars:200});
  record('text_budget_ignored',{defectObserved:JSON.stringify(text).length>1000,returnedChars:JSON.stringify(text).length,elapsedMs:text.elapsedMs});
  const readOnly = await act({kind:'fill',selector:'#readonly',value:'replacement'});
  const unchanged = await driver.evalBool("document.querySelector('#readonly').value==='original'");
  record('readonly_fill_false_verified',{defectObserved:readOnly.status==='verified'&&unchanged,result:readOnly,unchanged});
  const dynamic = await act({kind:'fill',selector:'#dynamic',value:'synthetic-marker'});
  const sensitiveInputReceived = await driver.evalBool("document.querySelector('#dynamic').type==='password' && document.querySelector('#dynamic').value.length>0");
  record('floor_target_changes_after_check',{defectObserved:sensitiveInputReceived,result:dynamic,sensitiveInputReceived});
  const batch = await act({kind:'fill_form',fields:[{selector:'#ordinary',value:'batch-change'},{selector:'#dynamic',value:'synthetic-marker'}]});
  const firstFieldChanged = await driver.evalBool("document.querySelector('#ordinary').value==='batch-change'");
  record('partial_batch_claims_prevented_retry_safe',{defectObserved:firstFieldChanged&&batch.outcome==='prevented'&&batch.retrySafe===true,result:batch,firstFieldChanged});
  const selected = await act({kind:'select',selector:'#choice',value:'b'});
  const untrustedEventIgnored = await driver.evalBool("document.querySelector('#accepted').textContent==='ignored'");
  record('select_untrusted_event',{defectObserved:selected.status==='verified'&&untrustedEventIgnored,result:selected,untrustedEventIgnored});
  const hidden = await act({kind:'wait_for',waitFor:{role:'button',name:'Always visible',state:'hidden',timeoutMs:100}});
  record('semantic_hidden_wait_false_success',{defectObserved:hidden.status==='verified',result:hidden});
  const full = await tool('browser.observe',{sessionId,format:'json',maxNodes:250,limit:200});
  record('public_node_cap',{defectObserved:full.result?.nodes?.length<driver.lastNodes.size,publicNodes:full.result?.nodes?.length,driverNodes:driver.lastNodes.size,budget:full.result?.budget});
  const focused = await tool('browser.observe',{sessionId,format:'json',query:'Control 99'});
  const late = focused.result?.nodes?.find(x=>x.name==='Control 99')?.ref;
  assert.ok(late, 'late fixture reference missing');
  const fill = await act({kind:'fill',selector:'#ordinary',value:'changed'});
  record('action_discards_observation',{defectObserved:fill.axCalls>0&&!('observation' in fill)&&!JSON.stringify(fill).includes('d1:e'),result:fill,fullObservationCalls:full.cdpCalls});
  const stale = await act({kind:'click',ref:late});
  record('implicit_observation_invalidates_unreturned_refs',{defectObserved:stale.errorCode==='stale_target',result:stale});
  const semantic = await act({kind:'click',role:'button',name:'Control 99',exact:true});
  record('semantic_target_beyond_default_cap',{defectObserved:semantic.errorCode==='not_found'||semantic.errorCode==='driver_error',result:semantic});
  const navigating = await act({kind:'navigate',url:origin+'/network-failure'});
  record('failed_navigation_false_verified',{defectObserved:navigating.status==='verified',result:navigating});
  await tool('browser.session.stop',{sessionId});
  assert.equal(host.listSessions().length,0);

  // Gate the executor explicitly: prove timeout delivery does not stop it or
  // release the queue. The watchdog keeps Node alive; it is not a flake sleep.
  const pump = new SessionCommandPump();
  let release; const gate = new Promise(resolve=>{release=resolve;});
  let continued = false;
  const keepAlive = setInterval(()=>{},1000);
  const timed = await pump.enqueue({},1,async()=>{await gate;continued=true;},10).catch(e=>e.code);
  const blocked = pump.snapshot();
  let stopped = false; const stop = pump.closeAfterCurrent().then(()=>{stopped=true;});
  await Promise.resolve();
  const stopBlocked = !stopped;
  release(); await stop; clearInterval(keepAlive);
  record('timeout_keeps_executor_and_stop_barrier',{defectObserved:continued&&stopBlocked,timed,blocked,continuedAfterTimeout:continued,stopBlockedUntilExecutorSettled:stopBlocked});
} finally {
  await host.close();
  assert.equal(host.listSessions().length,0);
  server.closeAllConnections(); await new Promise(resolve=>server.close(resolve));
  assert.equal(fs.readdirSync(path.join(root,'identities')).filter(x=>x.startsWith('nbi_')).length,0);
  const resolved = fs.realpathSync(root);
  assert.ok(path.basename(resolved).startsWith('newton-adversarial-audit-'));
  assert.equal(path.dirname(resolved).toLowerCase(),fs.realpathSync(os.tmpdir()).toLowerCase());
  fs.rmSync(resolved,{recursive:true,force:true});
}
const family=process.env.NEWTON_BROWSER_QA_BROWSER==='edge'?'edge':'chrome';
const report={date:'2026-09-07',platform:process.platform,node:process.version,browserFamily:family,rows,cleanupConfirmed:!fs.existsSync(root)};
fs.writeFileSync(path.resolve(`test/evidence/audit-current-runtime-2026-09-07-${family}.json`),JSON.stringify(report,null,2)+'\n');
if (process.argv.includes('--assert-correct') && rows.some(row=>row.defectObserved)) process.exitCode=1;
