import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  evaluateBrowserFloor,
  redactBrowserAction,
  redactBrowserResult,
  type BrowserHostPolicyManifest,
} from "../src/index.ts";

const allowed = { allowedOrigins: ["https://example.com"] };

test("read-only browser actions stay read-only on granted origins", () => {
  const decision = evaluateBrowserFloor({
    action: { kind: "observe" },
    origin: "https://mail.google.com",
    policy: { allowedOrigins: ["https://mail.google.com"] },
  });
  assert.equal(decision.class, "read_only");
});

test("non-committing work never prompts", () => {
  assert.equal(evaluateBrowserFloor({ action: { kind: "scroll" }, origin: "https://example.com", policy: allowed }).class, "agentic");
  assert.equal(evaluateBrowserFloor({ action: { kind: "navigate", url: "https://example.com/next" }, origin: "https://example.com", policy: allowed }).class, "agentic");
  assert.equal(evaluateBrowserFloor({ action: { kind: "fill", text: "Primary text", value: "hi" }, origin: "https://example.com", policy: allowed }).class, "agentic");
  assert.equal(evaluateBrowserFloor({ action: { kind: "click", text: "Open menu" }, origin: "https://example.com", policy: allowed }).class, "agentic");
});

test("dialog accept/dismiss are agentic and never blocked", () => {
  assert.equal(evaluateBrowserFloor({ action: { kind: "dialog_accept" }, origin: "https://example.com", policy: allowed }).class, "agentic");
  assert.equal(evaluateBrowserFloor({ action: { kind: "dialog_dismiss" }, origin: "https://example.com", policy: allowed }).class, "agentic");
});

test("credential/secret fields are blocked and never typed", () => {
  assert.equal(evaluateBrowserFloor({ action: { kind: "fill", text: "Password" }, origin: "https://example.com", policy: allowed }).class, "blocked");
  assert.equal(evaluateBrowserFloor({ action: { kind: "type", selector: "#api-key" }, origin: "https://example.com", policy: allowed }).class, "blocked");
  assert.equal(evaluateBrowserFloor({ action: { kind: "fill" }, resolved: { inputType: "password" }, origin: "https://example.com", policy: allowed }).class, "blocked");
});

test("a structurally-detected commit on an unknown host is classified as commit metadata", () => {
  // Submit-like accessible name on an unknown (no-manifest) host → conservative classification.
  const submitLike = evaluateBrowserFloor({ action: { kind: "click", text: "Publish" }, origin: "https://example.com", policy: allowed });
  assert.equal(submitLike.class, "agentic");
  assert.equal(submitLike.commitBoundary, "commit");

  // A resolved form-submit element is structurally a commit regardless of text.
  const formSubmit = evaluateBrowserFloor({ action: { kind: "click", text: "Go" }, resolved: { role: "button", formOwner: "checkout-form" }, origin: "https://example.com", policy: allowed });
  assert.equal(formSubmit.class, "agentic");

  // Spaced or styled commit labels remain detectable.
  for (const name of ["CHECK OUT", "Place Order", "Complete order", "Remove item"]) {
    const decision = evaluateBrowserFloor({ action: { kind: "click", ref: "n1" }, resolved: { role: "button", accessibleName: name }, origin: "https://shop.example", policy: { allowedOrigins: ["https://shop.example"] } });
    assert.equal(decision.class, "agentic", `${name} should be classified as commit metadata`);
  }
});

test("social engagement actions are classified as external effects", () => {
  const like = evaluateBrowserFloor({ action: { kind: "click", text: "Like" }, origin: "https://www.youtube.com", policy: { allowedOrigins: ["https://www.youtube.com"] } });
  assert.equal(like.class, "agentic");
  assert.equal(like.commitBoundary, "external_effect");
  assert.equal(like.reason, "social_engagement_action");

  const subscribe = evaluateBrowserFloor({ action: { kind: "click", selector: "button[aria-label='Subscribe']" }, origin: "https://www.youtube.com", policy: { allowedOrigins: ["https://www.youtube.com"] } });
  assert.equal(subscribe.class, "agentic");
  assert.equal(subscribe.commitBoundary, "external_effect");
});

