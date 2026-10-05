import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { temporaryRoot } from "../../scripts/prototypes/support.mjs";
import { discoverBrowserExecutable } from "../../apps/mcp-server/src/browser-runtime/browser-discovery.ts";
import { createNewtonIdentity, openProfileStore } from "../../apps/mcp-server/src/browser-runtime/profile-store.ts";
import { ownedEngineConnection } from "../../apps/mcp-server/src/browser-runtime/engine-host.ts";
import { PageExecutor } from "../../packages/driver/src/page-executor.ts";
import { SessionEngine } from "../../packages/driver/src/session-engine.ts";

const page = `<!doctype html><meta charset="utf-8"><title>Drag</title><body>
<div id="a" draggable="true" ondragstart="event.dataTransfer.setData('text','a')" style="width:80px;height:80px">A</div>
<div id="b" ondragover="event.preventDefault()" ondrop="event.preventDefault();out.textContent='html5:'+event.dataTransfer.getData('text')" style="width:80px;height:80px;margin-top:40px">B</div>
<div id="m" style="position:absolute;left:300px;top:20px;width:60px;height:60px;background:#9cf">M</div>
<div id="zone" style="position:absolute;left:300px;top:200px;width:100px;height:100px;background:#fc9">Z</div>
<p id="out"></p><button id="c" onclick="out.textContent=confirm('Continue?')?'accepted':'dismissed'">Confirm</button>
<script>let down=false;m.onmousedown=()=>{down=true};onmousemove=e=>{if(down){m.style.left=(e.clientX-30)+'px';m.style.top=(e.clientY-30)+'px'}};
onmouseup=e=>{if(!down)return;down=false;const r=zone.getBoundingClientRect();if(e.clientX>r.left&&e.clientX<r.right&&e.clientY>r.top&&e.clientY<r.bottom)out.textContent='mouse:dropped'}</script>`;

test("drag drops HTML5 and mouse-driven drags, and a dialog without an id answers the one open dialog", async () => {
  const browser = discoverBrowserExecutable({ family: "chrome", env: process.env });
  if (!browser) { test.skip("Chrome is unavailable"); return; }
  const root = temporaryRoot("drag-dialog");
  const fixture = http.createServer((_request, response) => { response.setHeader("content-type", "text/html; charset=utf-8"); response.end(page); });
  await new Promise((resolve, reject) => { fixture.once("error", reject); fixture.listen(0, "127.0.0.1", resolve); });
  let executor;
  try {
    const store = openProfileStore(`${root.root}/identities`);
    const identity = createNewtonIdentity(store, { browserFamily: "chrome" });
    const connection = await ownedEngineConnection({ executablePath: browser.path, browserFamily: "chrome", profileStore: store, identityId: identity.id, ephemeralIdentity: true });
    executor = new PageExecutor(connection);
    await executor.start(`http://127.0.0.1:${fixture.address().port}/`);
    const engine = new SessionEngine("drag-dialog", executor);
    let commandId = 0;
    const act = action => engine.submit({ commandId: ++commandId, action, timeoutMs: 10000, maxBytes: 16384 });
    const selector = value => ({ kind: "selector", selector: value });

    const html5 = await act({ kind: "drag", target: selector("#a"), to: selector("#b"), waitFor: { text: "html5:a", timeoutMs: 3000 } });
    assert.equal(html5.reason, "completed", JSON.stringify(html5).slice(0, 400));
    assert.deepEqual(html5.postcondition, { state: "met", kind: "condition", condition: "text" });
    const mouse = await act({ kind: "drag", target: selector("#m"), to: selector("#zone"), waitFor: { text: "mouse:dropped", timeoutMs: 3000 } });
    assert.equal(mouse.reason, "completed", JSON.stringify(mouse).slice(0, 400));

    // With no dialog open there is nothing to answer.
    assert.equal((await act({ kind: "dialog_dismiss" })).errorCode, "stale_target");
    await act({ kind: "click", target: selector("#c") });
    const dismissed = await act({ kind: "dialog_dismiss" });
    assert.equal(dismissed.reason, "completed", JSON.stringify(dismissed).slice(0, 400));
    assert.equal((await act({ kind: "wait_for", text: "dismissed", timeoutMs: 3000 })).reason, "completed");
  } finally {
    await executor?.close();
    fixture.close();
    root.remove();
  }
});
