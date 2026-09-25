import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import test from "node:test";
import {inflateSync} from 'node:zlib';

import { temporaryRoot } from "../../scripts/prototypes/support.mjs";
import { discoverBrowserExecutable } from "../../apps/mcp-server/src/browser-runtime/browser-discovery.ts";
import { createNewtonIdentity, openProfileStore } from "../../apps/mcp-server/src/browser-runtime/profile-store.ts";
import { ownedEngineConnection } from "../../apps/mcp-server/src/browser-runtime/engine-host.ts";
import { CommandContext } from "../../packages/driver/src/command-context.ts";
import { PageExecutor } from "../../packages/driver/src/page-executor.ts";

test("the session engine refuses unverifiable effects and preserves exact input semantics", async () => {
  const browser = discoverBrowserExecutable({ family: "chrome", env: process.env });
  if (!browser) { test.skip("Chrome is unavailable"); return; }
  const root = temporaryRoot("luna-engine");
  const store = openProfileStore(`${root.root}/identities`);
  const identity = createNewtonIdentity(store, { browserFamily: "chrome" });
  const fixture = http.createServer((request, response) => {
    response.setHeader("content-type", "text/html; charset=utf-8");
    const title = request.url === "/next" ? "Luna B" : "Luna A";
    response.end(`<!doctype html><meta charset="utf-8"><title>${title}</title>
      <input id="normal" value="abc">
      <input id="caret" value="abcd" onfocus="this.setSelectionRange(1,3)">
      <input id="secret" type="password" value="sensitive">
      <button id="covered" onclick="document.title='clicked'">Covered</button>
      <div id="overlay" style="position:fixed;left:0;top:0;width:100%;height:100%;z-index:9"></div>
      <select id="choice"><option value="a">A</option><option value="b" disabled>B</option><option value="c">C</option></select>
      <button id="hidden" hidden>Hidden</button><button id="remove">Remove</button>
      <p id="paragraph-one">Visible paragraph one.</p><p id="paragraph-two">Visible paragraph two.</p>
      <button id="scrolled-action" style="position:absolute;left:10px;top:450px" onclick="this.dataset.clicked='yes'">Scrolled action</button>
      <div style="position:absolute;left:10px;top:1900px;width:50px;height:50px;background:rgb(11,133,217)"></div>
      <div hidden>Hidden document secret.</div><script>var hiddenScriptSecret='script document secret';</script><style>.style-secret{content:'style document secret'}</style><div style="height:2000px"></div>`);
  });
  await new Promise((resolve, reject) => { fixture.once("error", reject); fixture.listen(0, "127.0.0.1", resolve); });
  const address = fixture.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/`;
  let connection;
  let executor;
  const evidence = {};
  try {
    connection = await ownedEngineConnection({ executablePath: browser.path, browserFamily: "chrome", profileStore: store, identityId: identity.id, ephemeralIdentity: true, headless: true });
    executor = new PageExecutor(connection);
    let page = await executor.start(url).then(() => executor.bindPage());
    const run = async (action, timeoutMs = 2000, boundPage = page) => {
      const context = new CommandContext(timeoutMs);
      try { return await executor.act(context, boundPage, action); }
      catch (error) { return { errorCode: error?.code ?? "unknown", detail: error?.detail ?? error?.message ?? "" }; }
      finally { context.dispose(); }
    };
    const evalPage = async (expression) => {
      const context = new CommandContext(2000);
      try {
        const binding = executor.directory.binding(page, 1);
        const result = await connection.wire.send("Runtime.evaluate", { expression, returnByValue: true }, executor.directory.route(binding));
        return result.result?.value;
      } finally { context.dispose(); }
    };
    const historyProbe = executor.directory.binding(page, 1);
    try {
      evidence.historyProbe = await connection.wire.send("Page.getNavigationHistory", {}, executor.directory.route(historyProbe));
    } catch (error) {
      evidence.historyProbe = { errorCode: error?.code ?? "unknown", detail: error?.detail ?? error?.message ?? "" };
    }
    assert.equal(evidence.historyProbe.entries?.[0]?.url, "about:blank");
    assert.equal(evidence.historyProbe.currentIndex, 1);

    evidence.fillEmpty = await run({ kind: "fill", target: { kind: "selector", selector: "#normal" }, value: "" });
    assert.equal(evidence.fillEmpty.state, "met");
    assert.equal(await evalPage("document.querySelector('#normal').value"), "");

    evidence.typeSelection = await run({ kind: "type", target: { kind: "selector", selector: "#caret" }, value: "X" });
    assert.equal(evidence.typeSelection.state, "met");
    assert.equal(await evalPage("document.querySelector('#caret').value"), "aXd");

    evidence.coveredClick = await run({ kind: "click", target: { kind: "selector", selector: "#covered" } });
    assert.equal(evidence.coveredClick.errorCode, "target_moved");
    assert.notEqual(await evalPage("document.title"), "clicked");

    evidence.disabledSelect = await run({ kind: "select", target: { kind: "selector", selector: "#choice" }, value: "B" });
    assert.equal(evidence.disabledSelect.errorCode, "target_not_editable");
    assert.equal(await evalPage("document.querySelector('#choice').value"), "a");

    const documentContext = new CommandContext(2000);
    try {
      evidence.document = await executor.readDocument(documentContext, page, 8192);
    } finally { documentContext.dispose(); }
    assert.match(evidence.document.text, /Visible paragraph one\.\s*Visible paragraph two\./u);
    assert.doesNotMatch(evidence.document.text, /Hidden document secret|script document secret|style document secret/u);

    const screenshotContext = new CommandContext(5000);
    try {
      evidence.capture = await executor.screenshot(screenshotContext, page, 65536, { sensitiveZones: [{ selector: "#secret" }], clip: { x: 10, y: 0, width: 640, height: 240 } });
    } finally { screenshotContext.dispose(); }
    assert.equal(evidence.capture.state, "available");
    assert.equal(evidence.capture.provenance.clip.x, 10);
    assert.equal(evidence.capture.provenance.maskDisposition, "mask_applied");
    evidence.captureClick = await run({ kind: "click_at", captureId: evidence.capture.provenance.captureId, x: 5, y: 5 });
    assert.equal(evidence.captureClick.state, "not_requested");
    const shiftedCaptureContext = new CommandContext(5000);
    let shiftedCapture;
    try {
      shiftedCapture = await executor.screenshot(shiftedCaptureContext, page, 65536, { sensitiveZones: [{ selector: "#secret" }] });
    } finally { shiftedCaptureContext.dispose(); }
    await evalPage("window.scrollTo(0, 400)");
    evidence.scrolledCaptureClick = await run({ kind: "click_at", captureId: shiftedCapture.provenance.captureId, x: 5, y: 5 });
    assert.equal(evidence.scrolledCaptureClick.errorCode, "stale_target");
    await evalPage("document.querySelector('#overlay').remove()");
    const layoutCaptureContext = new CommandContext(5000);
    let layoutCapture;
    try {
      layoutCapture = await executor.screenshot(layoutCaptureContext, page, 65536, { sensitiveZones: [{ selector: "#secret" }] });
    } finally { layoutCaptureContext.dispose(); }
    assert.equal(layoutCapture.provenance.clip.y,400,'a fresh viewport capture starts at the current document scroll offset');
    const scrolledBox=await evalPage("(()=>{const r=document.querySelector('#scrolled-action').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()");
    const freshClick=await run({kind:'click_at',captureId:layoutCapture.provenance.captureId,...scrolledBox});
    assert.equal(freshClick.state,'not_requested');
    assert.equal(await evalPage("document.querySelector('#scrolled-action').dataset.clicked"),'yes');
    await evalPage("document.querySelector('#scrolled-action').style.transform='translateX(20px)'");
    evidence.layoutShiftClick = await run({ kind: "click_at", captureId: layoutCapture.provenance.captureId, x: 5, y: 5 });
    assert.equal(evidence.layoutShiftClick.errorCode, "stale_target");
    const fullContext=new CommandContext(5000);
    const spatialRead=executor.captureSpatialState.bind(executor),fullSpatial=[];
    const originalSend=executor.send.bind(executor),fullCaptureRequests=[];
    executor.send=async(binding,method,params)=>{
      if(method==='Page.captureScreenshot'&&process.env.NEWTON_QA_CAPTURE_WITHOUT_BEYOND==='1')params={...params,captureBeyondViewport:false};
      const result=await originalSend(binding,method,params);
      if(method==='Page.getLayoutMetrics')fullCaptureRequests.push({method,result});
      if(method==='Page.captureScreenshot'){
        fullCaptureRequests.push({method,params});
        if(process.env.NEWTON_QA_CAPTURE_LAYOUT_READ==='1'){
          const layout=await originalSend(binding,'Runtime.evaluate',{expression:'({innerWidth,clientWidth:document.documentElement.clientWidth,bodyWidth:document.body.getBoundingClientRect().width})',returnByValue:true,silent:true,throwOnSideEffect:true});
          fullCaptureRequests.push({method:'post-capture-layout-read',result:layout});
        }
      }
      return result;
    };
    executor.captureSpatialState=async(...args)=>{const state=await spatialRead(...args);fullSpatial.push(state);return state;};
    try{
      const full=await executor.screenshot(fullContext,page,65536,{fullPage:true,sensitiveZones:[{kind:'selector',selector:'#secret'}]});
      assert.equal(full.provenance.clip.y,0);
      assert.ok(full.provenance.clip.height>2000,'fullPage must cover the tall document, not only the viewport');
      assert.ok(Buffer.from(full.imageData,'base64').readUInt32BE(20)>2000,'PNG raster must contain the full document height');
      const png=Buffer.from(full.imageData,'base64'),width=png.readUInt32BE(16),channels=png[25]===6?4:3,idat=[];
      for(let offset=8;offset<png.length;){const length=png.readUInt32BE(offset);if(png.toString('ascii',offset+4,offset+8)==='IDAT')idat.push(png.subarray(offset+8,offset+8+length));offset+=length+12;}
      const rows=inflateSync(Buffer.concat(idat));
      const scale=width/full.provenance.clip.width,row=Math.floor(1925*scale)*(width*channels+1);
      assert.equal(rows[row],0,'trusted mask encoder emits unfiltered rows');
      const pixel=row+1+Math.floor(25*scale)*channels;
      assert.deepEqual([...rows.subarray(pixel,pixel+3)],[11,133,217],'full-page image must render the actual offscreen bottom marker');
    }catch(error){console.error('full-page spatial evidence:',JSON.stringify({fullSpatial,fullCaptureRequests}));throw error;}
    finally{executor.send=originalSend;executor.captureSpatialState=spatialRead;fullContext.dispose();}

    evidence.hiddenWait = await run({ kind: "wait_for", waitFor: { selector: "#hidden", state: "hidden", timeoutMs: 500 } });
    assert.equal(evidence.hiddenWait.state, "met");
    let detachedSettled = false;
    const detachedPromise = run({ kind: "wait_for", waitFor: { selector: "#remove", state: "detached", timeoutMs: 500 } }).finally(() => { detachedSettled = true; });
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(detachedSettled, false);
    await evalPage("document.getElementById('remove')?.remove()");
    evidence.detachedWait = await detachedPromise;
    assert.equal(evidence.detachedWait.state, "met");
    evidence.attachedDetachedTimeout = await run({ kind: "wait_for", waitFor: { selector: "#normal", state: "detached", timeoutMs: 120 } }, 500);
    assert.equal(evidence.attachedDetachedTimeout.errorCode, "timed_out");

    evidence.initialBack = await run({ kind: "back" });
    assert.equal(evidence.initialBack.state, "not_met", JSON.stringify({ initialBack: evidence.initialBack, historyProbe: evidence.historyProbe }));

    evidence.navigate = await run({ kind: "navigate", url: `${url}next` });
    assert.equal(evidence.navigate.state, "met");
    page = executor.bindPage();
    const stalePage = page;
    evidence.back = await run({ kind: "back" });
    assert.equal(evidence.back.state, "met");
    page = executor.bindPage();
    evidence.finalTitle = await evalPage("document.title");
    assert.equal(evidence.finalTitle, "Luna A");
    evidence.forward = await run({ kind: "forward" });
    assert.equal(evidence.forward.state, "met", JSON.stringify(evidence.forward));
    page = executor.bindPage();
    assert.equal(await evalPage("document.title"), "Luna B");
    evidence.staleBack = await run({ kind: "back" }, 2000, stalePage);
    assert.equal(evidence.staleBack.errorCode, "stale_target");
    page = executor.bindPage();
    await evalPage("history.pushState({}, '', location.pathname + '#same-document')");
    evidence.sameDocumentBack = await run({ kind: "back" });
    assert.equal(evidence.sameDocumentBack.state, "met");
    evidence.sameDocumentForward = await run({ kind: "forward" });
    assert.equal(evidence.sameDocumentForward.state, "met");
    evidence.ok = true;
  } finally {
    if (executor) await executor.close();
    await new Promise(resolve => fixture.close(resolve));
    root.remove();
  }
  fs.writeFileSync(new URL("../evidence/luna-engine-regression.json", import.meta.url), `${JSON.stringify({ browserFamily: "chrome", ...evidence }, null, 2)}\n`);
  assert.equal(evidence.ok, true);
});