test("misleading page text cannot authorize a write; the floor only raises risk", () => {
  // A reassuring label ("safe preview") never de-risks a host-policy external effect.
  const manifest: BrowserHostPolicyManifest = {
    origins: ["https://example.com"],
    commitRules: [{ match: { name: "publish" }, effect: "external_effect" }],
  };
  const decision = evaluateBrowserFloor({
    action: { kind: "click", text: "Publish (safe preview only)" },
    manifest,
    origin: "https://example.com",
    policy: allowed,
  });
  assert.equal(decision.class, "agentic");
  assert.equal(decision.commitBoundary, "external_effect");
});

test("a ref-targeted commit is gated once the driver supplies resolved evidence (S3/D16)", () => {
  const manifest: BrowserHostPolicyManifest = {
    origins: ["https://app.example.invalid"],
    commitRules: [{ match: { name: "publish" }, effect: "external_effect", reason: "custom_policy_publish" }],
  };
  const hostPolicy = { allowedOrigins: ["https://app.example.invalid"] };

  // Without resolved evidence a ref click is opaque → agentic (the old gap).
  const blind = evaluateBrowserFloor({ action: { kind: "click", ref: "n5" }, manifest, origin: "https://app.example.invalid", policy: hostPolicy });
  assert.equal(blind.class, "agentic");

  // With the driver's pre-dispatch resolved name, the host rule matches by ref.
  const resolved = evaluateBrowserFloor({
    action: { kind: "click", ref: "n5" },
    resolved: { role: "button", accessibleName: "Publish" },
    manifest,
    origin: "https://app.example.invalid",
    policy: hostPolicy,
  });
  assert.equal(resolved.class, "agentic");
  assert.equal(resolved.commitBoundary, "external_effect");

  // Unknown host: a ref click resolving to a submit-like name also stops.
  const unknown = evaluateBrowserFloor({
    action: { kind: "click", ref: "n9" },
    resolved: { role: "button", accessibleName: "Delete account" },
    origin: "https://app.unknown.example",
    policy: { allowedOrigins: ["https://app.unknown.example"] },
  });
  assert.equal(unknown.class, "agentic");
});

test("payment / government-id fields are blocked like credentials (S22)", () => {
  const cc = evaluateBrowserFloor({ action: { kind: "fill", label: "Credit card number", value: "4111111111111111" }, origin: "https://example.com", policy: allowed });
  assert.equal(cc.class, "blocked");
  assert.equal(cc.reason, "payment_or_pii_field");

  assert.equal(evaluateBrowserFloor({ action: { kind: "fill", label: "CVV" }, origin: "https://example.com", policy: allowed }).class, "blocked");
  assert.equal(evaluateBrowserFloor({ action: { kind: "type", placeholder: "SSN" }, origin: "https://example.com", policy: allowed }).class, "blocked");
  // Autocomplete tokens from the resolved field also block.
  assert.equal(evaluateBrowserFloor({ action: { kind: "fill", text: "card" }, resolved: { autocomplete: "cc-number" }, origin: "https://example.com", policy: allowed }).class, "blocked");
  assert.equal(evaluateBrowserFloor({ action: { kind: "fill" }, resolved: { autocomplete: "one-time-code" }, origin: "https://example.com", policy: allowed }).class, "blocked");
  // A plain draft field is still agentic.
  assert.equal(evaluateBrowserFloor({ action: { kind: "fill", label: "Primary text", value: "hi" }, origin: "https://example.com", policy: allowed }).class, "agentic");
});

