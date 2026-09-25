import test from 'node:test';
import assert from 'node:assert/strict';
import {TabClaims} from '../apps/tab-adapter/src/claims.ts';

test('inventory keeps a failed new tab unavailable until its removal settles',async()=>{
  const authority=new TabClaims({attach:async()=>{throw Error('attach_failed');},detach:async()=>{},sendCommand:async()=>({})},'epoch');
  let removing,finish;
  const reached=new Promise(resolve=>{removing=resolve;});
  const cleanup=new Promise(resolve=>{finish=resolve;});
  const creation=authority.createTab(authority.bindPort(),{create:async()=>({id:7}),remove:async()=>{removing();await cleanup;}});
  const failed=assert.rejects(creation,/attach_failed/);
  await reached;
  assert.equal(authority.isClaimed(7),true);
  await assert.rejects(authority.claim(authority.bindPort(),7),/tab_owned/);
  finish();await failed;assert.equal(authority.isClaimed(7),false);
});
