import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { temporaryRoot } from "../../scripts/prototypes/support.mjs";
import { createBrowserEngine } from "../../apps/mcp-server/src/embedding.ts";

// Design-system buttons are custom elements whose label is slotted through nested shadow roots: the light-DOM text
// belongs to the outer host, so a hit test at the label reports the host, an ancestor of the inner button that takes
// the click. That hit is the target, not a cover. A real overlay is still a cover. A centred flex button in an inline
// host: Chrome's shadow-root elementsFromPoint lists that host above the label text the button draws.
const PAGE = `<!doctype html><title>clicks:</title><style>
x-button,x-next{display:inline-block;margin:8px}#cover{position:absolute;left:0;top:0;width:100%;height:60px;background:#fff8}
#covered-row{position:relative;height:60px}</style>
<x-button id="save">Save draft</x-button>
<x-button id="publish"><span>Publish</span></x-button>
<x-next id="next" role="button" aria-label="Next page" tabindex="0"></x-next>
<div style="display:grid"><div><x-search id="search"></x-search></div></div>
<div id="covered-row"><x-button id="covered">Covered action</x-button><div id="cover"></div></div>
<div style="height:3000px;width:2400px"></div>
<x-pager style="position:fixed;left:0;right:0;bottom:48px;display:block;background:#eee"></x-pager>
<script>
const log=id=>{document.title+=' '+id;};
customElements.define('x-inner-button',class extends HTMLElement{constructor(){super();
  this.attachShadow({mode:'open'}).innerHTML='<button style="font:16px sans-serif;padding:6px 12px"><slot></slot></button>';}});
customElements.define('x-button',class extends HTMLElement{constructor(){super();
  const shadow=this.attachShadow({mode:'open'});shadow.innerHTML='<x-inner-button><slot></slot></x-inner-button>';
  shadow.querySelector('x-inner-button').shadowRoot.querySelector('button').addEventListener('click',()=>log(this.id));}});
customElements.define('x-pager',class extends HTMLElement{constructor(){super();const shadow=this.attachShadow({mode:'open'});
  shadow.innerHTML='<nav><button aria-label="Older results">&lsaquo;</button><button aria-label="Newer results">&rsaquo;</button></nav>';
  shadow.querySelectorAll('button').forEach(button=>button.addEventListener('click',()=>log(button.getAttribute('aria-label').split(' ')[0].toLowerCase())));}});
customElements.define('x-search',class extends HTMLElement{constructor(){super();const shadow=this.attachShadow({mode:'open'});
  shadow.innerHTML='<style>button{display:flex;align-items:center;gap:.25em;margin:0 auto;padding:.8em 1em;font:20px sans-serif;border:2px solid;border-radius:99px;background:none}button:before{content:"";width:1em;height:1em;background:currentcolor}</style><button>\\n  <!--part-->Search<!--/part-->\\n</button>';
  shadow.querySelector('button').addEventListener('click',()=>log(this.id));}});
customElements.define('x-next',class extends HTMLElement{constructor(){super();
  const shadow=this.attachShadow({mode:'open'});shadow.append(document.createTextNode('Next ›'));
  this.style.cssText='font:16px sans-serif;padding:6px 12px;border:1px solid';this.addEventListener('click',()=>log(this.id));}});
</script>`;

test("clicks on custom-element buttons with slotted labels land and a real overlay is still reported", async (t) => {
  const temp = temporaryRoot("web-component-targets");
  const server = http.createServer((_req, res) => { res.setHeader("content-type", "text/html; charset=utf-8"); res.end(PAGE); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const engine = createBrowserEngine({ configDirectory: temp.root });
  const text = (result) => JSON.parse(result.content.at(-1).text);
  try {
    const started = text(await engine.call("browser.session.start", { url: `http://127.0.0.1:${server.address().port}/` }));
    if (started.errorCode) { t.skip(`browser unavailable: ${started.errorCode}`); return; }
    const { sessionId } = started;
    let next = started.nextCommandId;
    const click = async (name) => {
      const receipt = text(await engine.call("browser.act", { sessionId, command: { commandId: next, action: { kind: "click", target: { kind: "semantic", role: "button", name, exact: true } } } }));
      next = receipt.nextCommandId;
      return receipt;
    };
    const outcomes = {};
    for (const name of ["Save draft", "Publish", "Next page", "Search", "Covered action"]) {
      const receipt = await click(name);
      outcomes[name] = receipt.errorCode ?? receipt.reason;
      if (receipt.errorCode === "target_covered") outcomes[`${name} coveredBy`] = receipt.steps.at(-1).coveredBy;
    }
    // A fixed pagination bar on a page scrolled down and sideways: Chrome's own hit test at document coordinates lands
    // beside a fixed element there. (It sits off the bottom edge, where a just-shown overlay scrollbar would take the hit.)
    const scrolled = text(await engine.call("browser.act", { sessionId, command: { commandId: next, action: { kind: "scroll", x: 300, y: 1200 } } }));
    next = scrolled.nextCommandId;
    for (const name of ["Older results", "Newer results"]) { const receipt = await click(name); outcomes[name] = receipt.errorCode ?? receipt.reason; }
    const title = text(await engine.call("browser.observe", { sessionId, maxBytes: 2048 })).observation.title;
    assert.deepEqual({ ...outcomes, title }, {
      "Save draft": "completed", Publish: "completed", "Next page": "completed", Search: "completed",
      "Covered action": "target_covered", "Covered action coveredBy": outcomes["Covered action coveredBy"],
      "Older results": "completed", "Newer results": "completed",
      title: "clicks: save publish next search older newer",
    });
    assert.match(String(outcomes["Covered action coveredBy"]), /cover/u, "the overlay is named");
  } finally {
    await engine.close();
    server.close();
    temp.remove();
  }
});
