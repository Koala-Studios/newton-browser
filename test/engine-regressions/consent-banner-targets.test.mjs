import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { temporaryRoot } from "../../scripts/prototypes/support.mjs";
import { createBrowserEngine } from "../../apps/mcp-server/src/embedding.ts";
import { discoverBrowserExecutable } from "../../apps/mcp-server/src/browser-runtime/browser-discovery.ts";
import { createNewtonIdentity, openProfileStore } from "../../apps/mcp-server/src/browser-runtime/profile-store.ts";
import { ownedEngineConnection } from "../../apps/mcp-server/src/browser-runtime/engine-host.ts";
import { PageExecutor } from "../../packages/driver/src/page-executor.ts";
import { SessionEngine } from "../../packages/driver/src/session-engine.ts";

// A payments dashboard's fixed bottom cookie banner whose reject button label starts with a zero-width space and a
// space, and a sandbox dialog with alertdialog semantics whose accessible name runs on into its description. The
// observation shows the button's name as it reads; that name, the raw one and a dialog scope by role dialog and part
// of its name all work, a miss says what has the role, and a ref sent with its snapshotId says why it is gone.
const PAGE = `<!doctype html><meta charset="utf-8"><title>dashboard:</title>
<style>body{margin:0;font:16px sans-serif}main{padding:16px}
#consent{position:fixed;left:0;right:0;bottom:0;background:#fff;border-top:1px solid #888;padding:12px;display:flex;gap:8px;align-items:center}
#sandbox{position:fixed;top:24px;right:24px;width:320px;background:#f4f4f4;border:1px solid #888;padding:12px}</style>
<main><h1>Payments</h1><p>Recent activity</p><div style="height:3000px"></div></main>
<div id="sandbox" role="alertdialog" aria-labelledby="sandbox-title sandbox-text">
  <h2 id="sandbox-title">Create a new sandbox</h2><p id="sandbox-text">Sandboxes are isolated test environments for trying changes.</p>
  <label>Sandbox name <input id="sandbox-name"></label> <button onclick="document.title+=' create'">Create</button>
</div>
<div id="consent"><span>We use cookies to run this site.</span>
  <button onclick="document.title+=' reject'">&#8203; Reject all</button>
  <button onclick="document.title+=' accept'">Accept all</button></div>`;

