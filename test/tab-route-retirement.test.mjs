import test from 'node:test';
import assert from 'node:assert/strict';
import {TabClaims} from '../apps/tab-adapter/src/claims.ts';

test('duplicate route at capacity preserves authority; overflow settles pending work',async()=>{
  const claims=new TabClaims({attach:async()=>{},detach:async()=>{},sendCommand:()=>new Promise(()=>{})},'epoch');
  const owner=claims.bindPort(),token=await claims.claim(owner,1);
  for(let i=0;i<128;i++)assert.ok(claims.event(1,'Target.attachedToTarget',{sessionId:`frame${i}`}));
  assert.ok(claims.event(1,'Target.attachedToTarget',{sessionId:'frame0'}));
  const pending=assert.rejects(claims.command(owner,token,'DOM.getDocument',{},'frame0'),/route_capacity/);
  assert.equal(claims.event(1,'Target.attachedToTarget',{sessionId:'overflow'}),undefined);
  await pending;
  await assert.rejects(claims.command(owner,token,'DOM.getDocument',{}),/stale_claim/);
  assert.equal(claims.isClaimed(1),true);
  await claims.disconnect(owner);
  assert.equal(claims.isClaimed(1),false);
});

test('frame detach settles only commands on that route and forgets its held inputs',async()=>{
  const sent=[];
  const claims=new TabClaims({attach:async()=>{},detach:async()=>{},sendCommand:(target,method,params)=>{
    sent.push({target,method,params});return target.sessionId==='gone'?new Promise(()=>{}):Promise.resolve({ok:true});
  }},'epoch');
  const owner=claims.bindPort(),token=await claims.claim(owner,1);
  for(const sessionId of ['gone','live'])claims.event(1,'Target.attachedToTarget',{sessionId});
  const pending=assert.rejects(claims.command(owner,token,'Input.dispatchKeyEvent',{type:'keyDown',key:'Shift'},'gone'),/route_lost/);
  claims.event(1,'Target.detachedFromTarget',{sessionId:'gone'});
  await pending;
  assert.deepEqual(await claims.command(owner,token,'DOM.getDocument',{},'live'),{ok:true});
  assert.deepEqual(await claims.command(owner,token,'DOM.getDocument',{}),{ok:true});
  await assert.rejects(claims.command(owner,token,'DOM.getDocument',{},'gone'),/foreign_route/);
  await claims.release(owner,token);
  assert.equal(sent.filter(x=>x.params.type==='keyUp').length,0);
});

test('settled acknowledgement cannot cross a detach and reattached route identity',async()=>{
  const claims=new TabClaims({attach:async()=>{},detach:async()=>{},sendCommand:async()=>({})},'epoch');
  const owner=claims.bindPort(),token=await claims.claim(owner,1);
  claims.event(1,'Target.attachedToTarget',{sessionId:'frame'});
  const pending=claims.command(owner,token,'DOM.getDocument',{},'frame');
  // Let the transport fulfill the internal promise before the command continuation.
  await Promise.resolve();
  claims.event(1,'Target.detachedFromTarget',{sessionId:'frame'});
  claims.event(1,'Target.attachedToTarget',{sessionId:'frame'});
  await assert.rejects(pending,/route_lost/);
  assert.deepEqual(await claims.command(owner,token,'DOM.getDocument',{},'frame'),{});
  await claims.release(owner,token);
});
