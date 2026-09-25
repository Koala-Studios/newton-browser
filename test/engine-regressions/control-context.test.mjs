import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { temporaryRoot } from '../../scripts/prototypes/support.mjs';
import { discoverBrowserExecutable } from '../../apps/mcp-server/src/browser-runtime/browser-discovery.ts';
import { createNewtonIdentity, openProfileStore } from '../../apps/mcp-server/src/browser-runtime/profile-store.ts';
import { EngineHost, ownedEngineConnection } from '../../apps/mcp-server/src/browser-runtime/engine-host.ts';
import { handleEngineMcp } from '../../apps/mcp-server/src/engine-mcp.ts';

test('MCP scoped views preserve row identity, validation and scope-compatible baselines',async()=>{
  const temp=temporaryRoot('control-context');
  const server=http.createServer((req,res)=>{res.setHeader('content-type','text/html');
    if(req.url==='/child'){res.end(`<p>Outside child scope</p><button id="change-child" onclick="document.getElementById('child-scope').textContent='Changed child content'">Change</button><article id="child-scope">${'<p>Scoped child paragraph.</p>'.repeat(160)}</article>`);return;}
    res.end(`<title>Control context</title>
    <table><tr id="row-a" aria-label="Row A"><td>A</td><td><button>Delete</button></td></tr><tr id="row-b" aria-label="Row B"><td>B</td><td><button>Delete</button></td></tr></table>
    <form aria-label="Profile"><label>Email<input id="email" aria-invalid="true" aria-errormessage="error" aria-describedby="help"></label><p id="error">Email is invalid</p><p id="help">Use your work email</p></form>
    <section id="empty" aria-label="Empty"></section><label><input type="checkbox" checked>Enabled</label>
    <div hidden><main>Hidden preferred main</main></div><p>Visible fallback paragraph</p><iframe src="/child"></iframe>`);});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const store=openProfileStore(`${temp.root}/identities`);
  const identity=createNewtonIdentity(store,{browserFamily:'chrome'});
  const host=new EngineHost(()=>ownedEngineConnection({executablePath:discoverBrowserExecutable({family:'chrome'}).path,browserFamily:'chrome',profileStore:store,identityId:identity.id,ephemeralIdentity:true}));
  let id=0;
  const call=async(name,args)=>{
    const reply=await handleEngineMcp(host,{jsonrpc:'2.0',id:++id,method:'tools/call',params:{name,arguments:args}},{signal:new AbortController().signal});
    const maxBytes=args.maxBytes??args.command?.maxBytes;
    if(maxBytes!==undefined)assert.ok(Buffer.byteLength(JSON.stringify(reply.result),'utf8')<=maxBytes,'actual MCP result respects its budget');
    const value=JSON.parse(reply.result.content[0].text);assert.ok(!reply.result.isError,JSON.stringify(value));return value;
  };
  try {
    const start=await call('browser.session.start',{url:`http://127.0.0.1:${server.address().port}/`});const sessionId=start.sessionId;
    const buttons=start.observation.nodes.filter(node=>node.name==='Delete');assert.equal(buttons.length,2);
    assert.ok(buttons.every(node=>node.context),JSON.stringify(start.observation));
    assert.deepEqual(buttons.map(node=>node.context.find(item=>item.role==='row').name),['Row A','Row B']);
    assert.equal(start.observation.nodes.find(node=>node.role==='checkbox').checked,true);
    const scoped=await call('browser.observe',{sessionId,scope:{kind:'selector',selector:'#row-a'},maxBytes:2048});
    assert.equal(scoped.observation.scope,'target');assert.deepEqual(scoped.observation.nodes.map(node=>node.name),['Delete']);
    const a=await call('browser.observe',{sessionId,mode:'records',scope:{kind:'selector',selector:'#row-a'}});
    const b=await call('browser.observe',{sessionId,mode:'records',scope:{kind:'selector',selector:'#row-b'},previousSnapshotId:a.observation.snapshotId});
    assert.equal(b.observation.delta.reset,true);assert.equal(b.nextCommandId,1);
    const empty=await call('browser.observe',{sessionId,scope:{kind:'selector',selector:'#empty'}});
    assert.equal(empty.observation.state,'available');assert.deepEqual(empty.observation.nodes,[]);
    const missing=await call('browser.observe',{sessionId,scope:{kind:'selector',selector:'#missing'}});
    assert.deepEqual(missing.observation,{state:'unavailable',errorCode:'not_found'});
    const edited=await call('browser.act',{sessionId,command:{commandId:1,maxBytes:2048,action:{kind:'fill',target:{kind:'selector',selector:'#email'},value:'draft'}}});
    assert.equal(edited.postcondition.state,'met');assert.equal(edited.observation.scope,'target');
    const field=edited.observation.nodes[0];assert.equal(field.value,'draft');assert.equal(field.invalid,true);
    assert.equal(field.description,'Use your work email');assert.deepEqual(field.validation,['Email is invalid']);
    const rootDocument=await call('browser.document.read',{sessionId});
    assert.match(rootDocument.observation.text,/Visible fallback paragraph/);assert.doesNotMatch(rootDocument.observation.text,/Hidden preferred main/);
    const first=await call('browser.document.read',{sessionId,scope:{kind:'selector',selector:'#child-scope'},maxBytes:2048});
    assert.ok(first.observation.cursor);assert.notEqual(first.observation.page.frameId,start.page.frameId);
    assert.doesNotMatch(first.observation.text,/Outside child scope|Visible fallback/);
    const changed=await call('browser.act',{sessionId,command:{commandId:2,action:{kind:'click',target:{kind:'selector',selector:'#change-child'},waitFor:{text:'Changed child content',timeoutMs:500}}}});
    assert.equal(changed.postcondition.state,'met');
    let chunk=first.observation;let collected=chunk.text;let chunks=1;
    while(chunk.cursor){assert.ok(chunks++<20,'bounded continuation progresses');chunk=(await call('browser.document.continue',{sessionId,cursor:chunk.cursor,maxBytes:2048})).observation;collected+=chunk.text;}
    assert.equal(collected,'Scoped child paragraph.\n'.repeat(160).trimEnd());
    const reload=await call('browser.act',{sessionId,command:{commandId:3,action:{kind:'reload'}}});assert.equal(reload.postcondition.state,'met');
    const expired=await call('browser.document.continue',{sessionId,cursor:first.observation.cursor});assert.deepEqual(expired.observation,{state:'unavailable',errorCode:'cursor_expired'});
  } finally {await host.close();await new Promise(resolve=>server.close(resolve));temp.remove();}
});