const serve = async () => {
  const server = http.createServer((_request, response) => { response.setHeader("content-type", "text/html; charset=utf-8"); response.end(PAGE); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return server;
};

test("a cookie banner button whose label starts with a zero-width space is found by the name observe shows", async (t) => {
  const temp = temporaryRoot("consent-banner-targets");
  const server = await serve();
  const engine = createBrowserEngine({ configDirectory: temp.root });
  const text = (result) => JSON.parse(result.content.at(-1).text);
  try {
    const started = text(await engine.call("browser.session.start", { url: `http://127.0.0.1:${server.address().port}/` }));
    if (started.errorCode) { t.skip(`browser unavailable: ${started.errorCode}`); return; }
    const { sessionId } = started;
    let next = started.nextCommandId;
    const act = async (action) => { const receipt = text(await engine.call("browser.act", { sessionId, command: { commandId: next, action, observe: "none" } })); next = receipt.nextCommandId; return receipt; };
    const title = async () => text(await engine.call("browser.observe", { sessionId, maxBytes: 2048, query: { text: "zzz" } })).observation.title;

    const observed = text(await engine.call("browser.observe", { sessionId, maxBytes: 16384 })).observation;
    const reject = observed.nodes.find(node => node.role === "button" && node.name.includes("Reject"));
    assert.equal(reject?.name, "Reject all", "the name shows as it reads, without the zero-width space");
    assert.deepEqual(observed.nodes.find(node => node.name === "Create")?.context, [{ role: "alertdialog", name: "Create a new sandbox Sandboxes are isolated test environments for trying changes." }]);

    for (const name of [reject.name, "​ Reject all", " Reject all"]) {
      const receipt = await act({ kind: "click", target: { kind: "semantic", role: "button", name } });
      assert.equal(receipt.reason, "completed", `${JSON.stringify(name)}: ${JSON.stringify(receipt)}`);
    }
    // Scrolled down, the fixed banner is still where the pointer goes.
    assert.equal((await act({ kind: "scroll", x: 0, y: 1500 })).reason, "completed");
    assert.equal((await act({ kind: "click", target: { kind: "semantic", role: "button", name: "reject ALL", exact: false } })).reason, "completed");
    assert.equal(await title(), "dashboard: reject reject reject reject");

    const missed = await act({ kind: "click", target: { kind: "semantic", role: "button", name: "Reject everything" } });
    assert.deepEqual([missed.reason, missed.dispatch, missed.errorCode], ["rejected", "not_started", "not_found"]);
    assert.match(missed.detail, /^No button named "Reject everything"\. 3 with that role: .*"Reject all"/u);
    assert.equal(missed.steps[0].detail, missed.detail);

    const scoped = text(await engine.call("browser.observe", { sessionId, scope: { kind: "semantic", role: "dialog", name: "Create a new sandbox", exact: false } })).observation;
    assert.equal(scoped.state, "available", JSON.stringify(scoped));
    assert.deepEqual(scoped.nodes.map(node => node.name).sort(), ["Create", "Sandbox name"]);
    const exact = text(await engine.call("browser.observe", { sessionId, scope: { kind: "semantic", role: "dialog", name: "Create a new sandbox" } })).observation;
    assert.equal(exact.state, "unavailable");
    assert.equal(exact.errorCode, "not_found");
    assert.match(exact.detail, /^No dialog or alertdialog named "Create a new sandbox"\. 1 with that role: .* 1 contain it: pass exact false/u);
    const wrongRole = text(await engine.call("browser.observe", { sessionId, scope: { kind: "semantic", role: "region", name: "Sandbox", exact: false } })).observation;
    assert.deepEqual([wrongRole.state, wrongRole.errorCode], ["unavailable", "not_found"]);
    assert.match(wrongRole.detail, /^Nothing on the page has role region/u);

    const fresh = text(await engine.call("browser.observe", { sessionId, maxBytes: 16384 })).observation;
    const accept = fresh.nodes.find(node => node.name === "Accept all");
    const byRef = await act({ kind: "click", target: { kind: "ref", ref: accept.ref, snapshotId: fresh.snapshotId } });
    assert.equal(byRef.reason, "completed", JSON.stringify(byRef));
    assert.equal((await act({ kind: "reload" })).reason, "completed");
    const stale = await act({ kind: "click", target: { kind: "ref", ref: accept.ref, snapshotId: fresh.snapshotId } });
    assert.deepEqual([stale.reason, stale.errorCode], ["rejected", "stale_ref"]);
    assert.match(stale.detail, /is gone: its page navigated or its frame went away/u);
  } finally {
    await engine.close();
    server.close();
    temp.remove();
  }
});

test("the banner's button is clicked by its shown name in a hidden borrowed tab", async () => {
  const browser = discoverBrowserExecutable({ family: "chrome", env: process.env });
  if (!browser) { test.skip("Chrome is unavailable"); return; }
  const root = temporaryRoot("consent-banner-hidden");
  const store = openProfileStore(`${root.root}/identities`);
  const identity = createNewtonIdentity(store, { browserFamily: "chrome" });
  const fixture = await serve();
  const owned = await ownedEngineConnection({ executablePath: browser.path, browserFamily: "chrome", profileStore: store, identityId: identity.id, ephemeralIdentity: true });
  // A tab of the operator's browser in the background, with an adapter that cannot keep it rendering.
  const wire = { send: (method, params, route) => method === "Emulation.setFocusEmulationEnabled" ? Promise.reject(new Error("unsupported_method")) : owned.wire.send(method, params, route), onEvent: listener => owned.wire.onEvent(listener) };
  const executor = new PageExecutor({ ...owned, wire, ownsBrowser: false, borrowedTab: true });
  try {
    await executor.start(`http://127.0.0.1:${fixture.address().port}/`, { timeoutMs: 15_000 });
    const engine = new SessionEngine("consent-banner-hidden", executor);
    await owned.wire.send("Target.createTarget", { url: "about:blank" });
    const page = executor.bindPage(), binding = executor.directory.binding(page, 1);
    const evaluate = async (expression) => (await executor.send(binding, "Runtime.evaluate", { expression, returnByValue: true })).result.value;
    for (const deadline = Date.now() + 3000; Date.now() < deadline && await evaluate("document.visibilityState") !== "hidden";) await new Promise(resolve => setTimeout(resolve, 50));
    if (await evaluate("document.visibilityState") !== "hidden") { test.skip("this Chrome keeps background tabs visible"); return; }
    // Hidden and fixed, the banner is neither out of view nor covered: the name as it reads and as the page writes it both land.
    for (const [index, name] of ["Reject all", "\u200b Reject all"].entries()) {
      const receipt = await engine.submit({ commandId: index + 1, action: { kind: "click", target: { kind: "semantic", role: "button", name } }, timeoutMs: 5000, maxBytes: 16384, observe: "none" });
      assert.equal(receipt.reason, "completed", JSON.stringify(receipt));
    }
    assert.equal(await evaluate("document.title"), "dashboard: reject reject");
  } finally { await executor.close(); fixture.close(); root.remove(); }
});
