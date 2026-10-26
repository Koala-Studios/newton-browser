import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { temporaryRoot } from "../../scripts/prototypes/support.mjs";
import { discoverBrowserExecutable } from "../../apps/mcp-server/src/browser-runtime/browser-discovery.ts";
import { createNewtonIdentity, openProfileStore } from "../../apps/mcp-server/src/browser-runtime/profile-store.ts";
import { ownedEngineConnection } from "../../apps/mcp-server/src/browser-runtime/engine-host.ts";
import { PageExecutor } from "../../packages/driver/src/page-executor.ts";
import { SessionEngine } from "../../packages/driver/src/session-engine.ts";

// A screenshot point over a cross-site embedded app frame belongs to that frame. Chrome routes root-level input into
// such a frame by the hit-test data its painted frames carry; in a background tab the frame has painted nothing, so
// the press landed nowhere. Input at a point is dispatched in the session of the frame under it, at its own coordinates.
const MODAL = `<div style="position:fixed;inset:0;background:rgba(0,0,0,.3)"></div><div role="dialog" aria-modal="true" aria-label="Meet the assistant"
  style="position:fixed;left:150px;top:150px;width:200px;height:100px;background:#fff"><button>Not now</button></div>`;
const APP = `<!doctype html><body style="margin:0;height:900px"><button id="go" style="position:absolute;left:50px;top:40px;width:120px;height:30px"
  onclick="this.textContent='pressed '+(++this.dataset.n)" data-n="0">Go</button><p style="position:absolute;top:120px">App text</p></body>`;

test("click_at and move over a cross-site frame in a background tab are dispatched in that frame", async t => {
  const browser = discoverBrowserExecutable({ family: "chrome", env: process.env });
  if (!browser) { t.skip("Chrome is unavailable"); return; }
  const root = temporaryRoot("frame-point-input");
  const server = http.createServer((request, response) => {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(request.url === "/app" ? APP : request.url === "/modal" ? APP.replace("</body>", MODAL + "</body>") : `<!doctype html><body style="margin:0"><div style="height:150px">Host</div>
      <iframe title="App" style="margin-left:200px;width:500px;height:300px;border:0" src="http://localhost:${server.address().port}/app"></iframe></body>`);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const store = openProfileStore(`${root.root}/identities`);
  const owned = await ownedEngineConnection({ executablePath: browser.path, browserFamily: "chrome", profileStore: store, identityId: createNewtonIdentity(store, { browserFamily: "chrome" }).id, ephemeralIdentity: true });
  const presses = [];
  // No focus emulation (an older adapter): the tab stays hidden, as the operator's background tab was.
  const wire = { send: (method, params, route) => {
    if (method === "Emulation.setFocusEmulationEnabled") return Promise.reject(new Error("unsupported_method"));
    if (method === "Input.dispatchMouseEvent" && params.type !== "mouseMoved") presses.push({ route, type: params.type, x: params.x, y: params.y });
    return owned.wire.send(method, params, route);
  }, onEvent: listener => owned.wire.onEvent(listener) };
  const executor = new PageExecutor({ ...owned, wire, ownsBrowser: false, borrowedTab: true });
  try {
    await owned.wire.send("Target.createTarget", { url: "about:blank" });
    await executor.start(`http://127.0.0.1:${server.address().port}/`, { timeoutMs: 15_000 });
    const engine = new SessionEngine("frame-point-input", executor);
    let commandId = 0;
    const act = action => engine.submit({ commandId: ++commandId, action, timeoutMs: 8000, maxBytes: 16384, observe: "none" });
    const page = executor.bindPage(), [main, app] = executor.directory.frames(page.pageId).map(frame => executor.directory.route(executor.directory.binding(frame, 1)));
    assert.ok(app && app !== main, "the app frame has its own renderer route");
    const text = async () => (await owned.wire.send("Runtime.evaluate", { expression: "document.getElementById('go').textContent", returnByValue: true }, app)).result.value;
    const shot = await engine.screenshot({ maxBytes: 4_000_000, options: {} });
    // The button's middle: frame at (200,150), button at (50,40) in it, 120x30.
    const clicked = await act({ kind: "click_at", captureId: shot.provenance.captureId, x: 310, y: 205 });
    assert.equal(clicked.reason, "completed", JSON.stringify(clicked.steps));
    assert.equal(await text(), "pressed 1", "the press reached the button inside the frame");
    assert.deepEqual(presses.map(press => [press.route === app, press.type, press.x, press.y]), [[true, "mousePressed", 110, 55], [true, "mouseReleased", 110, 55]]);
    // A point on the host page outside the frame stays on the host.
    presses.length = 0;
    const host = await act({ kind: "click_at", captureId: shot.provenance.captureId, x: 50, y: 50 });
    assert.equal(host.reason, "completed");
    assert.deepEqual(presses.map(press => press.route === main), [true, true]);
    // A modal the app opens covers its controls with a backdrop beside the dialog: the refusal names the dialog.
    await owned.wire.send("Page.navigate", { url: `http://localhost:${server.address().port}/modal` }, app);
    let covered;
    for (const deadline = Date.now() + 5000; Date.now() < deadline;) {
      covered = await act({ kind: "click", target: { kind: "semantic", role: "button", name: "Go", exact: true } });
      if (covered.errorCode === "target_covered") break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.deepEqual([covered.errorCode, covered.steps[0]?.coveredBy], ["target_covered", 'div[role=dialog] "Meet the assistant"']);
  } finally { await executor.close(); server.close(); root.remove(); }
});
