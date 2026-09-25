import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { temporaryRoot } from '../../scripts/prototypes/support.mjs';
import { discoverBrowserExecutable } from '../../apps/mcp-server/src/browser-runtime/browser-discovery.ts';
import { createNewtonIdentity, openProfileStore } from '../../apps/mcp-server/src/browser-runtime/profile-store.ts';
import { ownedEngineConnection } from '../../apps/mcp-server/src/browser-runtime/engine-host.ts';
import { PageExecutor } from '../../packages/driver/src/page-executor.ts';
import { SessionEngine } from '../../packages/driver/src/session-engine.ts';

test('native input returns an actionable prompt and exact dialog acceptance unblocks the page',async()=>{
  const temp=temporaryRoot('dialog-lifecycle');
  const server=http.createServer((req,res)=>{res.setHeader('content-type','text/html');res.end(`<button onclick="document.querySelector('output').textContent=prompt('Choose a label')??'dismissed'">Prompt</button><output></output>${req.url==='/initial'?"<script>alert('Initial dialog')</script>":''}`);});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let executor;
  try{
    const store=openProfileStore(`${temp.root}/identities`);const identity=createNewtonIdentity(store,{browserFamily:'chrome'});
    const connection=await ownedEngineConnection({executablePath:discoverBrowserExecutable({family:'chrome'}).path,browserFamily:'chrome',profileStore:store,identityId:identity.id,ephemeralIdentity:true});
    executor=new PageExecutor(connection);await executor.start(`http://127.0.0.1:${server.address().port}/`);
    const engine=new SessionEngine('dialogs',executor);
    const opened=await engine.submit({commandId:1,timeoutMs:1500,action:{kind:'click',target:{kind:'selector',selector:'button'}}});
    assert.equal(opened.reason,'completed',JSON.stringify(opened));
    assert.equal(opened.observation.scope,'dialog');
    assert.equal(opened.dispatch,'attempted');
    assert.equal(opened.postcondition.state,'unknown');
    const id=opened.observation.dialog.dialogId;
    const stale=await engine.submit({commandId:2,action:{kind:'dialog_accept',dialogId:'old'}});
    assert.equal(stale.errorCode,'stale_target');assert.equal(stale.dispatch,'not_started');
    const accepted=await engine.submit({commandId:3,action:{kind:'dialog_accept',dialogId:id,promptText:'chosen'}});
    assert.equal(accepted.postcondition.state,'met',JSON.stringify(accepted));
    const effect=await engine.submit({commandId:4,action:{kind:'wait_for',waitFor:{text:'chosen',timeoutMs:500}}});
    assert.equal(effect.postcondition.state,'met');
    const reopened=await engine.submit({commandId:5,action:{kind:'click',target:{kind:'selector',selector:'button'}}});
    assert.notEqual(reopened.observation.dialog.dialogId,id);
    const dismissed=await engine.submit({commandId:6,action:{kind:'dialog_dismiss',dialogId:reopened.observation.dialog.dialogId}});
    assert.equal(dismissed.postcondition.state,'met');
    const last=await engine.submit({commandId:7,action:{kind:'wait_for',waitFor:{text:'dismissed',timeoutMs:500}}});
    assert.equal(last.postcondition.state,'met');
    const keyed=await engine.submit({commandId:8,action:{kind:'press',target:{kind:'selector',selector:'button'},keys:['Enter']}});
    assert.equal(keyed.observation.scope,'dialog');
    const answered=await engine.submit({commandId:9,action:{kind:'dialog_dismiss',dialogId:keyed.observation.dialog.dialogId}});
    assert.equal(answered.postcondition.state,'met');
    const initial=await engine.submit({commandId:10,timeoutMs:1500,action:{kind:'navigate',url:`http://127.0.0.1:${server.address().port}/initial`}});
    assert.equal(initial.observation.scope,'dialog',JSON.stringify(initial));
    assert.equal(initial.observation.dialog.type,'alert');
  }finally{if(executor)await executor.close();await new Promise(resolve=>server.close(resolve));temp.remove();}
});
