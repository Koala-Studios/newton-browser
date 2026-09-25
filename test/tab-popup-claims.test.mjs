import test from 'node:test';
import assert from 'node:assert/strict';
import {TabClaims} from '../apps/tab-adapter/src/claims.ts';

function fixture(){
  const detached=[];let attach=async()=>{};
  const authority=new TabClaims({attach:target=>attach(target),detach:async target=>{detached.push(target.tabId);},sendCommand:async()=>({})},'epoch');
  return {authority,detached,setAttach:value=>{attach=value;}};
}
test('browser-attributed popup inherits only its attached opener owner',async()=>{
  const {authority}=fixture(),owner=authority.bindPort(),other=authority.bindPort();
  const root=await authority.claim(owner,1);
  assert.equal(await authority.claimPopup(3,99),undefined);
  const child=await authority.claimPopup(2,1);
  assert.equal(child.owner,owner);assert.deepEqual(child.opener,root);
  await assert.rejects(authority.command(other,child.token,'DOM.getDocument',{}),/stale_claim/);
  assert.deepEqual(await authority.command(owner,child.token,'DOM.getDocument',{}),{});
  const grandchild=await authority.claimPopup(3,2);assert.equal(grandchild.owner,owner);
  await authority.disconnect(owner);assert.equal(authority.isClaimed(2),false);assert.equal(authority.isClaimed(3),false);
});
test('popup reservation excludes another worker before debugger attach settles',async()=>{
  const {authority,setAttach}=fixture(),owner=authority.bindPort(),other=authority.bindPort();
  await authority.claim(owner,1);
  let finish;setAttach(()=>new Promise(resolve=>{finish=resolve;}));
  const child=authority.claimPopup(2,1);
  await assert.rejects(authority.claim(other,2),/tab_owned/);
  finish();await child;await authority.disconnect(owner);
});
test('late popup attachment after opener release is revoked instead of adopted',async()=>{
  const {authority,setAttach,detached}=fixture(),owner=authority.bindPort();
  const root=await authority.claim(owner,1);
  let finish;setAttach(()=>new Promise(resolve=>{finish=resolve;}));
  const child=authority.claimPopup(2,1);
  await authority.release(owner,root);finish();
  await assert.rejects(child,/claim_revoked/);
  assert.equal(authority.isClaimed(2),false);assert.deepEqual(detached,[1,2]);
});
