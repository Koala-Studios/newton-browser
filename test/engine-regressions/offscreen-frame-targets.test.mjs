import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { temporaryRoot } from "../../scripts/prototypes/support.mjs";
import { discoverBrowserExecutable } from "../../apps/mcp-server/src/browser-runtime/browser-discovery.ts";
import { createNewtonIdentity, openProfileStore } from "../../apps/mcp-server/src/browser-runtime/profile-store.ts";
import { ownedEngineConnection } from "../../apps/mcp-server/src/browser-runtime/engine-host.ts";
import { PageExecutor } from "../../packages/driver/src/page-executor.ts";
import { SessionEngine } from "../../packages/driver/src/session-engine.ts";

// An app embeds cross-site frames (an assistant panel, previews) below the fold or hidden. Chromium throttles their
// rendering, and a role query into such a frame never answers, so every role target on the page was refused. A page
// holds several such frames (previews below an editor); their bounds must not add up past a command's default deadline.
const FRAME = (label) => `<!doctype html><meta charset="utf-8"><button onclick="parent.postMessage('${label}','*')">${label}</button>`;
const PAGE = (port, below) => `<!doctype html><meta charset="utf-8"><title>App</title>
<script>addEventListener("message", event => { document.title = "clicked " + event.data; });</script>
<button onclick="document.title='clicked Save'">Save</button>
<iframe title="Panel" style="position:absolute;top:3000px;width:300px;height:200px;border:0" src="http://localhost:${port}/frame?label=${below}"></iframe>
<iframe title="Hidden" style="visibility:hidden;width:300px;height:200px;border:0" src="http://localhost:${port}/frame?label=Secret"></iframe>
${[1, 2, 3, 4].map(index => `<iframe title="Preview ${index}" style="position:absolute;top:${3000 + index * 300}px;width:300px;height:200px;border:0" src="http://localhost:${port}/frame?label=Preview${index}"></iframe>`).join("")}`;

test("role targets resolve on a page whose cross-site frames are throttled offscreen or hidden", async () => {
  const browser = discoverBrowserExecutable({ family: "chrome", env: process.env });
  if (!browser) { test.skip("Chrome is unavailable"); return; }
  const root = temporaryRoot("offscreen-frame-targets");
  const store = openProfileStore(`${root.root}/identities`);
  const identity = createNewtonIdentity(store, { browserFamily: "chrome" });
  const fixture = http.createServer((request, response) => {
    response.setHeader("content-type", "text/html; charset=utf-8");
    const url = new URL(request.url, "http://fixture");
    response.end(url.pathname === "/frame" ? FRAME(url.searchParams.get("label")) : PAGE(fixture.address().port, url.searchParams.get("below") ?? "Inside"));
  });
  await new Promise(resolve => fixture.listen(0, "127.0.0.1", resolve));
  const owned = await ownedEngineConnection({ executablePath: browser.path, browserFamily: "chrome", profileStore: store, identityId: identity.id, ephemeralIdentity: true });
  const executor = new PageExecutor(owned);
  try {
    const origin = `http://127.0.0.1:${fixture.address().port}`;
    await executor.start(`${origin}/`, { timeoutMs: 15_000 });
    const engine = new SessionEngine("offscreen-frame-targets", executor);
    let commandId = 0;
    const act = (action) => engine.submit({ commandId: ++commandId, action, timeoutMs: 10_000, maxBytes: 16384, observe: "none" });
    const click = (name) => act({ kind: "click", target: { kind: "semantic", role: "button", name, exact: true } });
    const page = executor.bindPage(), binding = executor.directory.binding(page, 1);
    const title = async () => (await executor.send(binding, "Runtime.evaluate", { expression: "document.title", returnByValue: true })).result.value;
    for (const deadline = Date.now() + 5000; Date.now() < deadline && executor.directory.frames(page.pageId).length < 7;) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(executor.directory.frames(page.pageId).length, 7, "every cross-site frame attached");

    const started = performance.now();
    const save = await click("Save");
    assert.equal(save.reason, "completed", JSON.stringify(save));
    assert.ok(performance.now() - started < 6000, "five withheld frames cost one bound, not one each");
    assert.equal(await title(), "clicked Save");
    const inside = await click("Inside");
    assert.equal(inside.reason, "completed", JSON.stringify(inside));
    for (const deadline = Date.now() + 2000; Date.now() < deadline && await title() !== "clicked Inside";) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(await title(), "clicked Inside", "a button in the frame below the fold is found and clicked");
    const secret = await click("Secret");
    assert.equal(secret.errorCode, "not_found", "a button in a hidden frame is not a target: " + JSON.stringify(secret));

    // The frame below the fold holds a second Save: the action is ambiguous, not a guess at the top one.
    await executor.send(binding, "Page.navigate", { url: `${origin}/?below=Save` });
    for (const deadline = Date.now() + 5000; Date.now() < deadline && (await title().catch(() => "") !== "App" || executor.directory.frames(executor.bindPage().pageId).length < 7);) await new Promise(resolve => setTimeout(resolve, 50));
    const twice = await click("Save");
    assert.equal(twice.errorCode, "ambiguous", JSON.stringify(twice));
  } finally {
    await executor.close().catch(() => undefined);
    await owned.close?.().catch(() => undefined);
    fixture.close();
    root.remove();
  }
});
