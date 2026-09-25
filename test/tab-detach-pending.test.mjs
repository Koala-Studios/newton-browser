import test from 'node:test';
import assert from 'node:assert/strict';
import {TabClaims} from '../apps/tab-adapter/src/claims.ts';

test('human detach settles never-returning commands and releases the old ownership',async()=>{
  const authority=new TabClaims({attach:async()=>{},detach:async()=>{},sendCommand:()=>new Promise(()=>{})},'epoch');
  const owner=authority.bindPort(),old=await authority.claim(owner,1);
  const failed=assert.rejects(authority.command(owner,old,'DOM.getDocument',{}),/connection_lost/);
  authority.detached(1);await failed;
  assert.equal(authority.isClaimed(1),false);
  const fresh=await authority.claim(authority.bindPort(),1);assert.notEqual(fresh.generation,old.generation);
  await assert.rejects(authority.command(owner,old,'DOM.getDocument',{}),/stale_claim/);
});
test('late successful input response after detach cannot acknowledge the retired claim',async()=>{
  let finish;const response=new Promise(resolve=>{finish=resolve;});
  const authority=new TabClaims({attach:async()=>{},detach:async()=>{},sendCommand:()=>response},'epoch');
  const owner=authority.bindPort(),old=await authority.claim(owner,1);
  const failed=assert.rejects(authority.command(owner,old,'Input.insertText',{text:'once'}),/connection_lost/);
  authority.detached(1);
  const nextOwner=authority.bindPort(),fresh=await authority.claim(nextOwner,1);
  finish({});await failed;
  assert.equal(authority.isClaimed(1),true);
  await authority.release(nextOwner,fresh);
});
