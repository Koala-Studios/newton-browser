import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import {temporaryRoot} from '../../scripts/prototypes/support.mjs';
import {discoverBrowserExecutable} from '../../apps/mcp-server/src/browser-runtime/browser-discovery.ts';
import {createNewtonIdentity,openProfileStore} from '../../apps/mcp-server/src/browser-runtime/profile-store.ts';
import {ownedEngineConnection} from '../../apps/mcp-server/src/browser-runtime/engine-host.ts';
import {PageExecutor} from '../../packages/driver/src/page-executor.ts';
import {SessionEngine} from '../../packages/driver/src/session-engine.ts';

test('native editing commands select a bounded exact range without a temporary text mutation',async()=>{
  const temporary=temporaryRoot('native-selection');
  const server=http.createServer((_request,response)=>{
    response.setHeader('content-type','text/html; charset=utf-8');
    response.end(`<!doctype html><input id="plain" value="left-middle-right"><input id="unicode" value="a😀é-middle-end"><textarea id="lines">one\nmiddle\ntwo</textarea><div id="rich" contenteditable><b>left-</b><i>middle</i>-right</div><pre id="events"></pre><script>
      document.addEventListener('input',e=>document.querySelector('#events').textContent+=e.target.id+':'+e.isTrusted+'|');
    </script>`);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let executor;
  try{
    const browser=discoverBrowserExecutable({family:'chrome'});assert.ok(browser,'Chrome required');
    const store=openProfileStore(`${temporary.root}/identities`),identity=createNewtonIdentity(store,{browserFamily:'chrome'});
    const connection=await ownedEngineConnection({executablePath:browser.path,browserFamily:'chrome',profileStore:store,identityId:identity.id,ephemeralIdentity:true,headless:true});
    executor=new PageExecutor(connection);await executor.start(`http://127.0.0.1:${server.address().port}/`);
    const route=executor.directory.route(executor.directory.binding(executor.bindPage(),1));
    const send=(method,params)=>connection.wire.send(method,params,route);
    const read=async id=>{
      const reply=await send('Runtime.evaluate',{expression:`(()=>{const n=document.getElementById(${JSON.stringify(id)});return {value:n.value??n.textContent,start:n.selectionStart,end:n.selectionEnd,selected:getSelection().toString(),events:document.getElementById('events').textContent}})()`,returnByValue:true});
      assert.ok(!reply.exceptionDetails);return reply.result.value;
    };
    const document=await send('DOM.getDocument',{depth:0});
    for(const id of ['plain','unicode','lines','rich']){
      const {nodeId}=await send('DOM.querySelector',{nodeId:document.root.nodeId,selector:'#'+id});
      await send('DOM.focus',{nodeId});
      const before=await read(id),start=before.value.indexOf('middle'),end=start+6;
      const segments=[...new Intl.Segmenter('en',{granularity:'grapheme'}).segment(before.value)];
      const prefix=segments.filter(s=>s.index<start).length,count=segments.filter(s=>s.index>=start&&s.index<end).length;
      const commands=['moveToBeginningOfDocument',...Array(prefix).fill('moveForward'),...Array(count).fill('moveForwardAndModifySelection')];
      await send('Input.dispatchKeyEvent',{type:'rawKeyDown',key:'Unidentified',commands});
      await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Unidentified'});
      const selected=await read(id);
      assert.equal(selected.value,before.value,id+' selection preserves content');
      assert.equal(selected.events,before.events,id+' selection emits no input');
      if(id==='rich')assert.equal(selected.selected,'middle');
      else {assert.equal(selected.start,start,id);assert.equal(selected.end,end,id);}
      // This is the only text mutation. Cancellation before it leaves the old text.
      await send('Input.insertText',{text:'replacement'});
      const after=await read(id);
      assert.equal(after.value,before.value.slice(0,start)+'replacement'+before.value.slice(end),id);
      assert.equal(after.events,before.events+id+':true|');
    }
    const session=new SessionEngine('native_selection_probe',executor);
    let commandId=0;
    for(const id of ['plain','unicode','lines','rich']){
      const receipt=await session.submit({commandId:++commandId,action:{kind:'edit',target:{kind:'selector',selector:'#'+id},match:'replacement',replacement:'done'}});
      assert.equal(receipt.reason,'completed',JSON.stringify(receipt));
      assert.equal(receipt.postcondition.state,'met',JSON.stringify(receipt));
      assert.ok((await read(id)).value.includes('done'));
    }
    const deleted=await session.submit({commandId:++commandId,action:{kind:'edit',target:{kind:'selector',selector:'#plain'},match:'done',replacement:''}});
    assert.equal(deleted.postcondition.state,'met',JSON.stringify(deleted));
    assert.equal((await read('plain')).value,'left--right');

    const beforeCancel=await read('unicode'),originalSend=connection.wire.send.bind(connection.wire);
    let cancelSelection=true;
    connection.wire.send=async(method,params,sessionId)=>{
      const reply=await originalSend(method,params,sessionId);
      if(cancelSelection&&method==='Input.dispatchKeyEvent'&&params.commands){
        cancelSelection=false;session.command(commandId,true);
      }
      return reply;
    };
    const cancelled=await session.submit({commandId:++commandId,action:{kind:'edit',target:{kind:'selector',selector:'#unicode'},match:'done',replacement:'must-not-appear'}});
    connection.wire.send=originalSend;
    assert.equal(cancelled.reason,'cancelled',JSON.stringify(cancelled));
    const afterCancel=await read('unicode');
    assert.equal(afterCancel.value,beforeCancel.value);
    assert.equal(afterCancel.events,beforeCancel.events);
  }finally{
    await executor?.close();await new Promise(resolve=>server.close(resolve));temporary.remove();
  }
});
