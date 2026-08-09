import assert from "node:assert/strict";
import test from "node:test";
import {
  compileOriginGrant,
  decidePausedRequest,
  decidePausedTarget,
  normalizeGrantOrigin,
  originForUrl,
} from "../src/origin-containment.js";

test("origin grants accept only bounded exact canonical HTTP(S) origins", () => {
  assert.equal(normalizeGrantOrigin("https://example.com"), "https://example.com");
  assert.equal(normalizeGrantOrigin("https://example.com/"), "https://example.com");
  assert.equal(normalizeGrantOrigin("https://example.com:443"), "https://example.com");
  for (const value of [
    "https://example.com/path", "https://example.com?x=1", "https://user@example.com",
    "https://*.example.com", "file:///tmp/a", "data:text/plain,x", "https://example.com#x",
  ]) assert.throws(() => normalizeGrantOrigin(value), (error) => error?.code === "invalid_origin_grant");
  assert.throws(() => compileOriginGrant("https://example.com", Array.from({ length: 32 }, (_, index) => `https://x${index}.test`)), (error) => error?.code === "origin_grant_too_large");
});

test("compiled grants use exact URL origins without prefix or credential tricks", () => {
  const grant = compileOriginGrant("https://example.com", ["https://api.example.com:8443"]);
  assert.deepEqual(grant.origins, ["https://example.com", "https://api.example.com:8443"]);
  assert.equal(grant.contains("https://example.com/path"), true);
  assert.equal(grant.contains("https://api.example.com:8443/v1"), true);
  assert.equal(grant.contains("https://example.com.evil.test/"), false);
  assert.equal(grant.contains("https://example.com@evil.test/"), false);
  assert.equal(grant.contains("blob:https://example.com/id"), true);
  assert.equal(originForUrl("wss://example.com/socket"), "https://example.com");
});

test("paused-request decisions prevent ungranted effects and permit bodyless reads", () => {
  const grant = compileOriginGrant("https://example.com", ["https://allowed.test"]);
  const cases = [
    [{ request: { url: "https://allowed.test/save", method: "POST" } }, "continue", "granted_origin"],
    [{ request: { url: "https://denied.test/page", method: "GET" }, isNavigationRequest: true }, "fail", "ungranted_navigation"],
    [{ request: { url: "https://denied.test/save", method: "POST" } }, "fail", "ungranted_mutation"],
    [{ request: { url: "wss://denied.test/socket", method: "GET" }, resourceType: "WebSocket" }, "fail", "ungranted_connection"],
    [{ request: { url: "https://cdn.test/image.png", method: "GET" }, resourceType: "Image" }, "continue_without_body_access", "read_only_subresource"],
    [{ request: { url: "https://denied.test/custom", method: "PROPFIND" } }, "fail", "unsupported_ungranted_request"],
  ];
  for (const [input, action, reason] of cases) assert.deepEqual(decidePausedRequest(input, grant), { action, reason, granted: reason === "granted_origin" });
});

test("new targets remain paused until a granted origin is known", () => {
  const grant = compileOriginGrant("https://example.com");
  assert.equal(decidePausedTarget({ url: "" }, grant).action, "hold");
  assert.equal(decidePausedTarget({ url: "about:blank" }, grant).action, "hold");
  assert.equal(decidePausedTarget({ url: "https://example.com/worker.js" }, grant).action, "resume");
  assert.equal(decidePausedTarget({ url: "https://denied.test/worker.js" }, grant).action, "block");
});
