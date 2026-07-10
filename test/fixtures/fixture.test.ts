import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { startFixtureServers } from "./server.mjs";

test("fixture app contains every required release interaction class", async () => {
  const html = fs.readFileSync(path.join("test", "fixtures", "app", "index.html"), "utf8");
  const script = fs.readFileSync(path.join("test", "fixtures", "app", "fixture.js"), "utf8");
  for (const marker of [
    "textarea", "select", "checkbox", "radio", 'type="date"', "placeholder", "aria-label", "contenteditable", 'role="combobox"', 'role="listbox"', "fixture-shadow", "fixture-nested-shadow", "Same origin frame",
    "Cross origin frame", 'type="password"', "one-time-code", "cc-number", "SSN", "IBAN", "sensitive-key-log", 'type="file"', "hidden-asset", "ambiguous-asset-a", "ambiguous-asset-b",
    "lazy-region", "origin-transition", "disallowed-transition", "publish-form", "Place order", "Delete record", "Like fixture", "Subscribe fixture", "Auth persistence", "Moving target",
  ]) assert.match(html, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), marker);
  for (const marker of ["IntersectionObserver", "alert(", "confirm(", "prompt(", "window.open", 'method: "POST"', "accepted-files", "sensitive-key-log", "bb_auth_fixture", "innerHTML"]) assert.ok(script.includes(marker), marker);

  const servers = await startFixtureServers({ port: 19231, crossOriginPort: 19232 });
  try {
    assert.equal((await fetch(servers.origin)).status, 200);
    assert.match(await (await fetch(`${servers.origin}/frame.html`)).text(), /Same-origin frame button/);
    assert.match(await (await fetch(`${servers.crossOrigin}/cross-origin.html`)).text(), /Cross-origin denied target/);
    assert.equal((await fetch(`${servers.origin}/write`, { method: "POST" })).status, 204);
    assert.match((await fetch(`${servers.origin}/download`)).headers.get("content-disposition") ?? "", /attachment/);
    const redirected = await fetch(`${servers.origin}/redirect-cross`, { redirect: "manual" });
    assert.equal(redirected.status, 302);
    assert.equal(redirected.headers.get("location"), `${servers.crossOrigin}/cross-origin.html`);
  } finally {
    await servers.close();
  }
});
