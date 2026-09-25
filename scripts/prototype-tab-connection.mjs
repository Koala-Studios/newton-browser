// Disposable browser only. Exercises real chrome.debugger; private CDP is only
// the test harness reaching the extension page, never the extension transport.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import {launchChromium} from '../apps/mcp-server/src/browser-runtime/chromium-process.ts';
import {temporaryRoot,pageConnection,navigate,deadline} from './prototypes/support.mjs';
import {prepareNativeProbe} from './prototypes/native-probe.mjs';

const executable=process.env.NEWTON_BROWSER_PROTOTYPE_EXECUTABLE;
assert.ok(executable && path.isAbsolute(executable),'set NEWTON_BROWSER_PROTOTYPE_EXECUTABLE to a disposable-test-capable Chromium');
const owned=temporaryRoot('tabs');
const extensionPath=path.join(owned.root,'adapter');
fs.cpSync(path.resolve('scripts/prototypes/tab-adapter'),extensionPath,{recursive:true});
const profile=path.join(owned.root,'profile');fs.mkdirSync(profile);
const rows=[];
let browser,native,cleanupConfirmed=false,nativeMessagingTested=false;
const headed=process.env.NEWTON_BROWSER_PROTOTYPE_HEADED==='1';
const server=http.createServer((req,res)=>{
  res.setHeader('content-type','text/html');
  res.end('<!doctype html><title>Independent tab</title><label>Draft<input id="draft"></label><button>Save draft</button>');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
try {
  browser=await launchChromium({executablePath:executable,userDataDir:profile,browserFamily:'chrome',headless:!headed,
    // Development-only switch in a test process; never alter production args.
    spawn:(exe,args,options)=>spawn(exe,[...args,'--enable-unsafe-extension-debugging',`--load-extension=${extensionPath}`],options)});
  const transport=browser.transport;
  rows.push({id:'browser',...(await transport.send('Browser.getVersion',{}))});
  const inventory=await transport.send('Extensions.getExtensions',{});
  const installed=inventory.extensions.find(e=>e.name==='Newton connection feasibility fixture');
  assert.ok(installed,'fixture extension not loaded');
  const extensionId=installed.id;assert.match(extensionId,/^[a-p]{32}$/);
  // Exercise Chrome's ordinary developer-mode switch in this disposable profile.
  // Loading by a test switch alone does not establish the normal dev UI setting.
  const devTarget=await transport.send('Target.createTarget',{url:'about:blank'});
  const devPage=await pageConnection(transport,devTarget.targetId);
  await navigate(devPage,'chrome://extensions/');
  const devAx=await devPage.send('Accessibility.getFullAXTree');
  const devSwitch=devAx.nodes.find(n=>n.name?.value==='Developer mode' && n.backendDOMNodeId && ['switch','button','checkbox'].includes(n.role?.value));
  assert.ok(devSwitch,JSON.stringify(devAx.nodes.filter(n=>n.name?.value?.includes('Developer')).map(n=>({role:n.role,name:n.name}))));
  if(!devSwitch.properties?.some(p=>['checked','pressed'].includes(p.name) && p.value?.value==='true')) {
    const {model}=await devPage.send('DOM.getBoxModel',{backendNodeId:devSwitch.backendDOMNodeId});
    const x=(model.border[0]+model.border[4])/2,y=(model.border[1]+model.border[5])/2;
    await devPage.send('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',clickCount:1});
    await devPage.send('Input.dispatchMouseEvent',{type:'mouseReleased',x,y,button:'left',clickCount:1});
    const checked=await devPage.send('Accessibility.getFullAXTree');
    const state=checked.nodes.find(n=>n.name?.value==='Developer mode' && n.role?.value===devSwitch.role.value);
    assert.ok(state?.properties?.some(p=>['checked','pressed'].includes(p.name) && p.value?.value==='true'),'developer mode did not turn on');
  }
  rows.push({id:'development_mode',enabledThroughBrowserUI:true});
  async function harness() {
    const {targetId}=await transport.send('Target.createTarget',{url:'about:blank'});
    const page=await pageConnection(transport,targetId);
    await navigate(page,`chrome-extension://${extensionId}/page.html`);
    return page;
  }
  let control=await harness();
  async function request(message) {
    const result=await control.send('Runtime.evaluate',{expression:`chrome.runtime.sendMessage(${JSON.stringify(message)})`,awaitPromise:true,returnByValue:true});
    assert.ok(!result.exceptionDetails,'extension message exception');
    return result.result.value;
  }
  async function call(message) {const result=await request(message);assert.ok(result.ok,JSON.stringify(result));return result.value;}
  const firstHello=await call({op:'hello'});
  assert.equal(firstHello.probeBuild,1);
  const tabs=await Promise.all([call({op:'create',url:'about:blank'}),call({op:'create',url:'about:blank'})]);
  const claims=await Promise.all(tabs.map((tabId,i)=>call({op:'claim',tabId,owner:`worker-${i}`})));
  const scoped=(i,message)=>({...claims[i],tabId:tabs[i],...message});
  const send=(i,method,params={})=>call(scoped(i,{op:'cdp',method,params}));
  async function go(i,url) {
    await send(i,'Page.enable');await send(i,'Page.setLifecycleEventsEnabled',{enabled:true});
    const navigation=await send(i,'Page.navigate',{url});
    assert.ok(!navigation.errorText,navigation.errorText);
    const result=await deadline(control.send('Runtime.evaluate',{expression:`waitForLoad(${tabs[i]},${JSON.stringify(navigation.loaderId)})`,awaitPromise:true,returnByValue:true}),'page_load');
    assert.equal(result.result.value,true);
  }
  await Promise.all(tabs.map((_,i)=>go(i,origin)));
  const conflict=await request({op:'claim',tabId:tabs[0],owner:'competitor'});
  assert.equal(conflict.error,'tab_owned');
  const forged=await request({...scoped(0,{op:'cdp',method:'Page.getFrameTree'}),owner:'competitor'});
  assert.equal(forged.error,'claim_invalid');
  rows.push({id:'ownership',competingClaimRejected:true,foreignWorkerRejected:true});
  const start=performance.now();
  await Promise.all(tabs.map(async(_,i)=>{
    const {root}=await send(i,'DOM.getDocument');
    const {nodeId}=await send(i,'DOM.querySelector',{nodeId:root.nodeId,selector:'#draft'});
    assert.ok(nodeId);await send(i,'DOM.focus',{nodeId});
    await send(i,'Input.insertText',{text:`worker-${i}-draft`});
  }));
  const values=await Promise.all(tabs.map(async(_,i)=>{
    const result=await send(i,'Runtime.evaluate',{expression:`document.querySelector('#draft').value==='worker-${i}-draft'`,returnByValue:true,throwOnSideEffect:true});
    return result.result.value;
  }));
  assert.deepEqual(values,[true,true]);
  rows.push({id:'parallel_tab_input',passed:true,elapsedMs:Math.round(performance.now()-start),profileWideMutex:false});
  const ax=await Promise.all(tabs.map((_,i)=>send(i,'Accessibility.getFullAXTree')));
  assert.ok(ax.every(r=>r.nodes.some(n=>n.role?.value==='textbox')));
  const screenshot=await send(1,'Page.captureScreenshot',{format:'png'});
  assert.ok(screenshot.data.length>0);rows.push({id:'observation_primitives',accessibility:true,screenshot:true});
  // Real public page: extension navigation and a semantic tree, no fixture DOM.
  await go(0,'https://www.wikipedia.org/');
  const publicAx=await send(0,'Accessibility.getFullAXTree');
  const publicReady=publicAx.nodes.some(n=>n.name?.value?.includes('Wikipedia'));
  assert.ok(publicReady);rows.push({id:'public_page',url:'https://www.wikipedia.org/',semanticContentConfirmed:true});
  native=prepareNativeProbe(owned.root,extensionId);await native.listening;
  await call({op:'connectNative',hostName:native.hostName});
  const nativeHello=await native.call({op:'hello'});assert.equal(nativeHello.value?.epoch,firstHello.epoch);
  const nativeCdp=await native.call(scoped(1,{op:'cdp',method:'Page.getFrameTree'}));
  assert.equal(nativeCdp.value?.frameTree?.frame?.url,origin+'/');
  const nativeRaster=await native.call(scoped(1,{op:'cdp',method:'Page.captureScreenshot',params:{format:'png'}}));
  assert.ok(nativeRaster.value?.data?.length>0);
  nativeMessagingTested=true;
  rows.push({id:'native_messaging',privateNamedPipe:true,hello:true,tabCdpRoundTrip:true,screenshotRoundTrip:true,httpRelay:false});
  await native.close();native=null;
  await Promise.all(tabs.map((_,i)=>call(scoped(i,{op:'detach'}))));
  const {targetInfos}=await transport.send('Target.getTargets');
  assert.ok(targetInfos.some(t=>t.url===origin+'/'));rows.push({id:'detach_keeps_tabs_and_browser',passed:true});
  const beforeReloadClaim=await call({op:'claim',tabId:tabs[1],owner:'worker-1'});
  const beforeReloadScope={...beforeReloadClaim,tabId:tabs[1],op:'cdp',method:'Page.getFrameTree'};
  assert.ok((await call(beforeReloadScope)).frameTree);
  // A quiescent worker update: changed packaged code, self-reload, same install.
  const workerPath=path.join(extensionPath,'worker.js');
  const beforeCode=fs.readFileSync(workerPath,'utf8');assert.ok(beforeCode.includes('const probeBuild=1;'));
  fs.writeFileSync(workerPath,beforeCode.replace('const probeBuild=1;','const probeBuild=2;'));
  const reloadResult=await control.send('Runtime.evaluate',{expression:'chrome.runtime.reload()',returnByValue:true}).catch(error=>({transportError:error.message}));
  rows.push({id:'reload_dispatch',result:reloadResult});
  // Test the connection handshake itself, not incidental DevTools target events.
  control=await harness();
  const secondHello=await call({op:'hello'});assert.notEqual(secondHello.epoch,firstHello.epoch);
  assert.equal(secondHello.probeBuild,2);
  const stale=await request(beforeReloadScope);assert.equal(stale.error,'claim_invalid');
  const freshClaim=await call({op:'claim',tabId:tabs[1],owner:'worker-1'});
  assert.ok((await call({...freshClaim,tabId:tabs[1],op:'cdp',method:'Page.getFrameTree'})).frameTree);
  await call({...freshClaim,tabId:tabs[1],op:'detach'});
  rows.push({id:'self_reload',sameExtensionId:true,newEpoch:true,buildChangedFrom:1,buildChangedTo:2,previouslyUsableClaimRejected:true,freshClaimWorks:true,reinstallRequired:false});
} catch(error) {rows.push({id:'failure',message:error.message});process.exitCode=1;}
finally {
  let nativeClean=true,browserClean=true;
  try {if(native)await native.close();}catch {nativeClean=false;process.exitCode=1;}
  try {if(browser)await browser.close();}catch {browserClean=false;process.exitCode=1;}
  if(nativeClean && browserClean) {
    try {owned.remove();cleanupConfirmed=true;}catch {process.exitCode=1;}
  }
  await new Promise(resolve=>server.close(resolve));
  const result={prototype:'tab-connection',headed,passed:!process.exitCode,cleanupConfirmed,personalBrowserTouched:false,nativeMessagingTested,rows};
  fs.writeFileSync(`test/evidence/prototype-tab-connection-2026-09-07${headed?'-headed':''}.json`,JSON.stringify(result,null,2)+'\n');
  process.stdout.write(JSON.stringify(result)+'\n');
}
