import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { temporaryRoot } from "../../scripts/prototypes/support.mjs";
import { createBrowserEngine } from "../../apps/mcp-server/src/embedding.ts";

// A storefront section with the usual responsive defects: a banner wider than the viewport, a button whose label runs
// past it, a broken image, and two text blocks that collide. A sticky header and a horizontally scrolling product
// rail (clipped by its own overflow) are expected layout and must not be reported.
const PAGE = `<!doctype html><title>layout</title><meta name="viewport" content="width=device-width">
<style>body{margin:0;font:16px sans-serif}header{position:sticky;top:0;height:40px;background:#eee}
#banner{width:1000px;height:50px;background:#c00}
#rail{overflow-x:auto;white-space:nowrap}#rail span{display:inline-block;width:400px}
#buy{width:60px;overflow:hidden;white-space:nowrap;display:block}
#hero{position:relative;height:120px}#title{position:absolute;top:10px;left:10px}#subtitle{position:absolute;top:14px;left:20px}
.cut{width:80px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}</style>
<header><a href="#">Menu link</a></header>
<div id="banner">Free shipping</div>
<div id="rail"><span>One</span><span>Two</span><span>Three</span></div>
<button id="buy">Add to cart now</button>
<div class="cut">A deliberately truncated product name</div>
<img id="broken" src="/missing.png" width="40" height="40" alt="Product">
<div id="hero"><h2 id="title">Big sale</h2><p id="subtitle">Ends tonight</p></div>
<p>Plain paragraph that fits.</p>`;

test("geometry read reports overflow, clipped text, broken images and overlaps with refs", async (t) => {
  const temp = temporaryRoot("geometry-read");
  const server = http.createServer((req, res) => {
    if (req.url !== "/") { res.statusCode = 404; res.end(); return; }
    res.setHeader("content-type", "text/html; charset=utf-8"); res.end(PAGE);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const engine = createBrowserEngine({ configDirectory: temp.root });
  const text = (result) => JSON.parse(result.content.at(-1).text);
  try {
    const started = text(await engine.call("browser.session.start", { url: `http://127.0.0.1:${server.address().port}/`, viewport: { width: 800, height: 600 } }));
    if (started.errorCode) { t.skip(`browser unavailable: ${started.errorCode}`); return; }
    const { sessionId } = started;
    const read = text(await engine.call("browser.observe", { sessionId, mode: "geometry", maxBytes: 32768 }));
    const observation = read.observation;
    assert.equal(observation.state, "available", JSON.stringify(observation));
    const geometry = observation.geometry;
    assert.ok(geometry.viewport.width >= 780 && geometry.viewport.width <= 800, JSON.stringify(geometry.viewport));
    assert.equal(geometry.horizontalOverflow, true);
    assert.ok(geometry.document.scrollWidth >= 1000);
    assert.deepEqual(geometry.wider.items.map((item) => item.label), ['div#banner "Free shipping"'], "only the banner; the rail clips its own items");
    assert.equal(geometry.wider.items[0].box.width, 1000);
    assert.match(geometry.wider.items[0].ref, /\S/);
    const clipped = Object.fromEntries(geometry.clippedText.items.map((item) => [item.label.split(" ")[0], item]));
    assert.ok(clipped["button#buy"], JSON.stringify(geometry.clippedText));
    assert.ok(clipped["button#buy"].scrollWidth > clipped["button#buy"].clientWidth);
    assert.equal(clipped["div.cut"]?.ellipsis, true, "deliberate truncation is marked");
    assert.equal(geometry.images.count, 1);
    assert.equal(geometry.images.notLoaded.items[0]?.label, 'img#broken "Product"');
    const pairs = geometry.overlaps.items.map((pair) => [pair.a.label, pair.b.label].sort().join(" | "));
    assert.ok(pairs.includes('h2#title "Big sale" | p#subtitle "Ends tonight"'), JSON.stringify(pairs));
    assert.ok(!pairs.some((pair) => pair.includes("Menu link")), "the sticky header is left out");
    // A returned ref is a live target: the banner can be captured or acted on directly.
    const scoped = text(await engine.call("browser.observe", { sessionId, mode: "geometry", scope: { kind: "ref", ref: geometry.wider.items[0].ref } })).observation;
    assert.equal(scoped.state, "available", JSON.stringify(scoped));
    assert.equal(scoped.geometry.scope.box.width, 1000);
    assert.equal(scoped.geometry.scope.scrollWidth, 1000);
    // After resizing wide enough, nothing extends past the edge.
    const wide = text(await engine.call("browser.act", { sessionId, command: { commandId: read.nextCommandId, action: { kind: "resize", width: 1440, height: 900 } } }));
    assert.equal(wide.postcondition.state, "met", JSON.stringify(wide));
    const after = text(await engine.call("browser.observe", { sessionId, mode: "geometry", maxBytes: 32768 })).observation.geometry;
    assert.equal(after.horizontalOverflow, false);
    assert.equal(after.wider.count, 0);
    const refused = await engine.call("browser.observe", { sessionId, mode: "geometry", query: { role: "button" } });
    assert.equal(refused.isError, true, "query does not apply to geometry");
  } finally {
    await engine.close();
    server.close();
    temp.remove();
  }
});
