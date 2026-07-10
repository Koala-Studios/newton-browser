import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { startFixtureServers } from "./server.mjs";

test("fixture app contains every required release interaction class", async () => {
  const html = fs.readFileSync(path.join("test", "fixtures", "app", "index.html"), "utf8");
  const script = fs.readFileSync(path.join("test", "fixtures", "app", "fixture.js"), "utf8");
  for (const marker of [
    "textarea", "select", "checkbox", "contenteditable", 'role="combobox"', "fixture-shadow", "Same origin frame",
    "Cross origin frame", 'type="password"', "one-time-code", "cc-number", 'type="file"', "hidden-asset",
    "lazy-region", "origin-transition", "publish-form",
  ]) assert.match(html, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), marker);
  for (const marker of ["IntersectionObserver", "alert(", "window.open", 'method: "POST"', "accepted-files", "innerHTML"]) assert.ok(script.includes(marker), marker);

  const servers = await startFixtureServers({ port: 19231, crossOriginPort: 19232 });
  try {
    assert.equal((await fetch(servers.origin)).status, 200);
    assert.match(await (await fetch(`${servers.origin}/frame.html`)).text(), /Same-origin frame button/);
    assert.match(await (await fetch(`${servers.crossOrigin}/cross-origin.html`)).text(), /Cross-origin denied target/);
    assert.equal((await fetch(`${servers.origin}/write`, { method: "POST" })).status, 204);
    assert.match((await fetch(`${servers.origin}/download`)).headers.get("content-disposition") ?? "", /attachment/);
  } finally {
    await servers.close();
  }
});
