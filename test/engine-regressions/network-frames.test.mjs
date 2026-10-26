import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { temporaryRoot } from "../../scripts/prototypes/support.mjs";
import { discoverBrowserExecutable } from "../../apps/mcp-server/src/browser-runtime/browser-discovery.ts";
import { createNewtonIdentity, openProfileStore } from "../../apps/mcp-server/src/browser-runtime/profile-store.ts";
import { ownedEngineConnection } from "../../apps/mcp-server/src/browser-runtime/engine-host.ts";
import { PageExecutor } from "../../packages/driver/src/page-executor.ts";
import { SessionEngine } from "../../packages/driver/src/session-engine.ts";

// An embedded app's requests come from its own cross-site frame and renderer. Network reads list them with the frame
// that made them; the page's own requests carry no frame.
test("network records include a cross-site frame's requests with the frame's origin", async t => {
  const browser = discoverBrowserExecutable({ family: "chrome", env: process.env });
  if (!browser) { t.skip("Chrome is unavailable"); return; }
  const root = temporaryRoot("network-frames");
  const server = http.createServer((request, response) => {
    const port = server.address().port;
    if (request.url.startsWith("/api/")) { response.setHeader("content-type", "application/json"); response.end("{}"); return; }
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(request.url === "/app" ? `<button onclick="fetch('/api/app-save')">Save</button><script>fetch('/api/app-boot')</script>`
      : `<script>fetch('/api/host')</script><iframe title="App" src="http://localhost:${port}/app"></iframe>`);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const store = openProfileStore(`${root.root}/identities`);
  const owned = await ownedEngineConnection({ executablePath: browser.path, browserFamily: "chrome", profileStore: store, identityId: createNewtonIdentity(store, { browserFamily: "chrome" }).id, ephemeralIdentity: true });
  const executor = new PageExecutor(owned);
  try {
    const port = server.address().port, app = `http://localhost:${port}`;
    await executor.start(`http://127.0.0.1:${port}/`, { timeoutMs: 15_000, collect: ["network"] });
    const engine = new SessionEngine("network-frames", executor);
    const clicked = await engine.submit({ commandId: 1, action: { kind: "click", target: { kind: "semantic", role: "button", name: "Save", exact: true } }, timeoutMs: 5000, maxBytes: 16384, observe: "none" });
    assert.equal(clicked.reason, "completed");
    let entries = [];
    for (const deadline = Date.now() + 3000; Date.now() < deadline && !entries.some(entry => entry.url.endsWith("/api/app-save"));) {
      entries = (await executor.networkRecords({ limit: 100, maxBytes: 16384 })).entries;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const seen = Object.fromEntries(entries.map(entry => [new URL(entry.url).pathname, entry.frame ?? null]));
    assert.deepEqual({ host: seen["/api/host"], document: seen["/app"], boot: seen["/api/app-boot"], save: seen["/api/app-save"] },
      { host: null, document: app, boot: app, save: app }, JSON.stringify(entries));
    const page = executor.bindPage().pageId;
    assert.ok(entries.every(entry => entry.pageId === page), "frame requests belong to the page that embeds the frame");
    // A frame added once recording runs starts paused until its own recording is on: its first request is there too.
    const main = executor.directory.route(executor.directory.binding(executor.bindPage(), 1));
    await owned.wire.send("Runtime.evaluate", { expression: `(()=>{const frame=document.createElement('iframe');frame.src='http://localhost:${port}/app?second';document.body.append(frame);})()` }, main);
    for (const deadline = Date.now() + 3000; Date.now() < deadline && entries.filter(entry => entry.url.endsWith("/api/app-boot")).length < 2;) {
      entries = (await executor.networkRecords({ limit: 100, maxBytes: 16384 })).entries;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.deepEqual(entries.filter(entry => entry.url.endsWith("/api/app-boot")).map(entry => entry.frame), [app, app]);
  } finally { await executor.close(); server.close(); root.remove(); }
});
