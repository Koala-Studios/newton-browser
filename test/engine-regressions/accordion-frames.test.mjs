import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { temporaryRoot } from "../../scripts/prototypes/support.mjs";
import { createBrowserEngine } from "../../apps/mcp-server/src/embedding.ts";

// A storefront FAQ: collapsed answer panels, several embedded frames, and a cross-site tracking sandbox frame styled
// 0x0 and visibility hidden (it keeps its default 2 px border). A heading click must reach dispatch, a collapsed
// panel reads as hidden rather than as an exhausted budget, and the expanded panel reads its text.
const PAGE = (port) => `<!doctype html><title>FAQ</title><style>.panel[hidden]{display:none}</style>
<div style="position:fixed;left:0;top:0;width:0;height:0;overflow:hidden;visibility:hidden"><iframe tabindex="-1" aria-hidden="true" sandbox="allow-scripts" src="http://localhost:${port}/pixel" style="height:0!important;width:0!important;visibility:hidden!important"></iframe></div>
<iframe title="Reviews" src="http://localhost:${port}/widget" style="width:200px;height:60px"></iframe>
<iframe title="Chat" src="http://localhost:${port}/widget" style="width:200px;height:60px"></iframe>
<main><h2>Questions</h2>
<h3 id="guarantee" onclick="document.getElementById('answer').hidden=!document.getElementById('answer').hidden">Is there a money-back guarantee?</h3>
<div id="answer" class="panel" hidden><p>Yes, every first order is covered for thirty days.</p></div>
<h3>How long is shipping?</h3><div class="panel" hidden><p>Three to five days.</p></div></main>`;

test("a FAQ heading click reaches dispatch past a 0x0 sandbox frame; a collapsed panel reads as hidden", async (t) => {
  const temp = temporaryRoot("accordion-frames");
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(req.url === "/pixel" ? "<!doctype html><script>setInterval(()=>{},50)</script>" : req.url === "/widget" ? "<!doctype html><p>widget</p>" : PAGE(server.address().port));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const engine = createBrowserEngine({ configDirectory: temp.root });
  const text = (result) => JSON.parse(result.content.at(-1).text);
  try {
    const started = text(await engine.call("browser.session.start", { url: `http://127.0.0.1:${server.address().port}/` }));
    if (started.errorCode) { t.skip(`browser unavailable: ${started.errorCode}`); return; }
    const { sessionId } = started;
    const panel = { kind: "selector", selector: "#answer" };
    const collapsed = text(await engine.call("browser.document.read", { sessionId, scope: panel })).observation;
    assert.equal(collapsed.state, "available", JSON.stringify(collapsed));
    assert.equal(collapsed.text, "");
    assert.equal(collapsed.scopeHidden, true, "a collapsed panel says it is hidden");
    const click = text(await engine.call("browser.act", { sessionId, command: { commandId: started.nextCommandId,
      action: { kind: "click", target: { kind: "semantic", role: "heading", name: "Is there a money-back guarantee?" } } } }));
    assert.equal(click.dispatch, "acknowledged", JSON.stringify(click));
    const notCss = text(await engine.call("browser.act", { sessionId, command: { commandId: click.nextCommandId,
      action: { kind: "click", target: { kind: "selector", selector: 'h3:has-text("Shipping")' } } } }));
    assert.equal(notCss.errorCode, "invalid_arguments", JSON.stringify(notCss));
    assert.match(notCss.detail, /not valid CSS/);
    const expanded = text(await engine.call("browser.document.read", { sessionId, scope: panel })).observation;
    assert.equal(expanded.state, "available", JSON.stringify(expanded));
    assert.match(expanded.text, /every first order is covered/);
    assert.equal(expanded.scopeHidden, undefined);
  } finally {
    await engine.close();
    server.close();
    temp.remove();
  }
});
