import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { temporaryRoot } from '../scripts/prototypes/support.mjs';
import { openProfileStore, createNewtonIdentity } from '../apps/mcp-server/src/browser-runtime/profile-store.ts';
import { recoverProfileTransaction } from '../apps/mcp-server/src/browser-runtime/profile-transaction-recovery.ts';
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
