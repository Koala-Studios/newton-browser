// Feasibility only: normal fixture-app login, opaque cloning, independent browsers.
// The fixture server validates its own synthetic cookie. Browser cookie/storage
// values and profile contents are never read, parsed or logged by the harness.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {performance} from 'node:perf_hooks';
import {openProfileStore,createNewtonIdentity,prepareOpaqueProfileSource,importOpaqueProfile,inspectNewtonIdentityLease} from '../apps/mcp-server/src/browser-runtime/profile-store.ts';
import {createProfileSourceClosureVerifier} from '../apps/mcp-server/src/browser-runtime/profile-closure.ts';
import {discoverBrowserExecutable} from '../apps/mcp-server/src/browser-runtime/browser-discovery.ts';
import {launchOwnedBrowserRuntime} from '../apps/mcp-server/src/browser-runtime/owned-browser-runtime.ts';
import {temporaryRoot,pageConnection,navigate,readBoolean} from './prototypes/support.mjs';

const owned=temporaryRoot('login');
const store=openProfileStore(path.join(owned.root,'identities'));
const family=process.env.NEWTON_BROWSER_QA_BROWSER==='edge'?'edge':'chrome';
const browser=discoverBrowserExecutable({family});
assert.ok(browser);
const runtimes=new Set();
const rows=[];
const server=http.createServer((req,res)=>{
  if(req.url==='/login') res.setHeader('Set-Cookie','fixture_session=prototype-only; Max-Age=3600; HttpOnly; SameSite=Lax; Path=/');
  if(req.url==='/local-logout') res.setHeader('Set-Cookie','fixture_session=; Max-Age=0; HttpOnly; SameSite=Lax; Path=/');
  const signedIn=req.headers.cookie?.split(';').some(v=>v.trim()==='fixture_session=prototype-only')===true;
  res.setHeader('content-type','text/html; charset=utf-8');
  res.end(`<!doctype html><title>Login source prototype</title><main>${signedIn?'Signed in':'Signed out'}</main><input aria-label="Draft"><a href="/status">Status</a>`);
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
async function launch(identity) {
  const start=performance.now();
  const runtime=await launchOwnedBrowserRuntime({executablePath:browser.path,browserFamily:family,profileStore:store,identityId:identity.id,headless:true});
  runtimes.add(runtime);
  const bootstrap=runtime.claimDriverBootstrap();
  const page=await pageConnection(bootstrap.transport,bootstrap.rootTargetId);
  return {runtime,page,startupMs:Math.round(performance.now()-start)};
}
async function stop(worker) {await worker.runtime.close();runtimes.delete(worker.runtime);}
const signedIn=page=>readBoolean(page,"document.querySelector('main').textContent==='Signed in'");
let cleanupConfirmed=false;
try {
  const seed=createNewtonIdentity(store,{browserFamily:family});
  const seedWorker=await launch(seed);
  rows.push({id:'browser',...(await seedWorker.page.transport.send('Browser.getVersion',{}))});
  await navigate(seedWorker.page,origin+'/login');
  await navigate(seedWorker.page,origin+'/status');assert.ok(await signedIn(seedWorker.page));
  const busy=await launchOwnedBrowserRuntime({executablePath:browser.path,browserFamily:family,profileStore:store,identityId:seed.id,headless:true}).then(runtime=>{runtimes.add(runtime);return false;},e=>e.identityBusy===true);
  assert.ok(busy);rows.push({id:'same_writable_identity_rejected',passed:busy});
  await stop(seedWorker);
  const familyWideVerifier=createProfileSourceClosureVerifier({browserFamily:family});
  const familyWideClosure=familyWideVerifier({userDataRoot:seed.path,profileDirectory:'Default'});
  rows.push({id:'legacy_family_wide_closure_check',accepted:familyWideClosure,requiredForNewSeedDesign:false});
  // This private fixture seed has exactly one launcher. close() above proved its
  // guardian-owned tree stopped. Bind that fact to the exact seed and its lease;
  // do not exempt arbitrary imported profiles or claim all browsers are closed.
  const verifyClosed=source=>source.userDataRoot===seed.path && source.profileDirectory==='Default'
    && !runtimes.has(seedWorker.runtime) && inspectNewtonIdentityLease(store,seed.id)==='available';
  function clone() {
    const source=prepareOpaqueProfileSource({browserFamily:family,userDataRoot:seed.path,profileDirectory:'Default',verifyClosed});
    return importOpaqueProfile(store,{source});
  }
  const start=performance.now();
  const identities=[clone(),clone()];
  rows.push({id:'opaque_clones',count:2,elapsedMs:Math.round(performance.now()-start),contentsParsed:false});
  const results=await Promise.allSettled(identities.map(launch));
  const workers=results.map(r=>{if(r.status==='rejected')throw r.reason;return r.value;});
  assert.notEqual(workers[0].runtime.receipt.pid,workers[1].runtime.receipt.pid);
  await Promise.all(workers.map(w=>navigate(w.page,origin+'/status')));
  const authenticated=await Promise.all(workers.map(w=>signedIn(w.page)));
  rows.push({id:'concurrent_workers_share_starting_login',authenticated,distinctProcesses:true,startupMs:workers.map(w=>w.startupMs)});
  assert.deepEqual(authenticated,[true,true]);
  const rejectedWithWorkers=familyWideVerifier({userDataRoot:seed.path,profileDirectory:'Default'})===false;
  assert.ok(rejectedWithWorkers);
  rows.push({id:'legacy_verifier_rejects_closed_seed_with_active_workers',passed:rejectedWithWorkers});
  await Promise.all(workers.map(async(w,i)=>{
    const {root}=await w.page.send('DOM.getDocument');
    const {nodeId}=await w.page.send('DOM.querySelector',{nodeId:root.nodeId,selector:'input'});
    await w.page.send('DOM.focus',{nodeId});
    await w.page.send('Input.insertText',{text:`worker-${i}-draft`});
    assert.ok(await readBoolean(w.page,`document.querySelector('input').value==='worker-${i}-draft'`));
  }));
  rows.push({id:'parallel_worker_input',passed:true});
  const third=await launch(clone());
  await navigate(third.page,origin+'/status');assert.ok(await signedIn(third.page));
  rows.push({id:'clone_while_other_workers_active',passed:true});await stop(third);
  await navigate(workers[0].page,origin+'/local-logout');
  await Promise.all(workers.map(w=>navigate(w.page,origin+'/status')));
  const after=await Promise.all(workers.map(w=>signedIn(w.page)));
  assert.deepEqual(after,[false,true]);rows.push({id:'local_logout_isolated',authenticated:after,passed:true});
  await Promise.all(workers.map(stop));
  const reopened=await launch(seed);
  await navigate(reopened.page,origin+'/status');assert.ok(await signedIn(reopened.page));
  rows.push({id:'source_login_unchanged',passed:true});await stop(reopened);
} catch(error) {
  rows.push({id:'failure',message:error.message});process.exitCode=1;
} finally {
  const cleanup=await Promise.allSettled([...runtimes].map(r=>r.close()));
  await new Promise(resolve=>server.close(resolve));
  if(cleanup.every(r=>r.status==='fulfilled')) {owned.remove();cleanupConfirmed=true;}
  else process.exitCode=1;
  const receipt={prototype:'login-source',browserFamily:family,passed:!process.exitCode,cleanupConfirmed,syntheticAuthenticationOnly:true,realProviderAuthenticationProven:false,rows};
  fs.writeFileSync(`test/evidence/prototype-login-source-2026-09-07-${family}.json`,JSON.stringify(receipt,null,2)+'\n');
  process.stdout.write(JSON.stringify(receipt)+'\n');
}
