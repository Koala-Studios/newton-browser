import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { temporaryRoot } from "../../scripts/prototypes/support.mjs";
import { discoverBrowserExecutable } from "../../apps/mcp-server/src/browser-runtime/browser-discovery.ts";
import { createNewtonIdentity, openProfileStore } from "../../apps/mcp-server/src/browser-runtime/profile-store.ts";
import { ownedEngineConnection } from "../../apps/mcp-server/src/browser-runtime/engine-host.ts";
import { PageExecutor } from "../../packages/driver/src/page-executor.ts";
import { SessionEngine } from "../../packages/driver/src/session-engine.ts";

// A theme editor shows the store in a cross-site preview frame among other frames, and the store scrolls an inner
// wrapper, not its document. A scroll aimed at "iframe" was ambiguous, and nothing could scroll the preview.
// A frame element as the target scrolls inside that frame; `at` scrolls at a screenshot point in whatever frame and
// scroller is under it. Both run in the frame's own renderer, in a borrowed background tab.
const PREVIEW = `<!doctype html><style>html,body{margin:0;height:100%;overflow:hidden}.wrapper{height:100%;overflow:auto}</style>
<div class="wrapper"><section style="height:3000px">Store preview</section></div>`;

test("a frame element target and a screenshot point scroll a cross-site preview's inner scroller", async t => {
  const browser = discoverBrowserExecutable({ family: "chrome", env: process.env });
  if (!browser) { t.skip("Chrome is unavailable"); return; }
  const root = temporaryRoot("frame-scroll");
  const server = http.createServer((request, response) => {
    response.setHeader("content-type", "text/html; charset=utf-8");
    const port = server.address().port;
    response.end(request.url === "/preview" ? PREVIEW : request.url === "/blank" ? "<p>tool</p>"
      : `<!doctype html><body style="margin:0"><iframe src="/blank" style="width:200px;height:100px"></iframe><iframe src="/blank" style="width:0;height:0;border:0"></iframe>
        <iframe title="Preview" src="http://localhost:${port}/preview" style="position:absolute;left:250px;top:120px;width:600px;height:400px;border:0"></iframe></body>`);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const store = openProfileStore(`${root.root}/identities`);
  const owned = await ownedEngineConnection({ executablePath: browser.path, browserFamily: "chrome", profileStore: store, identityId: createNewtonIdentity(store, { browserFamily: "chrome" }).id, ephemeralIdentity: true });
  const executor = new PageExecutor({ ...owned, ownsBrowser: false, borrowedTab: true });
  try {
    await owned.wire.send("Target.createTarget", { url: "about:blank" });
    await executor.start(`http://127.0.0.1:${server.address().port}/`, { timeoutMs: 15_000 });
    const engine = new SessionEngine("frame-scroll", executor);
    let commandId = 0;
    const act = action => engine.submit({ commandId: ++commandId, action, timeoutMs: 8000, maxBytes: 16384, observe: "none" });
    const page = executor.bindPage();
    const preview = executor.directory.frames(page.pageId).map(frame => executor.directory.route(executor.directory.binding(frame, 1))).find(route => route !== executor.directory.route(executor.directory.binding(page, 1)));
    const offset = async () => (await owned.wire.send("Runtime.evaluate", { expression: "document.querySelector('.wrapper').scrollTop", returnByValue: true }, preview)).result.value;
    assert.ok(preview, "the preview frame has its own renderer route");

    const ambiguous = await act({ kind: "scroll", x: 0, y: 300, target: { kind: "selector", selector: "iframe" } });
    assert.equal(ambiguous.errorCode, "ambiguous", "several frames: the model must pick one");
    const byFrame = await act({ kind: "scroll", x: 0, y: 300, target: { kind: "selector", selector: 'iframe[src*="localhost"]' } });
    assert.deepEqual([byFrame.reason, byFrame.postcondition], ["completed", { state: "met", kind: "visible" }], JSON.stringify(byFrame.steps));
    const first = await offset();
    assert.ok(first > 0, "the preview's inner scroller moved");

    const shot = await engine.screenshot({ maxBytes: 4_000_000, options: {} });
    const atPoint = await act({ kind: "scroll", x: 0, y: 400, at: { captureId: shot.provenance.captureId, x: 500, y: 300 } });
    assert.deepEqual([atPoint.reason, atPoint.postcondition], ["completed", { state: "met", kind: "visible" }], JSON.stringify(atPoint.steps));
    assert.ok(await offset() > first, "a wheel at a screenshot point scrolls the frame under it");
    await assert.rejects(async () => act({ kind: "scroll", x: 0, y: 1, at: { captureId: shot.provenance.captureId, x: 1, y: 1 }, target: { kind: "selector", selector: "body" } }), /invalid_arguments/);
  } finally { await executor.close(); server.close(); root.remove(); }
});
