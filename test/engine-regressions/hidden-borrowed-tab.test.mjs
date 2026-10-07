import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { temporaryRoot } from "../../scripts/prototypes/support.mjs";
import { discoverBrowserExecutable } from "../../apps/mcp-server/src/browser-runtime/browser-discovery.ts";
import { createNewtonIdentity, openProfileStore } from "../../apps/mcp-server/src/browser-runtime/profile-store.ts";
import { ownedEngineConnection } from "../../apps/mcp-server/src/browser-runtime/engine-host.ts";
import { PageExecutor } from "../../packages/driver/src/page-executor.ts";
import { SessionEngine } from "../../packages/driver/src/session-engine.ts";

// A tab in the operator's own browser is usually in the background: Chromium runs no frames there.
// Role queries then answer only when another accessibility read follows them, content a page renders
// on a frame stays out of the DOM until something paints, and a full-page capture resizes the page.
// An owned browser stands in for the operator's: a second tab hides the page, and the connection is
// marked borrowed so the engine treats it as it would a tab of theirs.
const PAGE = `<!doctype html><meta charset="utf-8"><title>Hidden app</title>
<style>body{margin:0;font:16px sans-serif}#bar{display:flex;gap:8px;padding:8px}
#menu{position:fixed;top:48px;left:120px;background:#fff;border:1px solid #888}</style>
<div id="bar"><button id="more" onclick="openMenu()">More</button><button id="load" onclick="loadRows()">Load rows</button></div>
<div id="status">Loading</div><ul id="rows"></ul>
<script>
let resizes = 0; addEventListener('resize', () => { resizes++; });
function openMenu() {
  const menu = document.createElement('div'); menu.id = 'menu'; menu.setAttribute('role', 'menu');
  for (const name of ['Create a rule', 'Import items in bulk', 'Export']) {
    const item = document.createElement('div'); item.setAttribute('role', 'menuitem'); item.tabIndex = -1;
    const label = document.createElement('div'); label.textContent = name; item.append(label); menu.append(item);
  }
  document.body.append(menu);
}
function loadRows() {
  requestAnimationFrame(() => {
    for (let index = 1; index <= 3; index++) { const row = document.createElement('li'); row.textContent = 'Row ' + index; document.getElementById('rows').append(row); }
    document.getElementById('status').remove();
  });
}
document.querySelector('#more').addEventListener('pointerdown', () => { document.title = 'pressed more'; });
</script>`;

test("a hidden borrowed tab resolves role targets, reads what it renders, lists menu items and keeps click_at points", async () => {
  const browser = discoverBrowserExecutable({ family: "chrome", env: process.env });
  if (!browser) { test.skip("Chrome is unavailable"); return; }
  const root = temporaryRoot("hidden-borrowed-tab");
  const store = openProfileStore(`${root.root}/identities`);
  const identity = createNewtonIdentity(store, { browserFamily: "chrome" });
  const fixture = http.createServer((_request, response) => { response.setHeader("content-type", "text/html; charset=utf-8"); response.end(PAGE); });
  await new Promise(resolve => fixture.listen(0, "127.0.0.1", resolve));
  const owned = await ownedEngineConnection({ executablePath: browser.path, browserFamily: "chrome", profileStore: store, identityId: identity.id, ephemeralIdentity: true });
  const executor = new PageExecutor({ ...owned, ownsBrowser: false, borrowedTab: true });
  try {
    await executor.start(`http://127.0.0.1:${fixture.address().port}/`, { timeoutMs: 15_000 });
    const engine = new SessionEngine("hidden-borrowed-tab", executor);
    let commandId = 0;
    const act = (action, timeoutMs = 5000) => engine.submit({ commandId: ++commandId, action, timeoutMs, maxBytes: 16384, observe: "none" });
    await owned.wire.send("Target.createTarget", { url: "about:blank" });
    const page = executor.bindPage(), binding = executor.directory.binding(page, 1);
    const visibility = async () => (await executor.send(binding, "Runtime.evaluate", { expression: "document.visibilityState", returnByValue: true })).result.value;
    for (const deadline = Date.now() + 3000; Date.now() < deadline && await visibility() !== "hidden";) await new Promise(resolve => setTimeout(resolve, 50));
    if (await visibility() !== "hidden") { test.skip("this Chrome keeps background tabs visible"); return; }

    const started = performance.now();
    const load = await act({ kind: "click", target: { kind: "semantic", role: "button", name: "Load rows", exact: true } });
    assert.equal(load.reason, "completed", JSON.stringify(load));
    assert.ok(performance.now() - started < 2000, "a role target resolves without waiting out an unanswered query");
    const rows = await act({ kind: "wait_for", text: "Row 3", timeoutMs: 3000 });
    assert.equal(rows.reason, "completed", "text the page renders on a frame is found");
    const gone = await act({ kind: "wait_for", text: "Loading", state: "hidden", timeoutMs: 3000 });
    assert.equal(gone.reason, "completed", "text with state hidden waits for the text to go away");
    const present = await act({ kind: "wait_for", text: "Row 1", state: "hidden", timeoutMs: 500 });
    assert.equal(present.errorCode, "timed_out", "text still shown is not hidden");

    const opened = await act({ kind: "click", target: { kind: "semantic", role: "button", name: "More", exact: true } });
    assert.equal(opened.reason, "completed");
    const menu = await engine.observe({ mode: "controls", query: { role: "menuitem" }, maxBytes: 16384 });
    assert.deepEqual(menu.nodes.map(node => node.name), ["Create a rule", "Import items in bulk", "Export"]);

    const shot = await engine.screenshot({ maxBytes: 4_000_000, options: { fullPage: true } });
    assert.equal((await executor.send(binding, "Runtime.evaluate", { expression: "resizes", returnByValue: true })).result.value, 0,
      "a full-page capture of a page that fits does not resize it (app shells relayout and click_at points miss)");
    const box = (await executor.send(binding, "Runtime.evaluate", { returnByValue: true,
      expression: "(()=>{const r=document.querySelector('#more').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()" })).result.value;
    const clicked = await act({ kind: "click_at", captureId: shot.provenance.captureId, ...box });
    assert.equal(clicked.reason, "completed", JSON.stringify(clicked.steps));
    assert.equal((await executor.send(binding, "Runtime.evaluate", { expression: "document.title", returnByValue: true })).result.value, "pressed more");
  } finally { await executor.close(); fixture.close(); root.remove(); }
});
