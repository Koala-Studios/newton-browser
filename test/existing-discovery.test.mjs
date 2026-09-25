import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {temporaryRoot} from '../scripts/prototypes/support.mjs';
import {NativeChannel} from '../apps/mcp-server/src/native-wire.ts';
import {startNativeBroker} from '../apps/mcp-server/src/native-broker.ts';
import {discoverExistingBrowser,discoverExistingDirectory} from '../apps/mcp-server/src/existing-connection.ts';
import {EngineHost} from '../apps/mcp-server/src/browser-runtime/engine-host.ts';
import {encodeEngineResult} from '../packages/core/src/receipt-encoding.ts';

test('discovery uses a live hello and bounded inventory without claiming or navigating tabs',{timeout:5000},async()=>{
  const temp=temporaryRoot('existing-discovery'),input=new PassThrough(),output=new PassThrough();let broker,peer;const methods=[];
  const tabs=[{tabId:1,title:'Current article',url:'https://example.test/article',claimed:false},{tabId:2,title:'Another worker',url:'https://example.test/work',claimed:true},
    {tabId:3,title:'Credentials in URL',url:'https://user:pass@example.test/',claimed:false},
    ...Array.from({length:125},(_,index)=>({tabId:index+4,title:'Long article '.repeat(50),url:'https://example.test/'+('long/'.repeat(200))+index,claimed:false}))];
  peer=new NativeChannel(output,input,message=>{
    if(message.type==='request'){
      methods.push(message.request.method);
      void peer.send({connectionId:message.connectionId,payload:{type:'response',id:message.request.id,result:{tabs}}});
    }
  },()=>{});
  try{
    const starting=startNativeBroker(temp.root,input,output);
    await peer.send({type:'hello',epoch:'current-browser',digest:'a'.repeat(64),protocolMajor:1,capabilities:['tab_claim','scoped_cdp','tab_inventory']});
    broker=await starting;
    const result=await discoverExistingBrowser(broker.advertisement);
    assert.equal(result.available,true);assert.equal(result.instanceId,'current-browser');assert.match(result.connectionId,/^existing_/);
    assert.equal(result.tabs[0].title,'Current article');assert.equal(result.tabs[1].claimed,true);
    assert.ok(!JSON.stringify(result).includes('user:pass'));assert.equal(result.incomplete,true);
    assert.ok(result.tabs.length<tabs.length);assert.ok(Buffer.byteLength(JSON.stringify(encodeEngineResult(result)))<=8192);
    assert.deepEqual(methods,['inventory']);
  }finally{await broker?.close();peer.close();temp.remove();}
});

test('configuration alone cannot report existing-browser readiness',async()=>{
  let connects=0;
  const host=new EngineHost(async()=>{throw Error('unused');},async()=>{connects++;throw Error('unused');});
  const result=await host.existingSetup();assert.equal(result.available,false);assert.equal(result.state,'not_ready');assert.equal(connects,0);
  await host.close();
});

test('a failed live probe reports unavailable without leaking a private filesystem path',async()=>{
  const host=new EngineHost(async()=>{throw Error('unused');},undefined,async()=>{throw Error('ENOENT private/path/token');});
  const result=await host.existingStatus();assert.equal(result.available,false);assert.equal(result.errorCode,'adapter_unavailable');assert.ok(!JSON.stringify(result).includes('private/path'));
  await host.close();
});

test('installed directory discovery keeps distinct profile identities within one escaped output budget',{timeout:5000},async()=>{
  const temp=temporaryRoot('existing-multiple'),peers=[],brokers=[],methods=[];
  try{
    for(const epoch of ['profile-one','profile-two']){
      const input=new PassThrough(),output=new PassThrough();let peer;
      peer=new NativeChannel(output,input,message=>{
        if(message.type!=='request')return;methods.push(message.request.method);
        void peer.send({connectionId:message.connectionId,payload:{type:'response',id:message.request.id,result:{tabs:Array.from({length:80},(_,index)=>({tabId:index+1,title:'escaped "title" '.repeat(30),url:`https://example.test/${epoch}/${index}`,claimed:false}))}}});
      },()=>{});peers.push(peer);
      const starting=startNativeBroker(temp.root,input,output);
      await peer.send({type:'hello',epoch,digest:'a'.repeat(64),protocolMajor:1,capabilities:['tab_claim','scoped_cdp','tab_inventory']});brokers.push(await starting);
    }
    const result=await discoverExistingDirectory(temp.root);
    assert.equal(result.available,true);assert.equal(result.incomplete,true);
    assert.equal(result.connections.length,2);assert.equal(new Set(result.connections.map(item=>item.connectionId)).size,2);
    assert.deepEqual(result.connections.map(item=>item.instanceId).sort(),['profile-one','profile-two']);
    assert.ok(Buffer.byteLength(JSON.stringify(encodeEngineResult(result)))<=8192);assert.deepEqual(methods,['inventory','inventory']);
  }finally{for(const broker of brokers)await broker.close();for(const peer of peers)peer.close();temp.remove();}
});