test("sensitive prefilled values are withheld from observations and deltas (S18)", () => {
  const result = redactBrowserResult({
    kind: "observation",
    mode: "cdp",
    origin: "https://example.com",
    title: "Checkout",
    nodes: [
      { ref: "n1", role: "textbox", name: "Credit card number", value: "4111 1111 1111 1111" },
      { ref: "n2", role: "textbox", name: "Primary text", value: "hello world" },
      { ref: "n3", role: "textbox", name: "SSN", value: "123-45-6789" },
    ],
    nodeCount: 3,
    truncated: false,
    capturedAt: "2026-06-28T00:00:00.000Z",
    changed: { value: "4111111111111111" },
  });
  assert.equal(result.kind, "observation");
  assert.equal(result.nodes[0].value, "[REDACTED]");
  assert.equal(result.nodes[1].value, "hello world");
  assert.equal(result.nodes[2].value, "[REDACTED]");
  assert.equal(result.changed?.value, "[REDACTED]");
});

test("redaction preserves current screenshot capture options and observe mode", () => {
  const shot = redactBrowserAction({ kind: "screenshot", fullPage: true, format: "jpeg", quality: 75 });
  assert.equal(shot.fullPage, true);
  assert.equal(shot.format, "jpeg");
  assert.equal(shot.quality, 75);
  assert.throws(() => redactBrowserAction({ kind: "screenshot", quality: 101 }), /outside bounds/);
  assert.throws(() => redactBrowserAction({ kind: "screenshot", device: "watch" } as never), /unsupported field/);
  // Observe diff mode survives.
  assert.equal(redactBrowserAction({ kind: "observe", mode: "diff" }).mode, "diff");
});

test("observation deltas are redacted and carry only added/removed/updated (D6)", () => {
  const result = redactBrowserResult({
    kind: "observation_delta",
    mode: "cdp",
    origin: "https://example.com",
    title: "Checkout",
    added: [{ ref: "e9", role: "button", name: "Place order", bbox: [1, 2, 3, 4] }],
    removed: ["e1", "e2"],
    updated: [
      { ref: "e3", name: "Cart (2)" },
      { ref: "e4", name: "Card number", value: "4111 1111 1111 1111" },
      { ref: "e5", role: "checkbox", name: "Terms", checked: true, required: true, documentEpoch: 2 },
    ],
    nodeCount: 12,
    capturedAt: "2026-06-29T00:00:00.000Z",
  });
  assert.equal(result.kind, "observation_delta");
  assert.equal(result.added.length, 1);
  assert.equal(result.added[0].ref, "e9");
  assert.deepEqual(result.removed, ["e1", "e2"]);
  assert.equal(result.updated.length, 3);
  // A sensitive value in an updated field is masked like an observation value (S18).
  assert.equal(result.updated[1].value, "[REDACTED]");
  assert.equal(result.updated[2].checked, true);
  assert.equal(result.updated[2].documentEpoch, 2);
  assert.equal(result.nodeCount, 12);

});

test("screenshot bytes survive only within the bounded trusted raster contract", () => {
  const tinyPng = `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64")}`;
  // A bounded raster is carried directly in the active result.
  const captured = redactBrowserResult({
    kind: "screenshot", mode: "cdp", origin: "https://example.com", title: "Page",
    fullPage: true, dataUrl: tinyPng, maskDisposition: "mask_not_configured", capturedAt: "2026-06-29T00:00:00.000Z",
  });
  assert.equal(captured.kind, "screenshot");
  assert.equal(captured.dataUrl, tinyPng);
  assert.equal(captured.fullPage, true);
  // Oversized bytes are omitted and the result is marked truncated.
  const huge = `data:image/png;base64,${"A".repeat(23_000_001)}`;
  const overCap = redactBrowserResult({
    kind: "screenshot", mode: "cdp", origin: "https://example.com", title: "Page",
    dataUrl: huge, maskDisposition: "mask_not_configured", capturedAt: "2026-06-29T00:00:00.000Z",
  });
  assert.equal("dataUrl" in overCap, false);
  assert.equal(overCap.truncated, true);
});

test("screenshot redaction always carries an explicit mask disposition", () => {
  for (const disposition of ["mask_applied", "mask_not_configured", "mask_not_applicable"] as const) {
    const result = redactBrowserResult({
      kind: "screenshot", mode: "cdp", origin: "https://example.com", title: "Page",
      maskDisposition: disposition, capturedAt: "2026-08-09T00:00:00.000Z",
    });
    assert.equal(result.kind, "screenshot");
    assert.equal(result.maskDisposition, disposition);
  }
  const invalid = redactBrowserResult({ kind: "screenshot", mode: "cdp", origin: "https://example.com", title: "Page", capturedAt: "2026-08-09T00:00:00.000Z" });
  assert.equal(invalid, null);
});

