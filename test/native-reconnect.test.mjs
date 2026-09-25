import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {temporaryRoot} from '../scripts/prototypes/support.mjs';
import {NativeChannel} from '../apps/mcp-server/src/native-wire.ts';
import {startNativeBroker} from '../apps/mcp-server/src/native-broker.ts';
import {waitForNativePeer} from '../apps/mcp-server/src/native-reconnect.ts';

function deferred(){let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};}
async function peer(root,epoch,onRequest){
  const input=new PassThrough(),output=new PassThrough();
  let wire;
  wire=new NativeChannel(output,input,message=>{if(message.type==='request')void onRequest(message,wire);},()=>{});
  const starting=startNativeBroker(root,input,output);
  await wire.send({type:'hello',protocolMajor:1,epoch,digest:'a'.repeat(64),capabilities:['update_binding']});
  const broker=await starting;
  return {async close(){wire.close();await broker.close();}};
}

test('reconnect rejects another live profile and observes a later advertisement without polling',{timeout:5000},async()=>{
  const temp=temporaryRoot('native-reconnect'),wrongSeen=deferred();let wrong,right,selected;
  try{
    wrong=await peer(temp.root,'other-profile',async(message,wire)=>{
      await wire.send({connectionId:message.connectionId,payload:{type:'response',id:message.request.id,error:'update_binding_lost'}});wrongSeen.resolve();
    });
    const finding=waitForNativePeer(temp.root,async client=>{await client.call('prove_update',{},true);return true;});
    await wrongSeen.promise;
    right=await peer(temp.root,'wanted-profile',async(message,wire)=>{
      await wire.send({connectionId:message.connectionId,payload:{type:'response',id:message.request.id,result:{tabId:5}}});
    });
    selected=await finding;
    assert.equal(selected.hello.epoch,'wanted-profile');assert.equal(selected.signal.aborted,false);
    assert.deepEqual(await selected.call('prove_update',{},true),{tabId:5},'selected peer remains usable after other probes retire');
  }finally{selected?.close();await wrong?.close();await right?.close();temp.remove();}
});

test('reconnect abort closes a peer while its proof request is unanswered',{timeout:5000},async()=>{
  const temp=temporaryRoot('native-reconnect-abort'),requested=deferred(),controller=new AbortController();let browser,probe;
  try{
    browser=await peer(temp.root,'pending-profile',()=>requested.resolve());
    const finding=waitForNativePeer(temp.root,async client=>{probe=client;await client.call('prove_update',{},true);return true;},{signal:controller.signal});
    const rejected=assert.rejects(finding,/native_reconnect_cancelled/);
    await requested.promise;controller.abort();await rejected;
    assert.equal(probe.signal.aborted,true);
  }finally{await browser?.close();temp.remove();}
});

test('reconnect deadline closes a nonmatching peer and rejects explicitly',{timeout:5000},async t=>{
  const temp=temporaryRoot('native-reconnect-deadline'),checked=deferred();let browser;
  try{
    browser=await peer(temp.root,'other-profile',()=>{});
    t.mock.timers.enable({apis:['setTimeout']});
    const finding=waitForNativePeer(temp.root,async()=>{checked.resolve();return false;},{timeoutMs:1000});
    const rejected=assert.rejects(finding,/native_reconnect_timeout/);
    await checked.promise;t.mock.timers.tick(1001);await rejected;
  }finally{t.mock.timers.reset();await browser?.close();temp.remove();}
});
