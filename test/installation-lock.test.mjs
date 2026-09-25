import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {temporaryRoot} from '../scripts/prototypes/support.mjs';
import {acquireInstallationLock} from '../apps/mcp-server/src/installation-lock.ts';

test('installation ownership is exclusive and immediately reusable after release',async()=>{
  const temp=temporaryRoot('installation-lock');let first,second;
  try{
    first=await acquireInstallationLock(temp.root);
    await assert.rejects(acquireInstallationLock(temp.root),/installation_busy/);
    assert.equal(first.signal.aborted,false);await first.release();await first.release();
    second=await acquireInstallationLock(temp.root);assert.equal(second.signal.aborted,false);
  }finally{await first?.release();await second?.release();temp.remove();}
});
test('a crashed lock owner leaves no stale ownership to repair',{timeout:10000},async()=>{
  const temp=temporaryRoot('installation-lock-crash');let child,lock;
  try{
    child=fork(fileURLToPath(new URL('./fixtures/installation-lock-owner.mjs',import.meta.url)),[temp.root],{stdio:['ignore','ignore','pipe','ipc'],windowsHide:true});
    const [message]=await once(child,'message');assert.equal(message,'locked');
    await assert.rejects(acquireInstallationLock(temp.root),/installation_busy/);
    const exited=once(child,'exit');child.kill('SIGKILL');await exited;
    lock=await acquireInstallationLock(temp.root);assert.equal(lock.signal.aborted,false);
  }finally{if(child?.exitCode===null&&child?.signalCode===null)child.kill('SIGKILL');await lock?.release();temp.remove();}
});
