import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import {temporaryRoot} from '../../scripts/prototypes/support.mjs';
import {discoverBrowserExecutable} from '../../apps/mcp-server/src/browser-runtime/browser-discovery.ts';
import {createNewtonIdentity,openProfileStore} from '../../apps/mcp-server/src/browser-runtime/profile-store.ts';
import {EngineHost,ownedEngineConnection} from '../../apps/mcp-server/src/browser-runtime/engine-host.ts';
import {handleEngineMcp} from '../../apps/mcp-server/src/engine-mcp.ts';
import {PageExecutor} from '../../packages/driver/src/page-executor.ts';
import {SessionEngine} from '../../packages/driver/src/session-engine.ts';

test('owned resize and file selection verify actual renderer effects through MCP',{timeout:10000},async()=>{
  const temp=temporaryRoot('resize-files');
  const server=http.createServer((_req,res)=>{res.setHeader('content-type','text/html');res.end(`<!doctype html><title>Resize fixture</title>
    <style>#narrow{display:none}@media(max-width:700px){#wide{display:none}#narrow{display:block}}</style>
    <main><h1 id="wide">Wide layout</h1><h1 id="narrow">Narrow layout</h1>
    <label>Media<input type="file" id="media" multiple></label><p id="effect"></p>
    <input type="file" id="hidden-media" hidden><input type="file" id="reject-media" onchange="this.value=''">
    <input type="file" id="dialog-media" onchange="alert('File selected')"></main>
    <script>document.querySelector('#media').addEventListener('change',e=>document.querySelector('#effect').textContent=[...e.target.files].map(f=>f.name).join(','));</script>`);});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const store=openProfileStore(`${temp.root}/identities`),identity=createNewtonIdentity(store,{browserFamily:'chrome'});
  let connection;
  const host=new EngineHost(async()=>connection=await ownedEngineConnection({executablePath:discoverBrowserExecutable({family:'chrome'}).path,browserFamily:'chrome',profileStore:store,identityId:identity.id,ephemeralIdentity:true}));
  let requestId=0;
  const call=async(name,args)=>{
    const reply=await handleEngineMcp(host,{jsonrpc:'2.0',id:++requestId,method:'tools/call',params:{name,arguments:args}},{signal:new AbortController().signal});
    const value=JSON.parse(reply.result.content[0].text);assert.ok(!reply.result.isError,JSON.stringify(value));return value;
  };
  try{
    const {sessionId}=await call('browser.session.start',{url:`http://127.0.0.1:${server.address().port}/`});
    const resized=await call('browser.act',{sessionId,command:{commandId:1,action:{kind:'resize',width:640,height:480},timeoutMs:2000}});
    assert.equal(resized.reason,'completed',JSON.stringify(resized));assert.equal(resized.postcondition.kind,'viewport');assert.equal(resized.postcondition.state,'met');
    const text=await call('browser.document.read',{sessionId});assert.match(text.observation.text,/Narrow layout/);assert.doesNotMatch(text.observation.text,/Wide layout/);
    const expanded=await call('browser.act',{sessionId,command:{commandId:2,action:{kind:'resize',width:1000,height:720},timeoutMs:2000}});
    assert.equal(expanded.reason,'completed',JSON.stringify(expanded));assert.equal(expanded.postcondition.state,'met');
    const wide=await call('browser.document.read',{sessionId});assert.match(wide.observation.text,/Wide layout/);assert.doesNotMatch(wide.observation.text,/Narrow layout/);
    const file=`${temp.root}/fixture image.png`;fs.writeFileSync(file,Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]));
    const selected=await call('browser.act',{sessionId,command:{commandId:3,action:{kind:'set_files',target:{kind:'selector',selector:'#media'},files:[file]},maxBytes:2048}});
    assert.equal(selected.reason,'completed',JSON.stringify(selected));assert.equal(selected.dispatch,'acknowledged');assert.deepEqual(selected.postcondition,{state:'met',kind:'files'});
    assert.deepEqual(selected.observation.nodes[0].fileNames,['fixture image.png']);assert.equal(selected.observation.nodes[0].fileCount,1);assert.ok(!JSON.stringify(selected).includes(temp.root));
    const effect=await call('browser.document.read',{sessionId});assert.match(effect.observation.text,/fixture image\.png/);
    const wrongTarget=await call('browser.act',{sessionId,command:{commandId:4,action:{kind:'set_files',target:{kind:'selector',selector:'#effect'},files:[file]},observe:'none'}});
    assert.equal(wrongTarget.errorCode,'target_not_editable');assert.equal(wrongTarget.dispatch,'not_started');assert.equal(wrongTarget.postcondition.kind,'files');
    const missing=await call('browser.act',{sessionId,command:{commandId:5,action:{kind:'set_files',target:{kind:'selector',selector:'#media'},files:[`${temp.root}/missing.png`]},observe:'none'}});
    assert.equal(missing.errorCode,'file_not_found');assert.equal(missing.dispatch,'not_started');
    const hidden=await call('browser.act',{sessionId,command:{commandId:6,action:{kind:'set_files',target:{kind:'selector',selector:'#hidden-media'},files:[file]}}});
    assert.equal(hidden.postcondition.state,'met',JSON.stringify(hidden));assert.deepEqual(hidden.observation.nodes[0].fileNames,['fixture image.png']);
    const rejected=await call('browser.act',{sessionId,command:{commandId:7,action:{kind:'set_files',target:{kind:'selector',selector:'#reject-media'},files:[file]}}});
    assert.equal(rejected.postcondition.state,'not_met');assert.equal(rejected.dispatch,'acknowledged');assert.equal(rejected.observation.nodes[0].fileCount,0);
    const modal=await call('browser.act',{sessionId,command:{commandId:8,timeoutMs:2000,action:{kind:'set_files',target:{kind:'selector',selector:'#dialog-media'},files:[file]}}});
    assert.equal(modal.observation.scope,'dialog',JSON.stringify(modal));assert.equal(modal.postcondition.kind,'files');assert.equal(modal.postcondition.state,'unknown');
    const dismissed=await call('browser.act',{sessionId,command:{commandId:9,action:{kind:'dialog_dismiss',dialogId:modal.observation.dialog.dialogId}}});
    assert.equal(dismissed.postcondition.state,'met');
  }finally{await host.close();await new Promise(resolve=>server.close(resolve));temp.remove();}
});

test('borrowed resize refuses before any browser command or input',async()=>{
  let sends=0;
  const executor=new PageExecutor({epoch:'borrowed',claimGeneration:1,signal:new AbortController().signal,wire:{send:async()=>{sends++;return {};},onEvent:()=>()=>{}},close:async()=>{}});
  executor.directory.registerRoute('r');executor.directory.addPage('p');executor.directory.navigate('p',{frameId:'f',route:'r',loaderId:'l'});
  const engine=new SessionEngine('borrowed-resize',executor);
  const receipt=await engine.submit({commandId:1,action:{kind:'resize',width:640,height:480},observe:'none'});
  assert.equal(receipt.errorCode,'unsupported_capability');assert.equal(receipt.dispatch,'not_started');assert.equal(sends,0);
  await engine.stop();
});
