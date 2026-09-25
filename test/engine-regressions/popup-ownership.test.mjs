import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { temporaryRoot } from '../../scripts/prototypes/support.mjs';
import { discoverBrowserExecutable } from '../../apps/mcp-server/src/browser-runtime/browser-discovery.ts';
import { createNewtonIdentity, openProfileStore } from '../../apps/mcp-server/src/browser-runtime/profile-store.ts';
import { ownedEngineConnection } from '../../apps/mcp-server/src/browser-runtime/engine-host.ts';
import { PageExecutor } from '../../packages/driver/src/page-executor.ts';
import { SessionEngine } from '../../packages/driver/src/session-engine.ts';

test('owned popups remain independently targetable without switching the selected page',{timeout:8000},async()=>{
  const temp=temporaryRoot('popup-ownership');let executor;
  const server=http.createServer((req,res)=>{res.setHeader('content-type','text/html');res.end(req.url==='/closing'?'<script>window.close()</script>':req.url==='/popup'
    ?'<title>Owned popup</title><button id="change" onclick="document.querySelector(\'p\').textContent=\'Popup changed\'">Change popup</button><p>Popup initial</p>'
    :'<title>Owned parent</title><button id="open" onclick="window.open(\'/popup\')">Open popup</button><button id="transient" onclick="window.open(\'/closing\')">Transient popup</button><p>Parent unchanged</p>');});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const store=openProfileStore(`${temp.root}/identities`),identity=createNewtonIdentity(store,{browserFamily:'chrome'});
    const connection=await ownedEngineConnection({executablePath:discoverBrowserExecutable({family:'chrome'}).path,browserFamily:'chrome',profileStore:store,identityId:identity.id,ephemeralIdentity:true});
    const pendingMethods=new Set(),trace=[];const original=connection.wire.send.bind(connection.wire);
    connection.wire.send=async(method,params,route)=>{const key=method+':'+route;pendingMethods.add(key);trace.push('start '+key);try{return await original(method,params,route);}catch(error){trace.push('error '+key+' '+error.message);throw error;}finally{pendingMethods.delete(key);trace.push('end '+key);}};
    executor=new PageExecutor(connection);await executor.start(`http://127.0.0.1:${server.address().port}/`);
    const parent=executor.bindPage(),engine=new SessionEngine('popup-ownership',executor);
    let attached;let timer;const attachment=new Promise((resolve,reject)=>{attached=resolve;timer=setTimeout(()=>reject(Error('popup attachment was not reported')),2000);});
    void attachment.catch(()=>{});
    const unsubscribe=connection.wire.onEvent(event=>{if(event.method==='Target.attachedToTarget'&&event.params.targetInfo?.type==='page'&&event.params.targetInfo.targetId!==parent.pageId)attached(event.params.targetInfo.targetId);});
    const opened=await engine.submit({commandId:1,timeoutMs:2000,action:{kind:'click',target:{kind:'selector',selector:'#open'}}});assert.equal(opened.reason,'completed',JSON.stringify({opened,pending:[...pendingMethods],attachments:executor.pendingAttachments.size,trace:trace.slice(-30)}));
    let popupId;try{popupId=await attachment;}finally{clearTimeout(timer);unsubscribe();}await Promise.all([...executor.pendingAttachments]);
    const pages=executor.directory.inventory();assert.equal(pages.length,2);assert.equal(executor.bindPage().pageId,parent.pageId);
    const popup=pages.find(page=>page.pageId===popupId);assert.ok(popup);
    assert.equal(popup.openerPageId,parent.pageId);assert.equal(popup.selected,false);assert.match(popup.url,/\/popup$/);
    const changed=await engine.submit({commandId:2,pageId:popupId,action:{kind:'click',target:{kind:'selector',selector:'#change'},waitFor:{text:'Popup changed',timeoutMs:1000}}});
    assert.equal(changed.reason,'completed');assert.equal(changed.postcondition.state,'met');
    assert.equal(executor.directory.inventory().find(page=>page.pageId===popupId).title,'Owned popup');
    const parentText=await engine.observe({pageId:parent.pageId,mode:'document'});assert.match(parentText.text,/Parent unchanged/);
    let destroyed;let closeTimer;const destruction=new Promise((resolve,reject)=>{destroyed=resolve;closeTimer=setTimeout(()=>reject(Error('transient popup did not close')),2000);});void destruction.catch(()=>{});
    const off=connection.wire.onEvent(event=>{if(event.method==='Target.targetDestroyed'&&![parent.pageId,popupId].includes(event.params.targetId))destroyed();});
    try{
      const transient=await engine.submit({commandId:3,pageId:parent.pageId,timeoutMs:2000,action:{kind:'click',target:{kind:'selector',selector:'#transient'}}});assert.equal(transient.reason,'completed',JSON.stringify({transient,trace:trace.slice(-25),fault:String(executor.fault)}));
      await destruction;await Promise.all([...executor.pendingAttachments]);
      assert.equal(executor.directory.inventory().length,2);
      const after=await engine.observe({pageId:parent.pageId,mode:'document'});assert.match(after.text,/Parent unchanged/);
    }finally{clearTimeout(closeTimer);off();}
  }finally{await executor?.close();await new Promise(resolve=>server.close(resolve));temp.remove();}
});
