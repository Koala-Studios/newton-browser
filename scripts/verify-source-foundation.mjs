import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { LoginSource } from '../apps/mcp-server/src/browser-runtime/login-source.ts';
import { openProfileStore } from '../apps/mcp-server/src/browser-runtime/profile-store.ts';
import { discoverBrowserExecutable } from '../apps/mcp-server/src/browser-runtime/browser-discovery.ts';
import { launchOwnedBrowserRuntime } from '../apps/mcp-server/src/browser-runtime/owned-browser-runtime.ts';
import { temporaryRoot, pageConnection, navigate, readBoolean } from './prototypes/support.mjs';
const temp=temporaryRoot('source-foundation');
const store=openProfileStore(path.join(temp.root,'identities'));
const metadata=path.join(temp.root,'sources');await fs.mkdir(metadata);
const family=process.env.NEWTON_BROWSER_FAMILY??'chrome';const executable=discoverBrowserExecutable({family});assert.ok(executable);
const source=await LoginSource.open(store,metadata,'shared',family);
const runtimes=[];
const server=http.createServer((req,res)=>{
  if(req.url==='/login')res.setHeader('Set-Cookie','foundation_session=fixture-only; Max-Age=3600; HttpOnly; SameSite=Lax; Path=/');
  const signedIn=req.headers.cookie?.split(';').some(value=>value.trim()==='foundation_session=fixture-only')===true;
  res.setHeader('content-type','text/html');res.end(`<main>${signedIn?'Signed in':'Signed out'}</main><input aria-label="Draft">`);
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const url=`http://127.0.0.1:${server.address().port}`;
const evidence={date:new Date().toISOString(),family,checks:[]};
async function page(runtime){const boot=runtime.claimDriverBootstrap();return pageConnection(boot.transport,boot.rootTargetId);}
async function worker(){const clone=await source.clone();const runtime=await launchOwnedBrowserRuntime({executablePath:executable.path,browserFamily:family,profileStore:store,identityId:clone.identity.id,headless:true});runtimes.push(runtime);return {runtime,page:await page(runtime),generation:clone.generation};}
try{
  const maintenance=await source.beginMaintenance(executable.path);runtimes.push(maintenance);
  await assert.rejects(source.beginMaintenance(executable.path),/EEXIST/);
  const login=await page(maintenance);await navigate(login,url+'/login');await navigate(login,url+'/status');
  assert.ok(await readBoolean(login,"document.querySelector('main').textContent==='Signed in'"));
  const first=await source.publish(maintenance);
  const workers=await Promise.all([worker(),worker()]);assert.notEqual(workers[0].runtime.receipt.pid,workers[1].runtime.receipt.pid);
  for(const w of workers){await navigate(w.page,url+'/status');assert.ok(await readBoolean(w.page,"document.querySelector('main').textContent==='Signed in'"));assert.equal(w.generation,first.generation);}
  evidence.checks.push('guardian-closed maintenance -> opaque immutable source -> two live separate authenticated processes');
  for(const cutpoint of ['before_copy','generation_complete','before_pointer','after_pointer']){
    const next=await source.beginMaintenance(executable.path);runtimes.push(next);
    const p=await page(next);await navigate(p,url+'/status');
    const before=(await source.clone()).generation;
    await assert.rejects(source.publish(next,async stage=>{if(stage===cutpoint)throw new Error('simulated_crash');}),/simulated_crash/);
    const recovered=await LoginSource.open(store,metadata,'shared',family);
    const clone=await recovered.clone();
    if(cutpoint!=='after_pointer')assert.equal(clone.generation,before);else assert.notEqual(clone.generation,before);
    assert.equal(await recovered.recoverPublication(),'available');
  }
  evidence.checks.push('all publication boundaries leave a complete current generation; actual Windows replacement of existing pointer');
  const again=await worker();await navigate(again.page,url+'/status');assert.ok(await readBoolean(again.page,"document.querySelector('main').textContent==='Signed in'"));
  evidence.checks.push('clone and publish while previous workers remain live; no family-wide shutdown');
  for(const cutpoint of ['before_copy','generation_complete','before_pointer','after_pointer']){
    const before=(await source.clone()).generation;
    const child=spawn(process.execPath,[fileURLToPath(new URL('./source-publication-crash.mjs',import.meta.url)),store.root,metadata,executable.path,family,cutpoint],{stdio:'ignore',windowsHide:true});
    const code=await new Promise(resolve=>child.on('exit',resolve));assert.equal(code,77);
    assert.equal(await source.recoverPublication(),'recovered');
    const after=(await source.clone()).generation;
    if(cutpoint==='after_pointer')assert.notEqual(after,before);else assert.equal(after,before);
  }
  assert.ok(await source.collectRetired());
  evidence.checks.push('actual publisher-process exit at all four boundaries / dead publisher lock recovery / retired generation collection');
  evidence.pass=true;
}finally{await Promise.all(runtimes.map(runtime=>runtime.close()));await new Promise(resolve=>server.close(resolve));temp.remove();await fs.writeFile(new URL(`../test/evidence/foundation-source-${family}.json`,import.meta.url),JSON.stringify(evidence,null,2)+'\n');}
console.log(JSON.stringify(evidence));
