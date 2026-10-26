import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { temporaryRoot } from "../../scripts/prototypes/support.mjs";
import { discoverBrowserExecutable } from "../../apps/mcp-server/src/browser-runtime/browser-discovery.ts";
import { createNewtonIdentity, openProfileStore } from "../../apps/mcp-server/src/browser-runtime/profile-store.ts";
import { ownedEngineConnection } from "../../apps/mcp-server/src/browser-runtime/engine-host.ts";
import { PageExecutor } from "../../packages/driver/src/page-executor.ts";
import { SessionEngine } from "../../packages/driver/src/session-engine.ts";

// Keyboard QA needs to know where Tab moved focus and whether a focus ring shows. observe mode focus reads the
// focused element across shadow roots and a cross-site frame, with :focus-visible and the computed outline.
const PAGE = port => `<!doctype html><style>a:focus-visible{outline:3px solid rgb(255,0,0);outline-offset:2px}button.ring:focus{outline:none;box-shadow:0 0 0 2px rgb(0,0,255)}</style>
<input aria-label="Email"><a href="#top">Top link</a><span id="host"></span><button class="ring">Ringed</button>
<iframe title="Embedded" src="http://localhost:${port}/frame" style="width:300px;height:80px"></iframe>
<script>document.getElementById('host').attachShadow({mode:'closed'}).innerHTML='<button>Shadow action</button>';</script>`;

test("observe focus follows Tab across a shadow root and a cross-site frame with focus-visible and ring styles", async t => {
  const browser = discoverBrowserExecutable({ family: "chrome", env: process.env });
  if (!browser) { t.skip("Chrome is unavailable"); return; }
  const root = temporaryRoot("focus-read");
  const server = http.createServer((request, response) => {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(request.url === "/frame" ? `<button>Framed action</button>` : PAGE(server.address().port));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const store = openProfileStore(`${root.root}/identities`);
  const owned = await ownedEngineConnection({ executablePath: browser.path, browserFamily: "chrome", profileStore: store, identityId: createNewtonIdentity(store, { browserFamily: "chrome" }).id, ephemeralIdentity: true });
  // A borrowed background tab, as in the operator's browser.
  const executor = new PageExecutor({ ...owned, ownsBrowser: false, borrowedTab: true });
  try {
    await owned.wire.send("Target.createTarget", { url: "about:blank" });
    await executor.start(`http://127.0.0.1:${server.address().port}/`, { timeoutMs: 15_000 });
    const engine = new SessionEngine("focus-read", executor);
    let commandId = 0;
    const tab = async () => assert.equal((await engine.submit({ commandId: ++commandId, action: { kind: "press", keys: ["Tab"] }, timeoutMs: 5000, maxBytes: 16384, observe: "none" })).reason, "completed");
    const focus = async () => { const view = await engine.observe({ mode: "focus", maxBytes: 8192 }); return { ...view.focus, role: view.nodes[0]?.role, name: view.nodes[0]?.name, ref: view.nodes[0]?.ref }; };

    assert.deepEqual(await focus(), { found: false, role: undefined, name: undefined, ref: undefined });
    await tab();
    const field = await focus();
    assert.deepEqual([field.role, field.name, field.focusVisible, field.inFrame], ["textbox", "Email", true, undefined]);
    await tab();
    const link = await focus();
    assert.deepEqual([link.role, link.name, link.focusVisible, link.outline], ["link", "Top link", true, { style: "solid", width: "3px", color: "rgb(255, 0, 0)", offset: "2px" }]);
    await tab();
    assert.deepEqual([(await focus()).name], ["Shadow action"], "focus inside a closed shadow root");
    await tab();
    const ringed = await focus();
    assert.deepEqual([ringed.name, ringed.outline.style, ringed.boxShadow], ["Ringed", "none", "rgb(0, 0, 255) 0px 0px 0px 2px"]);
    await tab();
    const framed = await focus();
    assert.deepEqual([framed.role, framed.name, framed.inFrame], ["button", "Framed action", true]);
    const clicked = await engine.submit({ commandId: ++commandId, action: { kind: "click", target: { kind: "ref", ref: framed.ref } }, timeoutMs: 5000, maxBytes: 16384, observe: "none" });
    assert.equal(clicked.reason, "completed", "the focus read's ref is actionable");
  } finally { await executor.close(); server.close(); root.remove(); }
});
