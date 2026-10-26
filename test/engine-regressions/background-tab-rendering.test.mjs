import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { temporaryRoot } from "../../scripts/prototypes/support.mjs";
import { discoverBrowserExecutable } from "../../apps/mcp-server/src/browser-runtime/browser-discovery.ts";
import { createNewtonIdentity, openProfileStore } from "../../apps/mcp-server/src/browser-runtime/profile-store.ts";
import { ownedEngineConnection } from "../../apps/mcp-server/src/browser-runtime/engine-host.ts";
import { PageExecutor } from "../../packages/driver/src/page-executor.ts";

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
  return { executor, owned, port, close, evaluate, routes };
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