test("opaque network fixture bodies are omitted at the host redaction boundary", () => {
  const fixture = JSON.parse(fs.readFileSync(path.join(process.cwd(), "test", "fixtures", "privacy", "opaque-network-bodies.json"), "utf8"));
  for (const body of fixture.cases) {
    const result = redactBrowserResult({
      kind: "network_log", origin: "https://example.com", entries: [], count: 0, dropped: 0,
      capturedAt: "2026-08-09T00:00:00.000Z", body: { requestId: body.id, url: "https://example.com/api", ...body },
    });
    assert.equal(result.kind, "network_log");
    assert.equal(result.body, null, body.id);
    assert.equal(result.bodyDisposition, "opaque_body_not_returned", body.id);
    assert.equal(JSON.stringify(result).includes(String(body.data)), false, body.id);
  }
});

test("allowed text network bodies are redacted and opaque metadata is allowlisted", () => {
  const text = redactBrowserResult({
    kind: "network_log", origin: "https://example.com", entries: [], count: 0, dropped: 0,
    capturedAt: "2026-08-09T00:00:00.000Z", bodyDisposition: "text_body_returned",
    body: { requestId: "text-1", url: "https://example.com/api", encoding: "utf-8", mimeType: "application/json", data: "card 4111 1111 1111 1111", byteLength: 24, truncated: false },
  });
  assert.equal(text.kind, "network_log");
  assert.equal(text.body?.data.includes("4111"), false);
  assert.equal(text.body?.data.includes("[REDACTED_CARD]"), true);

  const opaque = redactBrowserResult({
    kind: "network_log", origin: "https://example.com", entries: [], count: 0, dropped: 0,
    capturedAt: "2026-08-09T00:00:00.000Z", body: null, bodyDisposition: "opaque_body_not_returned",
    bodyMetadata: { requestId: "opaque-1", url: "https://example.com/blob", mimeType: "application/octet-stream", declaredEncoding: "base64", encodedBytes: 42, sha256: "a".repeat(64), raw: "must-not-survive" },
  });
  assert.equal(opaque.kind, "network_log");
  assert.equal(opaque.bodyMetadata?.sha256, "a".repeat(64));
  assert.equal("raw" in (opaque.bodyMetadata ?? {}), false);

  for (const body of [
    { requestId: "unclassified", url: "https://example.com/api", mimeType: "application/json", data: "unclassified-secret" },
    { requestId: "binary", url: "https://example.com/api", encoding: "utf-8", mimeType: "application/octet-stream", data: "binary-secret" },
  ]) {
    const denied = redactBrowserResult({ kind: "network_log", origin: "https://example.com", entries: [], count: 0, dropped: 0, capturedAt: "2026-08-09T00:00:00.000Z", body });
    assert.equal(denied.kind, "network_log");
    assert.equal(denied.body, null);
    assert.equal(JSON.stringify(denied).includes(String(body.data)), false);
  }
});

test("denied / ungranted origins are blocked", () => {
  assert.equal(evaluateBrowserFloor({ action: { kind: "observe" }, origin: "https://evil.example", policy: allowed }).class, "blocked");
});

test("browser redaction removes action values and persists only summaries", () => {
  assert.equal(redactBrowserAction({ kind: "fill", role: "textbox", name: "Email", value: "secret@example.invalid" }).value, "[REDACTED]");
  const result = redactBrowserResult({
    kind: "observation",
    mode: "passive",
    origin: "https://example.com/page?token=abc",
    title: "Account token=123",
    nodes: [{ ref: "n1", role: "textbox", value: "person@example.invalid" }],
    nodeCount: 1,
    truncated: false,
    capturedAt: "2026-06-25T00:00:00.000Z",
  });
  assert.equal(result.kind, "observation");
  assert.equal(result.origin, "https://example.com");
});
