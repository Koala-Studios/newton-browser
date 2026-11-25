import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { temporaryRoot } from "../../scripts/prototypes/support.mjs";
import { discoverBrowserExecutable } from "../../apps/mcp-server/src/browser-runtime/browser-discovery.ts";
import { createNewtonIdentity, openProfileStore } from "../../apps/mcp-server/src/browser-runtime/profile-store.ts";
import { ownedEngineConnection } from "../../apps/mcp-server/src/browser-runtime/engine-host.ts";
import { PageExecutor } from "../../packages/driver/src/page-executor.ts";
import { SessionEngine } from "../../packages/driver/src/session-engine.ts";

// An email builder full of product photos: a lossless capture of a 1728x878 viewport is larger than the 4 MiB a
// reply may carry (noise 40) or than the default maxBytes once masked and re-encoded (noise 10), so every screenshot
// was refused output_budget or evidence_unavailable. Seeded noise stands in for the photos.
const PAGE = (noise, password) => `<!doctype html><meta charset="utf-8"><title>Builder</title><body style="margin:0">
<canvas id="c" style="display:block" onclick="document.title='clicked '+event.offsetX+','+event.offsetY"></canvas>
${password ? '<input type="password" style="position:absolute;left:20px;top:20px">' : ""}
<script>
const c=document.getElementById('c');c.width=innerWidth;c.height=innerHeight;const x=c.getContext('2d');const d=x.createImageData(c.width,c.height);
let s=1;const r=()=>(s=(s*16807)%2147483647)/2147483647;
for(let i=0;i<d.data.length;i+=4){const p=i/4,X=p%c.width,Y=(p/c.width)|0;d.data[i]=(X/7+r()*${noise})&255;d.data[i+1]=(Y/5+r()*${noise})&255;d.data[i+2]=((X+Y)/9+r()*${noise})&255;d.data[i+3]=255}
x.putImageData(d,0,0);
function repaint(){x.fillStyle='#f00';x.fillRect(80,80,40,40);}
</script>`;

test("a photo-heavy viewport is captured as a JPEG whose points click_at still checks", async () => {
  const browser = discoverBrowserExecutable({ family: "chrome", env: process.env });
  if (!browser) { test.skip("Chrome is unavailable"); return; }
  const root = temporaryRoot("photo-capture-budget");
  const store = openProfileStore(`${root.root}/identities`);
  const identity = createNewtonIdentity(store, { browserFamily: "chrome" });
  const fixture = http.createServer((request, response) => {
    const url = new URL(request.url, "http://fixture");
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(PAGE(Number(url.searchParams.get("noise") ?? 0), url.searchParams.has("password")));
  });
  await new Promise(resolve => fixture.listen(0, "127.0.0.1", resolve));
  const owned = await ownedEngineConnection({ executablePath: browser.path, browserFamily: "chrome", profileStore: store, identityId: identity.id, ephemeralIdentity: true });
  const executor = new PageExecutor(owned);
  try {
    const origin = `http://127.0.0.1:${fixture.address().port}`;
    await executor.start(`${origin}/?noise=0`, { timeoutMs: 15_000 });
    const engine = new SessionEngine("photo-capture-budget", executor);
    let commandId = 0;
    const act = (action) => engine.submit({ commandId: ++commandId, action, timeoutMs: 20_000, maxBytes: 16384, observe: "none" });
    assert.equal((await act({ kind: "resize", width: 1728, height: 878 })).reason, "completed");
    const evaluate = async (expression) => (await executor.send(executor.directory.binding(executor.bindPage(), 1), "Runtime.evaluate", { expression, returnByValue: true })).result.value;
    const open = async (query) => {
      assert.equal((await act({ kind: "navigate", url: `${origin}/?${query}` })).reason, "completed");
      for (const deadline = Date.now() + 5000; Date.now() < deadline && await evaluate("document.readyState") !== "complete";) await new Promise(resolve => setTimeout(resolve, 50));
    };

    const plain = await engine.screenshot({});
    assert.equal(plain.state, "available", JSON.stringify(plain).slice(0, 300));
    assert.equal(plain.mimeType, "image/png", "a page that fits stays a lossless PNG");

    for (const noise of [10, 40]) {
      await open(`noise=${noise}`);
      const shot = await engine.screenshot({});
      assert.equal(shot.state, "available", `noise ${noise}: ${JSON.stringify(shot).slice(0, 300)}`);
      assert.equal(shot.mimeType, "image/jpeg");
      assert.equal(shot.provenance.maskDisposition, "mask_not_applicable");
      assert.ok(Buffer.from(shot.imageData, "base64").subarray(0, 2).equals(Buffer.from([0xff, 0xd8])), "the data is a JPEG");
      const captureId = shot.provenance.captureId;
      const clicked = await act({ kind: "click_at", captureId, x: 300, y: 200 });
      assert.equal(clicked.reason, "completed", JSON.stringify(clicked));
      assert.equal(await evaluate("document.title"), "clicked 300,200");
      await evaluate("repaint()");
      const changed = await act({ kind: "click_at", captureId, x: 100, y: 100 });
      assert.equal(changed.errorCode, "stale_target", `the point's surroundings changed: ${JSON.stringify(changed)}`);
    }

    // A password field in view must be masked, which a JPEG cannot be here: refused, saying why.
    await open("noise=40&password");
    const sensitive = await engine.screenshot({});
    assert.equal(sensitive.state, "unavailable");
    assert.equal(sensitive.errorCode, "output_budget");
    assert.match(sensitive.detail ?? "", /password or payment field is in view/u);
  } finally { await executor.close(); fixture.close(); root.remove(); }
});
