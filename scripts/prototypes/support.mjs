import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function temporaryRoot(label) {
  const parent = fs.realpathSync.native(os.tmpdir());
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(parent, `newton-prototype-${label}-`)));
  const stat = fs.lstatSync(root);
  const nonce = randomUUID();
  fs.writeFileSync(path.join(root, '.prototype-owner'), nonce, {flag:'wx'});
  return {root, remove() {
    assert.equal(fs.realpathSync.native(root), root);
    assert.equal(path.dirname(root), parent);
    const now = fs.lstatSync(root);
    assert.ok(now.isDirectory() && !now.isSymbolicLink() && now.ino===stat.ino && now.dev===stat.dev);
    assert.equal(fs.readFileSync(path.join(root,'.prototype-owner'),'utf8'),nonce);
    fs.rmSync(root,{recursive:true});
  }};
}

export async function deadline(promise, label, ms=20000) {
  let timer;
  try { return await Promise.race([promise,new Promise((_,reject)=>{
    timer=setTimeout(()=>reject(new Error(`${label}_deadline`)),ms);
  })]); } finally { clearTimeout(timer); }
}

export async function pageConnection(transport,targetId) {
  const {sessionId}=await transport.send('Target.attachToTarget',{targetId,flatten:true});
  const send=(method,params={})=>transport.send(method,params,sessionId);
  await send('Page.enable');
  await send('Page.setLifecycleEventsEnabled',{enabled:true});
  return {transport,sessionId,send};
}

export async function navigate(page,url) {
  const events=[];
  let expected, resolve;
  const loaded=new Promise(r=>{resolve=r;});
  const check=()=>{if(expected && events.some(e=>e.name==='load' && e.loaderId===expected))resolve();};
  const off=page.transport.onEvent(event=>{
    if(event.sessionId===page.sessionId && event.method==='Page.lifecycleEvent') {events.push(event.params);check();}
  });
  try {
    const result=await page.send('Page.navigate',{url});
    assert.ok(!result.errorText, result.errorText);
    expected=result.loaderId; assert.ok(expected,'navigation loader missing');check();
    await deadline(loaded,'navigation');
  } finally {off();}
}

export async function readBoolean(page,expression) {
  const result=await page.send('Runtime.evaluate',{expression,returnByValue:true,throwOnSideEffect:true});
  assert.ok(!result.exceptionDetails,'read failed');
  assert.equal(typeof result.result?.value,'boolean');
  return result.result.value;
}
