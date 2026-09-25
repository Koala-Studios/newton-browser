import test from 'node:test';
import assert from 'node:assert/strict';
import { TabClaims } from '../apps/tab-adapter/src/claims.ts';
import { NativeFrames, nativeFrame } from '../apps/mcp-server/src/native-wire.ts';
import { updateAdapter } from '../apps/mcp-server/src/adapter-update.ts';
const held = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { resolve, promise }; };

test('borrowed detach does not wait behind a modal-held input acknowledgement',async()=>{
  const waiting=held();let detached=0;
  const authority=new TabClaims({attach:async()=>{},detach:async()=>{detached++;},sendCommand:()=>waiting.promise},'epoch');
  const owner=authority.bindPort();const token=await authority.claim(owner,1);
  const input=authority.command(owner,token,'Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',x:5,y:5});
  const ended=assert.rejects(input,/connection_lost/);
  await authority.release(owner,token);
  assert.equal(detached,1);
  const next=await authority.claim(authority.bindPort(),1);assert.notEqual(next.generation,token.generation);
  await ended;waiting.resolve({});
});

test('shared engine commands remain tab scoped and disconnect releases each original input route', async () => {
  const calls=[];
  const authority=new TabClaims({attach:async()=>{},detach:async()=>{},sendCommand:async(target,method,params)=>{calls.push({target,method,params});}},'epoch');
  const owner=authority.bindPort(); const token=await authority.claim(owner,1);
  authority.event(1,'Target.attachedToTarget',{sessionId:'child'});
  for(const method of ['DOM.enable','DOM.getFrameOwner','DOM.pushNodesByBackendIdsToFrontend','DOM.querySelector','Runtime.evaluate','Page.reload','Page.getNavigationHistory','Page.navigateToHistoryEntry','Page.getLayoutMetrics']) await authority.command(owner,token,method,{},'child');
  for(const method of ['Target.attachToTarget','Target.closeTarget','Browser.close']) await assert.rejects(authority.command(owner,token,method,{}),/unsupported_method/);
  await assert.rejects(authority.command(owner,token,'Runtime.evaluate',{},'foreign'),/foreign_route/);
  await authority.command(owner,token,'Input.dispatchKeyEvent',{type:'rawKeyDown',key:'Control'},'child');
  await authority.command(owner,token,'Input.dispatchMouseEvent',{type:'mousePressed',button:'left',x:20,y:30},'child');
  await authority.command(owner,token,'Input.dispatchKeyEvent',{type:'rawKeyDown',key:'Control'});
  await authority.command(owner,token,'Input.dispatchKeyEvent',{type:'keyUp',key:'Control'});
  await authority.disconnect(owner);
  assert.deepEqual(calls.slice(-2).map(call=>[call.target.sessionId,call.params.type]),[['child','mouseReleased'],['child','keyUp']]);
});

test('claims reserve before await; owner capability and epoch cannot be forged', async () => {
  const wait = held(); let inputs = 0;
  const authority = new TabClaims({ attach: () => wait.promise, detach: async () => {}, sendCommand: async () => { inputs++; } }, 'epoch');
  const a = authority.bindPort(), b = authority.bindPort(); const pending = authority.claim(a, 1);
  await assert.rejects(authority.claim(b, 1), /tab_owned/); wait.resolve(); const token = await pending;
  await assert.rejects(authority.command(b, token, 'Input.insertText', { text: 'forged' }), /stale_claim/);
  await assert.rejects(authority.command(a, { ...token, epoch: 'old' }, 'Input.insertText', {}), /stale_claim/);
  assert.equal(inputs, 0); await authority.disconnect(a); const fresh = await authority.claim(b, 1);
  assert.notEqual(fresh.generation, token.generation);
});
test('different tabs dispatch simultaneously; disconnect during attach cannot resurrect claim', async () => {
  const wait = held(); const events = [];
  const authority = new TabClaims({ attach: async () => {}, detach: async () => {}, sendCommand: async target => { events.push(target.tabId); await wait.promise; } }, 'epoch');
  const a = authority.bindPort(), b = authority.bindPort();
  const one = await authority.claim(a, 1), two = await authority.claim(b, 2);
  const calls = [authority.command(a, one, 'Input.insertText', {}), authority.command(b, two, 'Input.insertText', {})];
  assert.deepEqual(events, [1, 2]); wait.resolve(); await Promise.all(calls); await authority.quiesce();
  const attachment = held(); const late = new TabClaims({ attach: () => attachment.promise, detach: async () => {}, sendCommand: async () => {} }, 'late');
  const owner = late.bindPort(); const claim = late.claim(owner, 1); const revoke = late.disconnect(owner);
  attachment.resolve(); await assert.rejects(claim, /claim_revoked/); await revoke;
});
test('native framing handles byte splits and rejects oversized/truncated/invalid UTF8 frames', () => {
  const values = []; const parser = new NativeFrames(v => values.push(v));
  for (const byte of nativeFrame({ value: '文😀' })) parser.push(Buffer.from([byte])); parser.end();
  assert.deepEqual(values, [{ value: '文😀' }]);
  assert.throws(() => new NativeFrames(() => {}).push(Buffer.from([255,255,255,127])), /native_frame_limit/);
  const short = new NativeFrames(() => {}); short.push(Buffer.from([1])); assert.throws(() => short.end(), /native_incomplete_frame/);
  assert.throws(() => new NativeFrames(() => {}).push(Buffer.from([1,0,0,0,255])));
});
test('update requires expected code digest; restores previous build and proves its bootstrap', async () => {
  const old = 'a'.repeat(64), next = 'b'.repeat(64); let current = old; const published = [];
  const result = await updateAdapter({ validateBuild: async () => {}, currentDigest: async () => current, quiesce: async () => {},
    publish: async digest => { current = digest; published.push(digest); }, reload: async () => { throw new Error('port lost'); },
    waitBootstrap: async () => ({ digest: old, epoch: 'boot', protocolMajor: 1 }), smoke: async () => {} }, next);
  assert.deepEqual(published, [next, old]); assert.deepEqual(result, { state: 'rolled_back', digest: old });
});

test('failed update and failed rollback preserve both bootstrap causes',async()=>{
  let attempts=0;
  await assert.rejects(updateAdapter({validateBuild:async()=>{},currentDigest:async()=>'a'.repeat(64),quiesce:async()=>{},publish:async()=>{},reload:async()=>{},
    waitBootstrap:async()=>{throw new Error(++attempts===1?'new_boot_timeout':'old_boot_timeout');},smoke:async()=>{}},'b'.repeat(64)),error=>{
      assert.equal(error.message,'adapter_bootstrap_recovery_required');
      assert.deepEqual(error.cause.errors.map(cause=>cause.message),['new_boot_timeout','old_boot_timeout']);return true;
    });
});
