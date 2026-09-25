import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs/promises';
import {PassThrough} from 'node:stream';
import {startNativeBroker} from '../apps/mcp-server/src/native-broker.ts';
import {NativeChannel,nativeFrame} from '../apps/mcp-server/src/native-wire.ts';
import {nativePackets} from '../packages/core/src/native-packets.ts';
import {temporaryRoot} from '../scripts/prototypes/support.mjs';

const hello={type:'hello',protocolMajor:1,epoch:'test-browser-instance',digest:'a'.repeat(64)};
function send(stream,value){for(const packet of nativePackets('startup-test',value))stream.write(nativeFrame(packet));}

test('a native endpoint is advertised only after a validated browser hello',async t=>{
  const temp=temporaryRoot('native-startup'),input=new PassThrough(),output=new PassThrough();output.resume();
  let listening;const heardListen=new Promise(resolve=>{listening=resolve;});
  const originalListen=net.Server.prototype.listen;
  t.mock.method(net.Server.prototype,'listen',function(...args){const callback=args.pop();return originalListen.apply(this,[...args,()=>{callback();listening();}]);});
  let advertisements=0;
  const write=fs.writeFile;
  t.mock.method(fs,'writeFile',async(...args)=>{if(String(args[0]).includes('connection-'))advertisements++;return write(...args);});
  const starting=startNativeBroker(temp.root,input,output);let broker,client;
  try{
    await heardListen;assert.equal(advertisements,0,'listening alone must not advertise browser readiness');
    send(input,hello);broker=await starting;assert.equal(advertisements,1);
    const info=JSON.parse(await fs.readFile(broker.advertisement,'utf8'));
    const socket=net.connect(info.endpoint);
    const greeting=new Promise((resolve,reject)=>{client=new NativeChannel(socket,socket,resolve,()=>reject(Error('unexpected disconnect')));});
    await client.send({type:'connect',protocolMajor:1,token:info.token});
    const actual=await greeting;assert.equal(actual.epoch,hello.epoch);assert.equal(actual.digest,hello.digest);
  }finally{client?.close();await broker?.close();input.destroy();output.destroy();t.mock.restoreAll();temp.remove();}
});

test('malformed native hello rejects startup and publishes no advertisement',async()=>{
  const temp=temporaryRoot('native-startup-invalid'),input=new PassThrough(),output=new PassThrough();output.resume();
  try{
    const starting=startNativeBroker(temp.root,input,output);
    send(input,{...hello,digest:'invalid'});
    await assert.rejects(starting,/native_protocol_mismatch/);
    assert.deepEqual((await fs.readdir(temp.root)).filter(name=>name.startsWith('connection-')),[]);
  }finally{input.destroy();output.destroy();temp.remove();}
});

test('native disconnect before hello rejects startup without a discoverable orphan',async()=>{
  const temp=temporaryRoot('native-startup-disconnect'),input=new PassThrough(),output=new PassThrough();output.resume();
  try{
    const starting=startNativeBroker(temp.root,input,output);input.end();
    await assert.rejects(starting,/connection_lost/);
    assert.deepEqual((await fs.readdir(temp.root)).filter(name=>name.startsWith('connection-')),[]);
  }finally{input.destroy();output.destroy();temp.remove();}
});

async function connectedBroker(t){
  const temp=temporaryRoot('native-pending'),input=new PassThrough(),output=new PassThrough();
  const messages=[],waiters=[];
  const peer=new NativeChannel(output,input,message=>{
    messages.push(message);
    for(const waiter of [...waiters])if(waiter.match(message)){waiters.splice(waiters.indexOf(waiter),1);waiter.resolve(message);}
  },()=>{});
  const next=match=>{const found=messages.find(match);return found?Promise.resolve(found):new Promise(resolve=>waiters.push({match,resolve}));};
  const starting=startNativeBroker(temp.root,input,output);
  await peer.send(hello);const broker=await starting;
  const info=JSON.parse(await fs.readFile(broker.advertisement,'utf8'));
  const socket=net.connect(info.endpoint);let greeted;
  const greeting=new Promise(resolve=>{greeted=resolve;});
  const received=[];
  const client=new NativeChannel(socket,socket,message=>{received.push(message);if(message.epoch)greeted();},()=>{});
  const disconnected=new Promise(resolve=>socket.once('close',resolve));
  t.after(async()=>{client.close();peer.close();await broker.close();temp.remove();});
  await client.send({type:'connect',protocolMajor:1,token:info.token});await greeting;
  const owner=(await next(message=>message.type==='open')).connectionId;
  return {client,peer,next,messages,received,owner,disconnected};
}

test('broker capacity counts unanswered requests, even after every transport write completes',{timeout:5000},async t=>{
  const h=await connectedBroker(t);
  for(let id=1;id<=64;id++)await h.client.send({type:'request',id,method:'inventory'});
  await h.next(message=>message.type==='request'&&message.request.id===64);
  await h.client.send({type:'request',id:65,method:'inventory'});
  await h.disconnected;await h.next(message=>message.type==='close');
  assert.equal(h.messages.filter(message=>message.type==='request').length,64);
  assert.equal(h.messages.filter(message=>message.type==='close').length,1);
});

test('a response frees exactly one pending slot and duplicate request IDs retire the connection',{timeout:5000},async t=>{
  const h=await connectedBroker(t);
  for(let id=1;id<=64;id++)await h.client.send({type:'request',id,method:'inventory'});
  await h.next(message=>message.type==='request'&&message.request.id===64);
  await h.peer.send({connectionId:h.owner,payload:{type:'response',id:1,result:{}}});
  // The same native stream processes the response before this request is forwarded.
  await h.client.send({type:'request',id:65,method:'inventory'});
  await h.next(message=>message.type==='request'&&message.request.id===65);
  await h.client.send({type:'request',id:65,method:'inventory'});
  await h.disconnected;await h.next(message=>message.type==='close');
  assert.equal(h.messages.filter(message=>message.type==='request').length,65);
  assert.equal(h.messages.filter(message=>message.type==='close').length,1);
});
