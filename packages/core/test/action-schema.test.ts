import test from "node:test";
import assert from "node:assert/strict";

import {
  BROWSER_ACTION_FIELDS,
  BROWSER_ACTION_FIELD_SPECS,
  BROWSER_ACTION_JSON_SCHEMA,
  IDEMPOTENCY_KEY_MAXIMUM_LENGTH,
  IDEMPOTENCY_KEY_MINIMUM_LENGTH,
  normalizeIdempotencyKey,
  validateIdempotencyKey,
  parseBrowserAction,
  redactBrowserAction,
} from "../src/index.ts";

test("action schema fields survive parse and redact", () => {
  const parsed = parseBrowserAction({
    kind: "screenshot",
    sensitiveZones: [{ selector: "[data-private]" }],
    fullPage: true,
    device: "mobile",
    waitMs: 10_000,
    inline: true,
    clip: { x: 1.2, y: 2.6, width: 300.2, height: 200.8 },
    format: "jpeg",
    quality: 70,
  });
  const redacted = redactBrowserAction(parsed);

  assert.deepEqual([...BROWSER_ACTION_FIELDS].sort(), Object.keys(BROWSER_ACTION_FIELD_SPECS).sort());
  assert.equal(redacted.fullPage, true);
  assert.equal(redacted.device, "mobile");
  assert.equal(redacted.waitMs, 10_000);
  assert.deepEqual(parsed.clip, { x: 1, y: 3, width: 300, height: 201 });
  assert.deepEqual(parseBrowserAction({ kind: "screenshot", sensitiveZones: [{ ref: "d1:e1" }] }).sensitiveZones, [{ ref: "d1:e1" }]);
  assert.throws(() => parseBrowserAction({ kind: "screenshot", unknown: true }), /unsupported field/);
  assert.throws(() => parseBrowserAction({ kind: "screenshot", sensitiveZones: [{ selector: "#private", label: "private" }] }), /exactly one/u);
});

test("only action value is replaced as the secret field", () => {
  const redacted = redactBrowserAction(parseBrowserAction({
    kind: "fill",
    target: { role: "textbox", name: "Display name" },
    value: "raw private value",
  }));

  assert.equal(redacted.value, "[REDACTED]");
  assert.deepEqual(redacted.target, { role: "textbox", name: "Display name" });
});

test("internal frame routing diagnostic is not accepted by the public action parser", () => {
  assert.throws(() => parseBrowserAction({ kind: "observe", includeFrameRouting: true }), /unsupported field/);
});

test("click can atomically wait for its bounded causal effect", () => {
  const action = parseBrowserAction({
    kind: "click",
    role: "button",
    name: "Launch worker",
    waitFor: { text: "worker-blocked", timeoutMs: 4_000 },
    timeoutMs: 5_000,
  });

  assert.deepEqual(action, {
    kind: "click",
    role: "button",
    name: "Launch worker",
    waitFor: { text: "worker-blocked", timeoutMs: 4_000 },
    timeoutMs: 5_000,
  });
  assert.deepEqual(redactBrowserAction(action), action);
  assert.equal(BROWSER_ACTION_JSON_SCHEMA["x-newtonVariants"].click.includes("waitFor"), true);
  assert.equal(BROWSER_ACTION_JSON_SCHEMA["x-newtonVariants"].click.includes("timeoutMs"), true);
  assert.throws(
    () => parseBrowserAction({ kind: "click", name: "Launch worker", waitFor: { text: "done", timeoutMs: 99 } }),
    /timeoutMs is outside bounds/,
  );
  assert.throws(
    () => parseBrowserAction({ kind: "click", name: "Launch worker", timeoutMs: 120_001 }),
    /outside bounds/,
  );
});

test("idempotency keys are validated with a bounded URL-safe format", () => {
  assert.equal(normalizeIdempotencyKey("   abc_1234   "), "abc_1234");
  assert.equal(normalizeIdempotencyKey("abc_1234"), "abc_1234");
  assert.equal(normalizeIdempotencyKey("abc-1234"), "abc-1234");
  assert.equal(normalizeIdempotencyKey(`${"a".repeat(IDEMPOTENCY_KEY_MINIMUM_LENGTH - 1)}`), undefined);
  assert.equal(normalizeIdempotencyKey(`${"a".repeat(IDEMPOTENCY_KEY_MINIMUM_LENGTH)}`), "a".repeat(IDEMPOTENCY_KEY_MINIMUM_LENGTH));
  assert.equal(normalizeIdempotencyKey(`${"a".repeat(IDEMPOTENCY_KEY_MAXIMUM_LENGTH)}`), "a".repeat(IDEMPOTENCY_KEY_MAXIMUM_LENGTH));
  assert.equal(normalizeIdempotencyKey(`${"a".repeat(IDEMPOTENCY_KEY_MAXIMUM_LENGTH + 1)}`), undefined);
  assert.equal(normalizeIdempotencyKey("has space"), undefined);
  assert.equal(normalizeIdempotencyKey({ foo: "bar" }), undefined);
  assert.equal(normalizeIdempotencyKey(undefined), undefined);
});

test("invalid idempotency keys are rejected and valid keys are preserved", () => {
  assert.throws(() => {
    validateIdempotencyKey({});
  }, /idempotencyKey must be 8-128 URL-safe characters/);
  assert.equal(validateIdempotencyKey(`${"x".repeat(IDEMPOTENCY_KEY_MINIMUM_LENGTH)}`), "x".repeat(IDEMPOTENCY_KEY_MINIMUM_LENGTH));
  assert.throws(() => {
    validateIdempotencyKey(`${"x".repeat(IDEMPOTENCY_KEY_MAXIMUM_LENGTH + 1)}`);
  }, /idempotencyKey must be 8-128 URL-safe characters/);
});
