import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import test from "node:test";

import { temporaryRoot } from "../../scripts/prototypes/support.mjs";
import { discoverBrowserExecutable } from "../../apps/mcp-server/src/browser-runtime/browser-discovery.ts";
import { createNewtonIdentity, openProfileStore } from "../../apps/mcp-server/src/browser-runtime/profile-store.ts";
import { ownedEngineConnection } from "../../apps/mcp-server/src/browser-runtime/engine-host.ts";
import { PageExecutor } from "../../packages/driver/src/page-executor.ts";
import { SessionEngine } from "../../packages/driver/src/session-engine.ts";

// A media library's Upload button makes its file input only when clicked and opens the browser's file chooser,
// so set_files found no input to fill and images could not be uploaded at all.
const PAGE = `<!doctype html><meta charset="utf-8"><title>Library</title>
<script>
function pick(multiple) {
  const input = document.createElement("input"); input.type = "file"; input.accept = "image/*"; input.multiple = multiple;
  input.onchange = () => { document.title = "got " + [...input.files].map(file => file.name).join(", "); };
  input.click();
}
</script>
<button onclick="pick(false)">Upload media</button>
<button onclick="pick(true)">Upload several</button>
<button onclick="document.title='clicked nothing'">Not an upload</button>
<div id="effect">Drop files here</div>`;

test("set_files on an upload button that opens a file chooser fills the chooser's input", async () => {
  const browser = discoverBrowserExecutable({ family: "chrome", env: process.env });
  if (!browser) { test.skip("Chrome is unavailable"); return; }
  const root = temporaryRoot("file-chooser-upload");
  const store = openProfileStore(`${root.root}/identities`);
  const identity = createNewtonIdentity(store, { browserFamily: "chrome" });
  const one = `${root.root}/photo one.png`, two = `${root.root}/photo two.png`;
  for (const file of [one, two]) fs.writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const fixture = http.createServer((_request, response) => { response.setHeader("content-type", "text/html; charset=utf-8"); response.end(PAGE); });
  await new Promise(resolve => fixture.listen(0, "127.0.0.1", resolve));
  const owned = await ownedEngineConnection({ executablePath: browser.path, browserFamily: "chrome", profileStore: store, identityId: identity.id, ephemeralIdentity: true });
  const executor = new PageExecutor(owned);
  try {
    await executor.start(`http://127.0.0.1:${fixture.address().port}/`, { timeoutMs: 15_000 });
    const engine = new SessionEngine("file-chooser-upload", executor);
    let commandId = 0;
    const setFiles = (target, files) => engine.submit({ commandId: ++commandId, action: { kind: "set_files", target, files }, timeoutMs: 10_000, maxBytes: 16384, observe: "none" });
    const button = (name) => ({ kind: "semantic", role: "button", name });
    const title = async () => (await executor.send(executor.directory.binding(executor.bindPage(), 1), "Runtime.evaluate", { expression: "document.title", returnByValue: true })).result.value;
    const settled = async (expected) => { for (const deadline = Date.now() + 2000; Date.now() < deadline && await title() !== expected;) await new Promise(resolve => setTimeout(resolve, 50)); return title(); };

    const single = await setFiles(button("Upload media"), [one]);
    assert.deepEqual(single.postcondition, { state: "met", kind: "files" }, JSON.stringify(single));
    assert.equal(await settled("got photo one.png"), "got photo one.png", "the page's own change handler receives the file");
    const several = await setFiles(button("Upload several"), [one, two]);
    assert.deepEqual(several.postcondition, { state: "met", kind: "files" }, JSON.stringify(several));
    assert.equal(await settled("got photo one.png, photo two.png"), "got photo one.png, photo two.png");

    const tooMany = await setFiles(button("Upload media"), [one, two]);
    assert.equal(tooMany.errorCode, "target_not_editable", JSON.stringify(tooMany));
    assert.match(tooMany.detail, /takes one file/u);
    const nothing = await setFiles(button("Not an upload"), [one]);
    assert.equal(nothing.errorCode, "target_not_editable", JSON.stringify(nothing));
    assert.match(nothing.detail, /opened no file chooser/u);
    // An element nobody would click to upload is still refused without being clicked.
    const plain = await setFiles({ kind: "selector", selector: "#effect" }, [one]);
    assert.equal(plain.errorCode, "target_not_editable");
    assert.equal(plain.dispatch, "not_started");
  } finally { await executor.close(); fixture.close(); root.remove(); }
});
