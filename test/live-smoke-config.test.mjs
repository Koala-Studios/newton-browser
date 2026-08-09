import assert from "node:assert/strict";
import test from "node:test";

import { resolveLiveBrowserTarget, resolveLiveHostPort } from "../scripts/smoke/live-config.mjs";

test("live smoke target defaults to Chrome and accepts one explicit family", () => {
  assert.equal(resolveLiveBrowserTarget({}), "chrome");
  assert.equal(resolveLiveBrowserTarget({ NEWTON_BROWSER_QA_OWNER: "edge" }), "edge");
  assert.equal(resolveLiveBrowserTarget({ NEWTON_BROWSER_BROWSER: "edge" }), "edge");
  assert.equal(resolveLiveBrowserTarget({ NEWTON_BROWSER_QA_OWNER: "chrome", NEWTON_BROWSER_BROWSER: "edge" }), "chrome");
  assert.throws(() => resolveLiveBrowserTarget({ NEWTON_BROWSER_QA_OWNER: "auto" }), /chrome or edge/);
});

test("live smoke host scans the bounded range unless an exact port is requested", () => {
  assert.equal(resolveLiveHostPort({}), undefined);
  assert.equal(resolveLiveHostPort({ NEWTON_BROWSER_PORT: "" }), undefined);
  assert.equal(resolveLiveHostPort({ NEWTON_BROWSER_PORT: "17321" }), 17_321);
  assert.equal(resolveLiveHostPort({ NEWTON_BROWSER_PORT: "17340" }), 17_340);
  assert.throws(() => resolveLiveHostPort({ NEWTON_BROWSER_PORT: "17320" }), /17321 through 17340/);
  assert.throws(() => resolveLiveHostPort({ NEWTON_BROWSER_PORT: "not-a-port" }), /17321 through 17340/);
});
