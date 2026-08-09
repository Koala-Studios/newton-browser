import assert from "node:assert/strict";
import test from "node:test";

import { startFixtureServers } from "./fixtures/server.mjs";

test("frame fixture preserves baseline controls and adds deterministic target churn", async (context) => {
  const fixture = await startFixtureServers({ port: 0, crossOriginPort: 0, thirdOriginPort: 0 });
  context.after(() => fixture.close());

  assert.match(fixture.thirdOrigin, /^http:\/\/127\.0\.0\.1:\d+$/);
  const index = await fetch(`${fixture.origin}/index.html`).then((response) => response.text());
  for (const marker of [
    'id="same-frame"',
    'id="cross-frame"',
    'id="oopif-churn-frame"',
    'id="replace-oopif"',
    'id="detach-oopif"',
    "Same origin frame",
  ]) assert.equal(index.includes(marker), true, `missing index marker ${marker}`);

  for (const origin of [fixture.origin, fixture.crossOrigin, fixture.thirdOrigin]) {
    const response = await fetch(`${origin}/frame.html?label=Fixture-${encodeURIComponent(origin)}`);
    assert.equal(response.status, 200);
    const html = await response.text();
    for (const marker of [
      'id="frame-button"',
      'id="frame-stale-target"',
      'id="rerender-frame-target"',
      'id="navigate-frame-document"',
      'id="nested-frame-slot"',
    ]) assert.equal(html.includes(marker), true, `missing frame marker ${marker}`);
  }
});

test("optional third origin does not change the existing two-origin fixture contract", async (context) => {
  const fixture = await startFixtureServers({ port: 0, crossOriginPort: 0 });
  context.after(() => fixture.close());
  assert.equal(Object.hasOwn(fixture, "thirdOrigin"), false);
  assert.match(fixture.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.match(fixture.crossOrigin, /^http:\/\/127\.0\.0\.1:\d+$/);
});
