import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { spawn, fork, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {once} from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launchChromium } from '../apps/mcp-server/src/browser-runtime/chromium-process.ts';
import { connectExistingTab,existingConnectionId,nativeAdvertisements,discoverExistingDirectory } from '../apps/mcp-server/src/existing-connection.ts';
import { temporaryRoot, pageConnection, navigate, deadline, readBoolean } from './prototypes/support.mjs';
const temp = temporaryRoot('tab-foundation');
const packed=path.join(temp.root,'packed');await fs.mkdir(packed);
await promisify(execFile)('tar',['-xf',path.resolve('artifacts/newton-browser-0.6.4.tgz'),'-C',packed],{windowsHide:true});
const {unregisterNativeLocal}=await import(pathToFileURL(path.join(packed,'package/dist/native-install.js')).href);
const candidate=pathToFileURL(path.join(packed,'package/dist/embedding.js')).href;
const {connectNative,developmentUpdateControl,updateInstalledAdapter}=await import(candidate);
const cli=path.join(packed,'package/dist/index.js');
const cliCall=async(operation,...args)=>JSON.parse((await promisify(execFile)(process.execPath,[cli,'adapter',operation,...args],{windowsHide:true,env:{...process.env,NEWTON_BROWSER_CONFIG_DIR:temp.root}})).stdout);
const prepared=await cliCall('prepare'),extensionId=prepared.extensionId,adapter=prepared.directory;
const built={digest:createHash('sha256').update(await fs.readFile(path.join(adapter,'worker.js'))).digest('hex')};
let installation, browser,otherBrowser,otherClient; const clients = [];const oracles=new Map();const updateControls=[];
const server = http.createServer((req,res) => { res.setHeader('content-type','text/html');
if(req.url==='/frame'){res.end(`<title>Cross-site frame</title><p>Included frame prose</p><label>Frame draft<input id="frame-draft"></label><input type=password>`);return;}
if(req.url==='/outside-frame'){res.end('<p>Outside sibling prose</p><label>Outside scoped control<input></label>');return;}
if(req.url==='/hidden-frame'){res.end('<p>Hidden frame prose must stay excluded</p>');return;}
if(req.url==='/excluded-frame'){res.end('<p>Excluded frame prose must stay excluded</p>');return;}
res.end(`<title>Tab foundation</title><label>Draft<input id="draft"></label>
<input id="mask-probe" type=password style="position:absolute;left:560px;top:100px;width:100px"><div id="closed-mask-host"></div>
<script>document.querySelector('#closed-mask-host').attachShadow({mode:'closed'}).innerHTML='<input autocomplete="one-time-code" style="position:absolute;left:560px;top:150px;width:100px">';</script>
<button id="hover" onpointerenter="document.querySelector('#hover-state').textContent='hovered'">Hover</button><p id="hover-state"></p>
<label>Toggle<input type="checkbox" id="toggle"></label><button id="prompt" onclick="document.querySelector('#answer').textContent=prompt('Adapter prompt')||'dismissed'">Prompt</button><p id="answer"></p>
<button id="popup" onclick="window.open(location.pathname+'?popup','_blank')">Open child tab</button>
<label>Media<input type="file" id="media"></label>
<section id="frame-scope"><p>Scoped parent prose</p><iframe id="child-frame" title="Cross-site draft" src="http://localhost:${server.address().port}/frame"></iframe>
<div hidden><iframe src="http://localhost:${server.address().port}/hidden-frame"></iframe></div>
<div autocomplete="one-time-code"><iframe src="http://localhost:${server.address().port}/excluded-frame"></iframe></div></section>
<iframe title="Outside scope" src="http://localhost:${server.address().port}/outside-frame"></iframe>
<button id="remove-frame" onclick="document.querySelector('#child-frame').remove();this.textContent='Frame removed'">Remove frame</button>
<div id="scrollbox" style="height:60px;overflow:auto"><p style="height:400px">Scrollable adapter content</p></div>
<div style="height:1000px"></div><button id="far" onclick="this.textContent='Far clicked trusted='+event.isTrusted">Far button</button>
<script>window.fixtureVisibility=[];window.fixtureWheel=[];window.fixturePointer=[];for(const type of ['pointerdown','pointerup','click'])document.addEventListener(type,e=>fixturePointer.push({type,id:e.target.id,x:e.clientX,y:e.clientY,trusted:e.isTrusted}));document.addEventListener('visibilitychange',()=>fixtureVisibility.push(document.visibilityState));document.querySelector('#scrollbox').addEventListener('wheel',e=>fixtureWheel.push({trusted:e.isTrusted,y:e.deltaY}));</script>`); });
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
const evidence = { date: new Date().toISOString(), checks: [] };
evidence.pass=false;
evidence.headless=process.env.NEWTON_TAB_QA_HEADED!=='1';
let pendingFrameId;
function message(client, type) {
  return deadline(new Promise((resolve,reject) => {
    const receive = value => { if (value.type === type || value.type === 'error') { client.off('message',receive); value.type === 'error' ? reject(new Error(JSON.stringify({failure:value.message,nativeTrace:value.nativeTrace}))) : resolve(value); } };
    client.on('message', receive);
  }), type);
}
try {
  console.error('native foundation: install');
  const setups=await Promise.allSettled([cliCall('setup'),cliCall('setup')]);
  if(setups.some(result=>result.status==='fulfilled'))installation={root:path.join(temp.root,'tab-adapter-native'),unregister:()=>unregisterNativeLocal(path.join(temp.root,'tab-adapter-native'),extensionId)};
  for(const result of setups){if(result.status==='rejected')throw result.reason;assert.equal(result.value.state,'browser_install_required');assert.equal(result.value.extensionId,extensionId);}
  const profile = path.join(temp.root,'profile'); await fs.mkdir(profile);
  const executablePath = process.env.NEWTON_BROWSER_PROTOTYPE_EXECUTABLE ?? path.join(process.env.LOCALAPPDATA, 'ms-playwright/chromium-1234/chrome-win64/chrome.exe');
  browser = await launchChromium({ executablePath, userDataDir: profile, browserFamily: 'chrome', headless: evidence.headless,
    spawn: (exe,args,options) => spawn(exe,[...args,'--enable-unsafe-extension-debugging',`--load-extension=${adapter}`],options) });
  console.error('native foundation: browser ready');
  const transport = browser.transport;
  const devTarget = await transport.send('Target.createTarget',{url:'about:blank'});
  const devPage = await pageConnection(transport,devTarget.targetId); await navigate(devPage,'chrome://extensions/');
  const ax = await devPage.send('Accessibility.getFullAXTree');
  const toggle = ax.nodes.find(node => node.name?.value === 'Developer mode' && node.backendDOMNodeId && ['switch','button','checkbox'].includes(node.role?.value)); assert.ok(toggle);
  if (!toggle.properties?.some(p => ['checked','pressed'].includes(p.name) && p.value?.value === 'true')) {
    const { model } = await devPage.send('DOM.getBoxModel',{backendNodeId:toggle.backendDOMNodeId});
    const x=(model.border[0]+model.border[4])/2,y=(model.border[1]+model.border[5])/2;
    await devPage.send('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',clickCount:1});
    await devPage.send('Input.dispatchMouseEvent',{type:'mouseReleased',x,y,button:'left',clickCount:1});
  }
  const controlTarget = await transport.send('Target.createTarget',{url:'about:blank'});
  let control = await pageConnection(transport,controlTarget.targetId);
  await navigate(control,`chrome-extension://${extensionId}/setup.html`);
  const helloReply = await deadline(control.send('Runtime.evaluate',{expression:"chrome.runtime.sendMessage({type:'status'})",awaitPromise:true,returnByValue:true}), 'bootstrap_status');
  const hello = helloReply.result?.value; assert.equal(hello?.digest,built.digest,JSON.stringify(helloReply));
  console.error('native foundation: bootstrap ready');
  const runtimeBefore=await fs.stat(path.join(installation.root,'builds',(JSON.parse(await fs.readFile(path.join(installation.root,'launcher.json'),'utf8'))).digest,'node.exe'));
  const repeatedSetups=await Promise.all([cliCall('setup'),cliCall('setup')]);for(const repeatedSetup of repeatedSetups)assert.equal(repeatedSetup.extensionId,extensionId);
  const runtimeAfter=await fs.stat(path.join(installation.root,'builds',(JSON.parse(await fs.readFile(path.join(installation.root,'launcher.json'),'utf8'))).digest,'node.exe'));
  assert.equal(runtimeAfter.ino,runtimeBefore.ino);assert.equal(runtimeAfter.mtimeMs,runtimeBefore.mtimeMs);assert.equal(runtimeAfter.ctimeMs,runtimeBefore.ctimeMs);
  evidence.checks.push('public setup repeated while native host is running preserves the immutable runtime');
  const connectionDir = path.join(installation.root,'connections');
  const files = await fs.readdir(connectionDir); assert.equal(files.length,1,JSON.stringify(files));
  const advertisement = path.join(connectionDir,files[0]);
  const url = `http://127.0.0.1:${server.address().port}/`;
  const tabReply = await control.send('Runtime.evaluate',{expression:`Promise.all([chrome.tabs.create({url:${JSON.stringify(url)},active:false}),chrome.tabs.create({url:${JSON.stringify(url)},active:false})])`,awaitPromise:true,returnByValue:true});
  const tabs = tabReply.result.value.map(tab => tab.id); assert.equal(tabs.length,2);
  // Observe before any prompt opens. Chromium stores a pending dialog callback
  // in each already-enabled Page handler; a new post-dialog attachment cannot
  // recover that callback even though the native browser dialog still exists.
  const oracleTargets=(await transport.send('Target.getTargets')).targetInfos.filter(target=>target.url===url);
  assert.equal(oracleTargets.length,2);
  for(const target of oracleTargets)oracles.set(target.targetId,await pageConnection(transport,target.targetId));
  for (const tab of tabs) {
    const client = fork(fileURLToPath(new URL('./foundation-tab-client.mjs',import.meta.url)),[advertisement,String(tab),hello.epoch],{stdio:['ignore','pipe','pipe','ipc'],windowsHide:true,env:{...process.env,NEWTON_ENGINE_CANDIDATE_ENTRY:candidate,NEWTON_TAB_QA_CONFIG_ROOT:temp.root}});
    clients.push(client);
    const ready = await message(client,'ready'); assert.equal(ready.initial.mode,'existing'); assert.ok(ready.initial.observation.nodes.length);
  }
  await assert.rejects(connectExistingTab(advertisement,tabs[0],hello.epoch), /tab_owned/);
  await assert.rejects(connectExistingTab(advertisement,tabs[0],'stale-instance'), /browser_instance_changed/);
  const fills = clients.map((client,index) => { const result = message(client,'filled'); client.send({type:'fill',value:`native-worker-${index}`}); return result; });
  for (const {receipt} of await Promise.all(fills)) { assert.equal(receipt.dispatch,'acknowledged',JSON.stringify(receipt)); assert.equal(receipt.postcondition.state,'met',JSON.stringify(receipt)); }
  evidence.checks.push('two independent MCP processes / two owned tabs / same-tab conflict / concurrent shared-engine native input');
  const createdSessions=await Promise.all(clients.map(client=>{const result=message(client,'created-tab');client.send({type:'create-tab',url:url+'?created'});return result;}));
  for(const created of createdSessions){
    assert.equal(created.typed.observation.scope,'target');
    assert.equal(created.typed.observation.nodes.length,1);
    assert.match(created.typed.observation.nodes[0].value,/^created-by-\d+-typed$/);
    assert.equal(created.created.mode,'existing');assert.equal(created.receipt.postcondition.state,'met');
    await assert.rejects(connectExistingTab(advertisement,Number(created.created.page.pageId.slice(4)),hello.epoch),/tab_owned/);
  }
  evidence.checks.push('public MCP new_tab starts in the selected browser, navigates after ownership and supports independent worker input');
  const uploadFile=path.join(temp.root,'adapter-media.png');await fs.writeFile(uploadFile,Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]));
  for(let index=0;index<clients.length;index++) {
    // A native modal can suspend screenshot capture in sibling tabs. Open the
    // retained prompt only after both workers have completed their capture QA.
    const result=message(clients[index],'probed');clients[index].send({type:'probe',leaveModal:index===clients.length-1,uploadFile});
    const probe=await result;
    assert.equal(probe.screenshot.observation.state,'available',JSON.stringify(probe.screenshot));
    assert.equal(probe.screenshot.observation.provenance.maskDisposition,'mask_applied');
    assert.ok(probe.screenshot.imageBytes>0);
    assert.equal(probe.fullPageScreenshot.observation.state,'available',JSON.stringify(probe.fullPageScreenshot));
    const fullProvenance=probe.fullPageScreenshot.observation.provenance;
    assert.equal(fullProvenance.maskDisposition,'mask_applied');
    assert.ok(fullProvenance.clip.height>fullProvenance.viewport.height);
    assert.ok(probe.fullPageScreenshot.imageHeight>fullProvenance.viewport.height);
    assert.equal(probe.scopedControls.observation.scope,'target');
    assert.ok(probe.scopedControls.observation.nodes.some(node=>node.name==='Frame draft'));
    assert.ok(!probe.scopedControls.observation.nodes.some(node=>node.name==='Outside scoped control'));
    assert.match(probe.scopedDocument.observation.text,/Scoped parent prose/);
    assert.match(probe.scopedDocument.observation.text,/Included frame prose/);
    assert.doesNotMatch(probe.scopedDocument.observation.text,/Outside sibling prose/);
    assert.doesNotMatch(probe.scopedDocument.observation.text,/Hidden frame prose|Excluded frame prose/);
    for(const name of ['hover','checkbox','accepted','scrolled','offscreen','files','childFill','frameFill','frameRemoved'])assert.equal(probe[name].postcondition.state,'met',JSON.stringify({name,receipt:probe[name]}));
    assert.equal(probe.pages.pages.length,2);assert.equal(probe.child.openerPageId,probe.popup.page.pageId);
    assert.equal(probe.child.selected,false);assert.equal(probe.pages.pages.find(page=>page.selected).pageId,probe.popup.page.pageId);
    await assert.rejects(connectExistingTab(advertisement,Number(probe.child.pageId.slice(4)),hello.epoch),/tab_owned/);
    assert.deepEqual(probe.files.observation.nodes[0].fileNames,['adapter-media.png']);
    assert.equal(probe.opened.observation.scope,'dialog');
    assert.match(probe.document.observation.text,/adapter-answer/);
    assert.match(probe.document.observation.text,/Included frame prose/);
    assert.match(probe.document.observation.text,/Outside sibling prose/);
    assert.doesNotMatch(probe.document.observation.text,/Hidden frame prose|Excluded frame prose/);
    assert.ok(probe.records.observation.records.length>0);
    if(index===clients.length-1){assert.equal(probe.pending.observation.scope,'dialog');pendingFrameId=probe.pending.page.frameId;}
  }
  evidence.checks.push('packed borrowed hover / checkbox / prompt accept / document / records / container scroll / offscreen trusted click / stop with open prompt');
  evidence.checks.push('both borrowed workers return masked PNG blocks using native sensitive search across closed shadow roots and cross-site frames');
  evidence.checks.push('each borrowed worker lists and edits its own opener-attributed popup; selected parent remains unchanged; another connection cannot claim the popup');
  evidence.checks.push('popup edit uses newPages from the preceding action receipt before any pages.list call');
  evidence.checks.push('scoped document includes cross-site frame prose and excludes unrelated sibling iframe prose');
  evidence.checks.push('scoped document excludes iframe text under hidden and autocomplete-excluded ancestors');
  evidence.checks.push('ordinary document reading includes both visible frames while preserving ancestor exclusions');
  evidence.checks.push('scoped controls include an actionable cross-site frame ref; filling that ref succeeds without exposing the outside sibling control');
  await Promise.all(clients.map(async client => { const stopped=message(client,'stopped');client.send({type:'stop'});await stopped; }));
  evidence.checks.push('extracted packed installer, native helper, launcher and engine / private IPC / real Chrome Native Messaging / expected code digest');
  // Independent browser-side oracle after releasing debugger ownership.
  const inventory=await transport.send('Target.getTargets');
  const childTargets=inventory.targetInfos.filter(target=>target.url===url+'?popup');assert.equal(childTargets.length,2);
  const pages=inventory.targetInfos.filter(target=>target.url===url);assert.equal(pages.length,2);
  assert.ok(pages.some(target=>target.targetId===pendingFrameId),'the retained prompt page remains present');
  const values=await Promise.all(pages.map(async target=>{
    const page=oracles.get(target.targetId);assert.ok(page);
    if(target.targetId===pendingFrameId) {
      await deadline(page.send('Page.handleJavaScriptDialog',{accept:false}),'close_preserved_prompt'); evidence.promptAfterDetach='still_open';
    }
    const effect=await deadline(readBoolean(page,"/^native-worker-[01]$/.test(document.querySelector('#draft').value)"),'oracle_read');
    assert.equal(await deadline(readBoolean(page,"document.querySelector('#media').files.length===1&&document.querySelector('#media').files[0].name==='adapter-media.png'"),'oracle_upload'),true);
    const state=await deadline(page.send('Runtime.evaluate',{expression:'({visibility:document.visibilityState,changes:fixtureVisibility,wheel:fixtureWheel,scroll:document.querySelector("#scrollbox").scrollTop})',returnByValue:true,throwOnSideEffect:true}),'oracle_visibility');
    assert.ok(!state.exceptionDetails,JSON.stringify(state));
    assert.equal(state.result.value.visibility,'hidden');assert.deepEqual(state.result.value.changes,[]);
    assert.ok(state.result.value.scroll>0);assert.deepEqual(state.result.value.wheel,[{trusted:true,y:100}]);
    (evidence.tabEffects??=[]).push(state.result.value);
    return effect;
  }));
  assert.deepEqual(values,[true,true]); evidence.checks.push('independent DOM effect oracle; stopping workers preserves browser and tabs');
  // The retained parent modal must be dismissed by the existing oracle above
  // before reading sibling/child tabs in the same browser window.
  evidence.popupEffects=await Promise.all(childTargets.map(async target=>{
    const page=await deadline(pageConnection(transport,target.targetId),'popup_oracle_attach');
    return (await deadline(page.send('Runtime.evaluate',{expression:'document.querySelector("#draft").value',returnByValue:true,throwOnSideEffect:true}),'popup_value_oracle')).result.value;
  }));
  assert.deepEqual([...evidence.popupEffects].sort(),tabs.map(tab=>`child-of-${tab}`).sort());
  const createdTargets=inventory.targetInfos.filter(target=>target.url===url+'?created');assert.equal(createdTargets.length,2);
  evidence.createdTabEffects=await Promise.all(createdTargets.map(async target=>{
    const page=await deadline(pageConnection(transport,target.targetId),'created_oracle_attach');
    return (await deadline(page.send('Runtime.evaluate',{expression:'document.querySelector("#draft").value',returnByValue:true,throwOnSideEffect:true}),'created_value_oracle')).result.value;
  }));
  assert.deepEqual([...evidence.createdTabEffects].sort(),tabs.map(tab=>`created-by-${tab}-typed`).sort());
  evidence.checks.push('text-only global press returns one field with updated value; independent post-release DOM oracle confirms insertion');
  // Same extension ID and native installation, independent Chromium profile.
  // A valid new hello/digest from this browser must never satisfy the first update.
  const otherProfile=path.join(temp.root,'other-profile');await fs.mkdir(otherProfile);
  otherBrowser=await launchChromium({executablePath,userDataDir:otherProfile,browserFamily:'chrome',headless:evidence.headless,
    spawn:(exe,args,options)=>spawn(exe,[...args,'--enable-unsafe-extension-debugging',`--load-extension=${adapter}`],options)});
  const otherTarget=await otherBrowser.transport.send('Target.createTarget',{url:'about:blank'});
  const otherPage=await pageConnection(otherBrowser.transport,otherTarget.targetId);await navigate(otherPage,`chrome-extension://${extensionId}/setup.html`);
  const otherHello=(await deadline(otherPage.send('Runtime.evaluate',{expression:"chrome.runtime.sendMessage({type:'status'})",awaitPromise:true,returnByValue:true}),'other_browser_bootstrap')).result.value;
  assert.equal(otherHello.digest,built.digest);assert.notEqual(otherHello.epoch,hello.epoch);
  const otherFiles=(await fs.readdir(connectionDir)).filter(name=>name.endsWith('.json')&&path.join(connectionDir,name)!==advertisement);
  assert.equal(otherFiles.length,1);otherClient=await connectNative(path.join(connectionDir,otherFiles[0]),otherHello.epoch);
  const staged=path.join(temp.root,'staged');await fs.cp(adapter,staged,{recursive:true});
  await fs.appendFile(path.join(staged,'worker.js'),'\n// foundation update digest probe\n');
  const nextDigest=createHash('sha256').update(await fs.readFile(path.join(staged,'worker.js'))).digest('hex');
  const update=await cliCall('update','--from',staged,'--connection',existingConnectionId(advertisement),'--instance',hello.epoch,'--tab',String(tabs[0]));
  assert.deepEqual(update,{state:'updated',digest:nextDigest});
  const updatedStatus=await cliCall('status');assert.equal(updatedStatus.state,'ready');assert.equal(updatedStatus.extensionId,extensionId);
  evidence.checks.push('public packed CLI update commits verified metadata, preserves extension ID and reports ready afterward');
  const badStage=path.join(temp.root,'rollback-stage');await fs.cp(adapter,badStage,{recursive:true});
  await fs.appendFile(path.join(badStage,'worker.js'),'\n// forced-handshake-mismatch rollback probe\n');
  const badDigest=createHash('sha256').update(await fs.readFile(path.join(badStage,'worker.js'))).digest('hex');
  const currentConnection=async()=>{
    const discovery=await discoverExistingDirectory(connectionDir);
    const connection=(discovery.connections??[discovery]).find(entry=>entry.instanceId!==otherHello.epoch);
    assert.ok(connection);
    const file=(await nativeAdvertisements(connectionDir)).find(file=>existingConnectionId(file)===connection.connectionId);assert.ok(file);
    return {connection,file};
  };
  const injectedControl=(failAll=false)=>async({ticket,signal,bindingRequired})=>{
    const {connection,file}=await currentConnection();
    const lifecycle=await developmentUpdateControl({directory:connectionDir,advertisement:file,instanceId:connection.instanceId,ticket,smokeTabId:tabs[0],signal,bindingRequired});updateControls.push(lifecycle);
    return {...lifecycle,
      quiesce:async()=>{await lifecycle.quiesce();await assert.rejects(otherClient.call('prove_update',{ticket},true),/update_binding_lost/);},
      waitBootstrap:async digest=>{const actual=await lifecycle.waitBootstrap(digest);return failAll||digest===badDigest?{...actual,digest:'0'.repeat(64)}:actual;},
    };
  };
  const rollback=await updateInstalledAdapter(adapter,badStage,injectedControl());
  assert.deepEqual(rollback,{state:'rolled_back',digest:nextDigest});
  const {connection:recoveryConnection}=await currentConnection();
  const recovered=await cliCall('recover','--connection',recoveryConnection.connectionId,'--instance',recoveryConnection.instanceId,'--tab',String(tabs[0]));
  assert.deepEqual(recovered,{state:'already_committed',digest:nextDigest});
  evidence.checks.push('packed durable transaction rolls back a forced bootstrap mismatch; second profile cannot prove marker; public recovery recognizes committed result');
  await assert.rejects(updateInstalledAdapter(adapter,badStage,injectedControl(true)),/adapter_bootstrap_recovery_required/);
  const interrupted=await cliCall('status');assert.equal(interrupted.state,'recovery_required');
  const journalBeforeWrong=await fs.readFile(path.join(adapter,'update.json'));
  await assert.rejects(cliCall('recover','--connection',existingConnectionId(path.join(connectionDir,otherFiles[0])),'--instance',otherHello.epoch,'--tab',String(tabs[0])),error=>String(error.stderr).includes('update_binding_lost'));
  assert.deepEqual(await fs.readFile(path.join(adapter,'update.json')),journalBeforeWrong);
  const {connection:pendingConnection}=await currentConnection();
  const resumed=await cliCall('recover','--connection',pendingConnection.connectionId,'--instance',pendingConnection.instanceId,'--tab',String(tabs[0]));
  assert.deepEqual(resumed,{state:'rolled_back',digest:nextDigest});
  assert.equal((await cliCall('status')).state,'ready');
  evidence.checks.push('double bootstrap failure retains journal; public recovery rejects wrong live profile without changing evidence and restores original profile to ready');
  const {connection:killConnection,file:killAdvertisement}=await currentConnection();
  const updater=fork(fileURLToPath(new URL('./foundation-update-client.mjs',import.meta.url)),[candidate,adapter,badStage,connectionDir,killAdvertisement,killConnection.instanceId,String(tabs[0])],{stdio:['ignore','ignore','pipe','ipc'],windowsHide:true});
  try{
    await deadline(new Promise((resolve,reject)=>{
      updater.once('message',message=>message.type==='published'?resolve():reject(new Error(message.message??'update_child_failed')));
      updater.once('error',reject);updater.once('exit',()=>reject(new Error('update_child_exited_before_boundary')));
    }),'updater_publication_boundary');
    assert.equal((await cliCall('status')).state,'updating');
    assert.equal(JSON.parse(await fs.readFile(path.join(adapter,'update.json'),'utf8')).phase,'published');
    assert.equal(createHash('sha256').update(await fs.readFile(path.join(adapter,'worker.js'))).digest('hex'),badDigest);
    const exited=once(updater,'exit');updater.kill('SIGKILL');await exited;
    assert.equal((await cliCall('status')).state,'recovery_required');
    const {connection:afterKill}=await currentConnection();
    const killRecovery=await cliCall('recover','--connection',afterKill.connectionId,'--instance',afterKill.instanceId,'--tab',String(tabs[0]));
    assert.deepEqual(killRecovery,{state:'rolled_back',digest:nextDigest});
    assert.equal((await cliCall('status')).state,'ready');
    evidence.checks.push('exact updater process killed after real code publication; kernel lock released without cleanup; public recovery restores verified previous code and ready status');
  }finally{
    if(updater.exitCode===null&&updater.signalCode===null){const exited=once(updater,'exit');updater.kill('SIGKILL');await exited;}
  }
  evidence.pass=true;
} catch(error) {
  evidence.failure=error.code??error.message;
  if(browser){
    evidence.failureTargets=(await browser.transport.send('Target.getTargets').catch(()=>({targetInfos:[]}))).targetInfos.filter(target=>target.type==='page').map(({targetId,openerId,url})=>({targetId,openerId,url}));
    if(installation)evidence.failureConnections=await discoverExistingDirectory(path.join(installation.root,'connections')).catch(()=>({unavailable:true}));
    const setupTarget=evidence.failureTargets.find(target=>target.url===`chrome-extension://${extensionId}/setup.html`);
    if(setupTarget){
      const setupPage=await pageConnection(browser.transport,setupTarget.targetId);
      evidence.failureTabOpeners=(await setupPage.send('Runtime.evaluate',{expression:'chrome.tabs.query({}).then(tabs=>tabs.map(({id,openerTabId})=>({id,openerTabId})))',awaitPromise:true,returnByValue:true})).result.value;
    }
    console.error('popup lifecycle diagnostic:',JSON.stringify({targets:evidence.failureTargets,connections:evidence.failureConnections,openers:evidence.failureTabOpeners}));
  }
  if(error.cause instanceof AggregateError)evidence.updateFailures=error.cause.errors.map(cause=>({name:cause.name,message:String(cause.message).slice(0,1024)}));
  evidence.fixtureFailureState=await Promise.all([...oracles.values()].map(async page=>{
    try{return (await deadline(page.send('Runtime.evaluate',{expression:'({pointer:fixturePointer,checked:document.querySelector("#toggle").checked,visibility:document.visibilityState})',returnByValue:true}),'failure_oracle',1000)).result.value;}
    catch{return {unavailable:true};}
  }));
  console.error('native foundation failure:',error.message,JSON.stringify(evidence.fixtureFailureState));throw error;
}
finally {
  for(const control of updateControls)control.close();
  otherClient?.close();
  for (const client of clients) if (client.connected) client.kill();
  let cleanupError;
  if (browser) await browser.close().catch(error=>{cleanupError=error;});
  if(otherBrowser)await otherBrowser.close().catch(error=>{cleanupError??=error;});
  if (installation) await installation.unregister();
  await new Promise(resolve=>server.close(resolve));
  // Browser shutdown closes Native Messaging and the launcher. Cleanup checks ownership before deletion.
  if(!cleanupError)temp.remove();
  await fs.writeFile(new URL(`../test/evidence/foundation-tab-connection${evidence.headless?'':'-headed'}.json`,import.meta.url),JSON.stringify(evidence,null,2)+'\n');
}
console.log(JSON.stringify(evidence));
