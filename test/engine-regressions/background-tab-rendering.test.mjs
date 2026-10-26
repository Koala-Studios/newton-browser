import assert from "node:assert/strict";
import fs from "node:fs";
import zlib from "node:zlib";
import http from "node:http";
import test from "node:test";

import { temporaryRoot } from "../../scripts/prototypes/support.mjs";
import { discoverBrowserExecutable } from "../../apps/mcp-server/src/browser-runtime/browser-discovery.ts";
import { createNewtonIdentity, openProfileStore } from "../../apps/mcp-server/src/browser-runtime/profile-store.ts";
import { ownedEngineConnection } from "../../apps/mcp-server/src/browser-runtime/engine-host.ts";
import { PageExecutor } from "../../packages/driver/src/page-executor.ts";
import { SessionEngine } from "../../packages/driver/src/session-engine.ts";

// A background tab of the operator's browser runs no animation frames, in its own document and in a cross-site
// embedded app frame alike: the app (which reveals itself on frames) stays blank and pointer input aimed at it has
// no painted frame to land on. While a session holds a borrowed tab it renders as shown. An owned browser stands in
// for the operator's: a second tab in front hides the page, and the connection is marked borrowed.
const APP = `<!doctype html><title>app</title><p id="state">loading</p>
<script>let frames=0;(function tick(){frames++;if(frames===10)document.getElementById('state').textContent='App ready';requestAnimationFrame(tick);})();</script>`;

