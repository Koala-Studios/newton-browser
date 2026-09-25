import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { temporaryRoot } from '../scripts/prototypes/support.mjs';
import { openProfileStore, createNewtonIdentity, recoverStaleNewtonIdentityLease } from '../apps/mcp-server/src/browser-runtime/profile-store.ts';
import { recoverProfileTransaction, STORE_TRANSACTION_STALE_MS } from '../apps/mcp-server/src/browser-runtime/profile-transaction-recovery.ts';
import { withAvailableStore } from '../apps/mcp-server/src/browser-runtime/profile-copy-worker.ts';

test('copy helper retains its operation across store contention and resumes on lock removal', async () => {
  const temp=temporaryRoot('copy-contention');
  try {
    const lock=path.join(temp.root,'.newton-browser-profile-store.lock');fs.writeFileSync(lock,'fixture lock');
    let calls=0;
    const pending=withAvailableStore(temp.root,()=>{calls++;if(fs.existsSync(lock))throw new Error('profile_store_busy');return 'released';});
    assert.equal(calls,1);
    fs.unlinkSync(lock);
    assert.equal(await pending,'released');assert.equal(calls,2);
  } finally {temp.remove();}
});

test('copy helper never retries an operation with an uncertain result', async () => {
  let calls=0;
  await assert.rejects(withAvailableStore('.',()=>{calls++;throw new Error('profile_store_lock_changed');}),/profile_store_lock_changed/);
  assert.equal(calls,1);
});

test('actual copy-process crash recovers only its marked stage and exact store lock', async () => {
  const temp=temporaryRoot('copy-crash');
  try {
    const store=openProfileStore(path.join(temp.root,'store'));
    const source=path.join(temp.root,'synthetic');fs.mkdirSync(path.join(source,'Default'),{recursive:true});fs.writeFileSync(path.join(source,'Local State'),'{}');
    const child=spawn(process.execPath,[fileURLToPath(new URL('./fixtures/copy-crash.mjs',import.meta.url)),store.root,source],{stdio:'ignore',windowsHide:true});
    const code=await new Promise(resolve=>child.on('exit',resolve));assert.equal(code,77);
    assert.ok(fs.readdirSync(store.root).some(name=>name.startsWith('.staging-')));
    assert.equal(recoverProfileTransaction(store),'recovered');
    assert.ok(!fs.readdirSync(store.root).some(name=>name.startsWith('.staging-')));
    assert.ok(createNewtonIdentity(store,{browserFamily:'chrome'}));
    assert.equal(recoverProfileTransaction(store),'available');
  } finally {temp.remove();}
});

// Work runs each browser host in its own PID namespace: a PID recorded there means nothing here.
test('a store lock from another PID namespace is busy until its bounded transaction must have ended', () => {
  const temp=temporaryRoot('foreign-lock');
  try {
    const store=openProfileStore(path.join(temp.root,'store'));
    const owner=JSON.parse(fs.readFileSync(path.join(store.root,'.newton-browser-profile-store'),'utf8'));
    const lock=path.join(store.root,'.newton-browser-profile-store.lock');
    const write=createdAt=>fs.writeFileSync(lock,JSON.stringify({version:1,nonce:'a'.repeat(64),pid:process.pid+100000,storeNonce:owner.nonce,createdAt,pidNamespace:'pid:[0]'}));
    write(new Date().toISOString());
    assert.equal(recoverProfileTransaction(store),'busy','a fresh foreign lock is never probed by PID');
    write(new Date(Date.now()-STORE_TRANSACTION_STALE_MS-1000).toISOString());
    assert.equal(recoverProfileTransaction(store),'recovered');
    assert.equal(fs.existsSync(lock),false);
  } finally {temp.remove();}
});

test('a copy lease from another PID namespace is released only by a bounded caller after its bound', () => {
  const temp=temporaryRoot('foreign-lease');
  try {
    const store=openProfileStore(path.join(temp.root,'store'));
    const identity=createNewtonIdentity(store,{browserFamily:'chrome'});
    const lease=path.join(identity.path,'.newton-browser-profile-lease');
    const write=createdAt=>fs.writeFileSync(lease,JSON.stringify({version:1,type:'identity_lease',id:identity.id,browserFamily:'chrome',nonce:'b'.repeat(64),pid:1,createdAt,pidNamespace:'pid:[0]'}),{mode:0o600});
    const neverClosed=()=>false;
    write(new Date(Date.now()-STORE_TRANSACTION_STALE_MS-1000).toISOString());
    assert.throws(()=>recoverStaleNewtonIdentityLease(store,identity.id,neverClosed),/profile_identity_lease_active/,'unbounded callers never guess');
    fs.unlinkSync(lease);write(new Date().toISOString());
    assert.throws(()=>recoverStaleNewtonIdentityLease(store,identity.id,neverClosed,{foreignOwnerStaleAfterMs:STORE_TRANSACTION_STALE_MS}),/profile_identity_lease_active/);
    fs.unlinkSync(lease);write(new Date(Date.now()-STORE_TRANSACTION_STALE_MS-1000).toISOString());
    assert.equal(recoverStaleNewtonIdentityLease(store,identity.id,neverClosed,{foreignOwnerStaleAfterMs:STORE_TRANSACTION_STALE_MS}),'recovered');
    assert.equal(fs.existsSync(lease),false);
  } finally {temp.remove();}
});
