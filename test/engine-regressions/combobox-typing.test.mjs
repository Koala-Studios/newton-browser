import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { temporaryRoot } from "../../scripts/prototypes/support.mjs";
import { discoverBrowserExecutable } from "../../apps/mcp-server/src/browser-runtime/browser-discovery.ts";
import { createNewtonIdentity, openProfileStore } from "../../apps/mcp-server/src/browser-runtime/profile-store.ts";
import { ownedEngineConnection } from "../../apps/mcp-server/src/browser-runtime/engine-host.ts";
import { PageExecutor } from "../../packages/driver/src/page-executor.ts";
import { SessionEngine } from "../../packages/driver/src/session-engine.ts";

// Audience pickers build a combobox as a wrapper: chosen chips, a toggle and a filter input inside role=combobox.
// type, fill and clear on the combobox were refused as target_not_editable; a person's typing goes to the filter.
const PAGE = `<!doctype html><meta charset="utf-8"><title>Picker</title>
<div role="combobox" aria-label="Audience" aria-expanded="false"><span>VIP</span><input id="filter" aria-label="Search lists"><button>Open</button></div>
<div role="combobox" aria-label="Pair"><input aria-label="From"><input aria-label="To"></div>
<div role="combobox" aria-label="Choice" tabindex="0">Pick one</div>`;

test("type, fill and clear on a wrapper combobox reach the one text field it holds", async () => {
  const browser = discoverBrowserExecutable({ family: "chrome", env: process.env });
  if (!browser) { test.skip("Chrome is unavailable"); return; }
  const root = temporaryRoot("combobox-typing");
  const store = openProfileStore(`${root.root}/identities`);
  const identity = createNewtonIdentity(store, { browserFamily: "chrome" });
  const fixture = http.createServer((_request, response) => { response.setHeader("content-type", "text/html; charset=utf-8"); response.end(PAGE); });
  await new Promise(resolve => fixture.listen(0, "127.0.0.1", resolve));
  const owned = await ownedEngineConnection({ executablePath: browser.path, browserFamily: "chrome", profileStore: store, identityId: identity.id, ephemeralIdentity: true });
  const executor = new PageExecutor(owned);
  try {
    await executor.start(`http://127.0.0.1:${fixture.address().port}/`, { timeoutMs: 15_000 });
    const engine = new SessionEngine("combobox-typing", executor);
    let commandId = 0;
    const act = (action) => engine.submit({ commandId: ++commandId, action, timeoutMs: 10_000, maxBytes: 16384, observe: "none" });
    const combobox = (name) => ({ kind: "semantic", role: "combobox", name });
    const binding = executor.directory.binding(executor.bindPage(), 1);
    const value = async () => (await executor.send(binding, "Runtime.evaluate", { expression: "document.getElementById('filter').value", returnByValue: true })).result.value;

    const typed = await act({ kind: "type", target: combobox("Audience"), value: "News" });
    assert.equal(typed.reason, "completed", JSON.stringify(typed));
    assert.equal(typed.postcondition.state, "met");
    assert.equal(await value(), "News");
    const filled = await act({ kind: "fill", target: combobox("Audience"), value: "Winback" });
    assert.equal(filled.postcondition.state, "met", JSON.stringify(filled));
    assert.equal(await value(), "Winback");
    const cleared = await act({ kind: "clear", target: combobox("Audience") });
    assert.equal(cleared.postcondition.state, "met", JSON.stringify(cleared));
    assert.equal(await value(), "");

    const pair = await act({ kind: "type", target: combobox("Pair"), value: "x" });
    assert.equal(pair.errorCode, "target_not_editable", JSON.stringify(pair));
    assert.match(pair.detail, /more than one text field/u);
    const choice = await act({ kind: "type", target: combobox("Choice"), value: "x" });
    assert.equal(choice.errorCode, "target_not_editable", "a combobox with no text field still refuses: " + JSON.stringify(choice));
  } finally { await executor.close(); fixture.close(); root.remove(); }
});