async function borrowedFixture(t, pages, { keepRendering = true } = {}) {
  const browser = discoverBrowserExecutable({ family: "chrome", env: process.env });
  if (!browser) { t.skip("Chrome is unavailable"); return undefined; }
  const root = temporaryRoot("background-tab-rendering");
  const server = http.createServer((request, response) => {
    const page = pages[new URL(request.url, "http://x").pathname];
    if (typeof page === "function") return page(request, response);
    response.setHeader("content-type", "text/html; charset=utf-8"); response.end(page ?? "");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const store = openProfileStore(`${root.root}/identities`);
  const owned = await ownedEngineConnection({ executablePath: browser.path, browserFamily: "chrome", profileStore: store, identityId: createNewtonIdentity(store, { browserFamily: "chrome" }).id, ephemeralIdentity: true });
  // An adapter from before focus emulation refuses the method: the tab stays hidden.
  const wire = keepRendering ? owned.wire : { send: (method, params, route) => method === "Emulation.setFocusEmulationEnabled" ? Promise.reject(new Error("unsupported_method")) : owned.wire.send(method, params, route), onEvent: listener => owned.wire.onEvent(listener) };
  const executor = new PageExecutor({ ...owned, wire, ownsBrowser: false, borrowedTab: true });
  // The tab is behind another one from the start, as a new background tab of the operator's is.
  await owned.wire.send("Target.createTarget", { url: "about:blank" });
  const close = async () => { await executor.close(); server.close(); root.remove(); };
  const evaluate = async (route, expression) => (await owned.wire.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, route)).result.value;
  const routes = () => { const page = executor.bindPage(); return executor.directory.frames(page.pageId).map(frame => executor.directory.route(executor.directory.binding(frame, 1))); };
  return { executor, owned, port, close, evaluate, routes, directory: root.root };
}

for (const keepRendering of [true, false]) test(`a borrowed background tab ${keepRendering ? "renders its cross-site app frame while held" : "without focus emulation leaves the app frame waiting"}`, async t => {
  const fixture = await borrowedFixture(t, { "/": "", "/app": APP }, { keepRendering });
  if (!fixture) return;
  const { executor, port, close, evaluate, routes } = fixture;
  try {
    await executor.start(`http://127.0.0.1:${port}/`, { timeoutMs: 15_000 }).catch(() => undefined);
    // The host page is set after start so the app frame loads while the tab is already in the background.
    const [main] = routes();
    await evaluate(main, `(()=>{const frame=document.createElement('iframe');frame.src='http://localhost:${port}/app';document.body.append(frame);})()`);
    let app;
    for (const deadline = Date.now() + 5000; Date.now() < deadline && !app;) { app = routes().find(route => route !== main); if (!app) await new Promise(resolve => setTimeout(resolve, 50)); }
    assert.ok(app, "the cross-site app frame has its own renderer route");
    await new Promise(resolve => setTimeout(resolve, 1500)); // Time passes with no engine read: nothing paints for the session.
    const state = await evaluate(app, "({visibility:document.visibilityState,text:document.getElementById('state')?.textContent})");
    if (keepRendering) assert.deepEqual(state, { visibility: "visible", text: "App ready" });
    else assert.deepEqual(state, { visibility: "hidden", text: "loading" }, "a hidden tab runs no frames: the fixture reproduces the stall");
    assert.equal(await evaluate(main, "document.visibilityState"), keepRendering ? "visible" : "hidden");
  } finally { await close(); }
});

// An editor's sidebar asks its cross-site preview to bring a section into view; the preview scrolls smoothly, which
// runs on frames. In a background tab the click landed and the preview never moved (the same fixture without focus
// emulation does not even commit the preview frame within five seconds in headless Chrome).
const PREVIEW = `<!doctype html><style>html,body{margin:0;height:100%;overflow:hidden}.wrapper{height:100%;overflow:auto}</style>
<div class="wrapper"><section style="height:2000px">Top</section><section id="featured">Featured</section><section style="height:2000px"></section></div>
<script>addEventListener('message',event=>{if(event.data==='show')document.getElementById('featured').scrollIntoView({behavior:'smooth'});});</script>`;
test("a sidebar click scrolls a cross-site preview in a borrowed background tab", async t => {
  const editor = port => `<!doctype html><button onclick="document.querySelector('iframe').contentWindow.postMessage('show','*')">Featured</button>
    <iframe title="Preview" src="http://localhost:${port}/preview" style="width:600px;height:300px"></iframe>`;
  let port;
  const fixture = await borrowedFixture(t, { "/": (_request, response) => { response.setHeader("content-type", "text/html"); response.end(editor(port)); }, "/preview": PREVIEW });
  if (!fixture) return;
  port = fixture.port;
  const { executor, close, evaluate, routes } = fixture;
  try {
    await executor.start(`http://127.0.0.1:${port}/`, { timeoutMs: 15_000 });
    const [main, preview] = routes();
    assert.ok(preview && preview !== main);
    const engine = new SessionEngine("sidebar", executor);
    let clicked;
    for (let commandId = 1, deadline = Date.now() + 5000; Date.now() < deadline; commandId++) {
      clicked = await engine.submit({ commandId, action: { kind: "click", target: { kind: "semantic", role: "button", name: "Featured", exact: true } }, timeoutMs: 8000, maxBytes: 16384, observe: "none" });
      if (clicked.errorCode !== "search_incomplete") break; // The preview frame is still committing.
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(clicked.reason, "completed", JSON.stringify(clicked.steps));
    await new Promise(resolve => setTimeout(resolve, 1500));
    const offset = await evaluate(preview, "document.querySelector('.wrapper').scrollTop");
    assert.ok(offset > 1500, `the preview scrolled to the section (${offset})`);
  } finally { await close(); }
});

// A media-library upload dialog: files from the input are compressed (bitmap decode, canvas re-encode) by a queue
// that advances on animation frames, then posted; a row stalled for 3 s turns failed with no message. Set from a
// background tab, every row failed. While the session holds the tab, the queue runs between the model's calls.
const UPLOAD = `<!doctype html><input id="files" type="file" multiple accept="image/*"><button onclick="run()">Upload all</button><ul id="rows"></ul>
<script>function run(){const rows=[...document.getElementById('files').files].map(file=>{const row=document.createElement('li');row.textContent=file.name+' queued';document.getElementById('rows').append(row);return {file,row,state:'queued',since:performance.now()};});
setInterval(()=>{for(const item of rows)if(item.state!=='done'&&performance.now()-item.since>3000){item.state='failed';item.row.textContent=item.file.name+' failed';}},250);
const tick=async()=>{const item=rows.find(entry=>entry.state==='queued');if(!item)return;item.state='sending';
  const bitmap=await createImageBitmap(item.file),canvas=document.createElement('canvas');canvas.width=16;canvas.height=12;canvas.getContext('2d').drawImage(bitmap,0,0,16,12);
  const small=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',0.8));
  const response=await fetch('/upload',{method:'POST',body:new Blob([await item.file.arrayBuffer(),small])});
  if(item.state==='sending'&&response.ok){item.state='done';item.row.textContent=item.file.name+' uploaded '+await response.text();}
  item.since=performance.now();requestAnimationFrame(tick);};
requestAnimationFrame(tick);}</script>`;
function png(width, height) {
  const raw = Buffer.alloc((width * 3 + 1) * height, 0x80);
  for (let y = 0; y < height; y++) raw[y * (width * 3 + 1)] = 0;
  const chunk = (type, data) => { const length = Buffer.alloc(4), crc = Buffer.alloc(4); length.writeUInt32BE(data.length); crc.writeUInt32BE(zlib.crc32(Buffer.concat([Buffer.from(type), data]))); return Buffer.concat([length, Buffer.from(type), data, crc]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
for (const keepRendering of [true, false]) test(`files set in a borrowed background tab ${keepRendering ? "upload through a frame-driven queue" : "without focus emulation stall in a frame-driven queue"}`, async t => {
  let received = 0;
  const fixture = await borrowedFixture(t, { "/": UPLOAD, "/upload": (request, response) => { let bytes = 0; request.on("data", data => { bytes += data.length; }); request.on("end", () => { received++; response.end(String(bytes)); }); } }, { keepRendering });
  if (!fixture) return;
  const { executor, port, close, evaluate, routes } = fixture;
  const files = [`${fixture.directory}/one.png`, `${fixture.directory}/two.png`];
  for (const file of files) fs.writeFileSync(file, png(64, 48));
  try {
    await executor.start(`http://127.0.0.1:${port}/`, { timeoutMs: 15_000 });
    const engine = new SessionEngine("upload", executor);
    let commandId = 0;
    const act = action => engine.submit({ commandId: ++commandId, action, timeoutMs: 8000, maxBytes: 16384, observe: "none" });
    assert.deepEqual((await act({ kind: "set_files", target: { kind: "selector", selector: "#files" }, files })).postcondition, { state: "met", kind: "files" });
    assert.equal((await act({ kind: "click", target: { kind: "semantic", role: "button", name: "Upload all", exact: true } })).reason, "completed");
    await new Promise(resolve => setTimeout(resolve, 4000)); // The model reads nothing while the queue runs.
    const rows = await evaluate(routes()[0], "[...document.querySelectorAll('li')].map(row=>row.textContent.replace(/ uploaded \\d+/,' uploaded'))");
    if (keepRendering) { assert.deepEqual(rows, ["one.png uploaded", "two.png uploaded"]); assert.equal(received, 2); }
    else assert.deepEqual(rows, ["one.png failed", "two.png failed"], "a hidden tab runs no frames: the fixture reproduces the red rows");
  } finally { await close(); }
});
