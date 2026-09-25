import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {publishNativeJson} from '../apps/mcp-server/src/native-install.ts';
import {temporaryRoot} from '../scripts/prototypes/support.mjs';

test('publication accepts a concurrent identical effect after Windows rename collision',async t=>{
  const temp=temporaryRoot('native-publication'),destination=path.join(temp.root,'launcher.json');
  const text=JSON.stringify({digest:'a'.repeat(64)})+'\n';
  t.mock.method(fs,'rename',async(_source,target)=>{assert.equal(target,destination);await fs.writeFile(destination,text);throw Object.assign(Error('sharing violation'),{code:'EPERM'});});
  try{
    await publishNativeJson(temp.root,'launcher.json',{digest:'a'.repeat(64)});
    assert.equal(await fs.readFile(destination,'utf8'),text);
    assert.deepEqual((await fs.readdir(temp.root)).filter(name=>name.endsWith('.stage')),[]);
  }finally{t.mock.restoreAll();temp.remove();}
});

test('publication refuses a different concurrent effect and never deletes its destination',async t=>{
  const temp=temporaryRoot('native-publication-other'),destination=path.join(temp.root,'launcher.json');
  t.mock.method(fs,'rename',async()=>{await fs.writeFile(destination,'{"digest":"other"}\n');throw Object.assign(Error('sharing violation'),{code:'EPERM'});});
  try{
    await assert.rejects(publishNativeJson(temp.root,'launcher.json',{digest:'wanted'}),error=>error.code==='EPERM');
    assert.equal(await fs.readFile(destination,'utf8'),'{"digest":"other"}\n');
    assert.deepEqual((await fs.readdir(temp.root)).filter(name=>name.endsWith('.stage')),[]);
  }finally{t.mock.restoreAll();temp.remove();}
});

test('already matching native metadata is not rewritten',async()=>{
  const temp=temporaryRoot('native-publication-repeat'),destination=path.join(temp.root,'manifest.json');
  try{
    await publishNativeJson(temp.root,'manifest.json',{name:'fixture'});const before=await fs.stat(destination);
    await publishNativeJson(temp.root,'manifest.json',{name:'fixture'});const after=await fs.stat(destination);
    assert.equal(after.ino,before.ino);assert.equal(after.mtimeMs,before.mtimeMs);
  }finally{temp.remove();}
});
