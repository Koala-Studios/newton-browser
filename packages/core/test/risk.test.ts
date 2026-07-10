import test from "node:test";
import assert from "node:assert/strict";

import {
  evaluateBrowserFloor,
  redactBrowserAction,
  redactBrowserResult,
  summarizeBrowserResult,
  type BrowserHostPolicyManifest,
} from "../src/index.ts";

const allowed = { allowedOrigins: ["https://example.com"] };

test("read-only browser actions stay read-only on granted origins", () => {
  const decision = evaluateBrowserFloor({
    action: { kind: "observe" },
    origin: "https://mail.google.com/mail/u/0/#inbox",
    policy: { allowedOrigins: ["https://mail.google.com"] },
  });
  assert.equal(decision.class, "read_only");
  assert.equal(decision.permissionRequired, "browser_bridge.observe");
  assert.equal(decision.blocked, false);
});

test("non-committing work never prompts", () => {
  assert.equal(evaluateBrowserFloor({ action: { kind: "scroll" }, origin: "https://example.com", policy: allowed }).class, "agentic");
  assert.equal(evaluateBrowserFloor({ action: { kind: "navigate", url: "https://example.com/next" }, origin: "https://example.com", policy: allowed }).class, "agentic");
  assert.equal(evaluateBrowserFloor({ action: { kind: "fill", text: "Primary text", value: "hi" }, origin: "https://example.com", policy: allowed }).class, "agentic");
  assert.equal(evaluateBrowserFloor({ action: { kind: "click", text: "Open menu" }, origin: "https://example.com", policy: allowed }).class, "agentic");
});

test("credential/secret fields are blocked and never typed", () => {
  assert.equal(evaluateBrowserFloor({ action: { kind: "fill", text: "Password" }, origin: "https://example.com", policy: allowed }).class, "blocked");
  assert.equal(evaluateBrowserFloor({ action: { kind: "type", selector: "#api-key" }, origin: "https://example.com", policy: allowed }).class, "blocked");
  assert.equal(evaluateBrowserFloor({ action: { kind: "fill" }, resolved: { inputType: "password" }, origin: "https://example.com", policy: allowed }).class, "blocked");
});

test("a structurally-detected commit on an unknown host is classified as commit metadata", () => {
  // Submit-like accessible name on an unknown (no-manifest) host → conservative classification.
  const submitLike = evaluateBrowserFloor({ action: { kind: "click", text: "Publish" }, origin: "https://example.com", policy: allowed });
  assert.equal(submitLike.class, "approval_required");
  assert.equal(submitLike.commitBoundary, "commit");

  // A resolved form-submit element is structurally a commit regardless of text.
  const formSubmit = evaluateBrowserFloor({ action: { kind: "click", text: "Go" }, resolved: { role: "button", formOwner: "checkout-form" }, origin: "https://example.com", policy: allowed });
  assert.equal(formSubmit.class, "approval_required");

  // Spaced/styled commit labels are caught (Shopify's "CHECK OUT", "PLACE ORDER").
  for (const name of ["CHECK OUT", "Place Order", "Complete order", "Remove item"]) {
    const decision = evaluateBrowserFloor({ action: { kind: "click", target: { ref: "n1" } }, resolved: { role: "button", accessibleName: name }, origin: "https://shop.example", policy: { allowedOrigins: ["https://shop.example"] } });
    assert.equal(decision.class, "approval_required", `${name} should be classified as commit metadata`);
  }
});

test("social engagement actions are classified as external effects", () => {
  const like = evaluateBrowserFloor({ action: { kind: "click", text: "Like" }, origin: "https://www.youtube.com", policy: { allowedOrigins: ["https://www.youtube.com"] } });
  assert.equal(like.class, "approval_required");
  assert.equal(like.commitBoundary, "external_effect");
  assert.equal(like.reasons.includes("social_engagement_action"), true);

  const subscribe = evaluateBrowserFloor({ action: { kind: "click", selector: "button[aria-label='Subscribe']" }, origin: "https://www.youtube.com", policy: { allowedOrigins: ["https://www.youtube.com"] } });
  assert.equal(subscribe.class, "approval_required");
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
  assert.equal(decision.class, "approval_required");
  assert.equal(decision.commitBoundary, "external_effect");
});

test("a ref-targeted commit is gated once the driver supplies resolved evidence (S3/D16)", () => {
  const manifest: BrowserHostPolicyManifest = {
    origins: ["https://adsmanager.facebook.com"],
    commitRules: [{ match: { name: "publish" }, effect: "external_effect", reason: "ads_manager_publish" }],
  };
  const adsPolicy = { allowedOrigins: ["https://adsmanager.facebook.com"] };

  // Without resolved evidence a ref click is opaque → agentic (the old gap).
  const blind = evaluateBrowserFloor({ action: { kind: "click", target: { ref: "n5" } }, manifest, origin: "https://adsmanager.facebook.com", policy: adsPolicy });
  assert.equal(blind.class, "agentic");

  // With the driver's pre-dispatch resolved name, the host rule matches by ref.
  const resolved = evaluateBrowserFloor({
    action: { kind: "click", target: { ref: "n5" } },
    resolved: { role: "button", accessibleName: "Publish" },
    manifest,
    origin: "https://adsmanager.facebook.com",
    policy: adsPolicy,
  });
  assert.equal(resolved.class, "approval_required");
  assert.equal(resolved.commitBoundary, "external_effect");

  // Unknown host: a ref click resolving to a submit-like name also stops.
  const unknown = evaluateBrowserFloor({
    action: { kind: "click", target: { ref: "n9" } },
    resolved: { role: "button", accessibleName: "Delete account" },
    origin: "https://app.unknown.example",
    policy: { allowedOrigins: ["https://app.unknown.example"] },
  });
  assert.equal(unknown.class, "approval_required");
});

test("payment / government-id fields are blocked like credentials (S22)", () => {
  const cc = evaluateBrowserFloor({ action: { kind: "fill", label: "Credit card number", value: "4111111111111111" }, origin: "https://example.com", policy: allowed });
  assert.equal(cc.class, "blocked");
  assert.equal(cc.reasons.includes("payment_or_pii_field"), true);

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

test("redaction preserves screenshot capture options and observe mode (D5/D6)", () => {
  const shot = redactBrowserAction({ kind: "screenshot", fullPage: true, device: "mobile", waitMs: 2500, inline: true });
  assert.equal(shot.fullPage, true);
  assert.equal(shot.device, "mobile");
  assert.equal(shot.waitMs, 2500);
  assert.equal(shot.inline, true);
  // waitMs is bounded.
  assert.equal(redactBrowserAction({ kind: "screenshot", waitMs: 999999 }).waitMs, 10_000);
  // Bad device value is dropped.
  assert.equal(redactBrowserAction({ kind: "screenshot", device: "watch" as never }).device, undefined);
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
    ],
    nodeCount: 12,
    capturedAt: "2026-06-29T00:00:00.000Z",
    actionStatus: "verified",
    verified: true,
  });
  assert.equal(result.kind, "observation_delta");
  assert.equal(result.added.length, 1);
  assert.equal(result.added[0].ref, "e9");
  assert.deepEqual(result.removed, ["e1", "e2"]);
  assert.equal(result.updated.length, 2);
  // A sensitive value in an updated field is masked like an observation value (S18).
  assert.equal(result.updated[1].value, "[REDACTED]");
  assert.equal(result.nodeCount, 12);

  const summary = summarizeBrowserResult(result);
  assert.equal(summary.kind, "observation_delta");
  assert.equal(summary.added, 1);
  assert.equal(summary.removed, 2);
  assert.equal(summary.updated, 2);
  assert.equal("nodes" in summary, false);
});

test("inline screenshot bytes ride result_json only when requested and bounded (D5)", () => {
  const tinyPng = `data:image/png;base64,${"A".repeat(64)}`;
  // inline:true within cap → image carried, with device/fullPage flags.
  const inlined = redactBrowserResult({
    kind: "screenshot", mode: "cdp", origin: "https://example.com", title: "Page",
    device: "mobile", fullPage: true, dataUrl: tinyPng, inline: true, capturedAt: "2026-06-29T00:00:00.000Z",
  });
  assert.equal(inlined.kind, "screenshot");
  assert.equal(inlined.dataUrl, tinyPng);
  assert.equal(inlined.device, "mobile");
  assert.equal(inlined.fullPage, true);
  // No inline flag → bytes are dropped from persistence (artifact-only delivery).
  const stripped = redactBrowserResult({
    kind: "screenshot", mode: "cdp", origin: "https://example.com", title: "Page",
    dataUrl: tinyPng, capturedAt: "2026-06-29T00:00:00.000Z",
  });
  assert.equal("dataUrl" in stripped, false);
  // Over the size cap → bytes dropped, truncated flagged.
  const huge = `data:image/png;base64,${"A".repeat(23_000_001)}`;
  const overCap = redactBrowserResult({
    kind: "screenshot", mode: "cdp", origin: "https://example.com", title: "Page",
    dataUrl: huge, inline: true, capturedAt: "2026-06-29T00:00:00.000Z",
  });
  assert.equal("dataUrl" in overCap, false);
  assert.equal(overCap.truncated, true);
});

test("the model may raise risk but can never lower it", () => {
  const raised = evaluateBrowserFloor({ action: { kind: "screenshot" }, origin: "https://example.com", policy: allowed, requestedClass: "approval_required" });
  assert.equal(raised.class, "approval_required");

  const lowerAttempt = evaluateBrowserFloor({ action: { kind: "click", text: "Publish" }, origin: "https://example.com", policy: allowed, requestedClass: "agentic" });
  assert.equal(lowerAttempt.class, "approval_required");
});

test("actuation feature flag blocks all mutation while observation stays live", () => {
  assert.equal(evaluateBrowserFloor({ action: { kind: "click", text: "Open" }, origin: "https://example.com", policy: allowed, actuationEnabled: false }).class, "blocked");
  // Observation is unaffected by the actuation flag.
  assert.equal(evaluateBrowserFloor({ action: { kind: "observe" }, origin: "https://example.com", policy: allowed, actuationEnabled: false }).class, "read_only");
});

test("denied / ungranted origins are blocked", () => {
  assert.equal(evaluateBrowserFloor({ action: { kind: "observe" }, origin: "https://evil.example", policy: allowed }).class, "blocked");
});

test("browser redaction removes action values and persists only summaries", () => {
  assert.equal(redactBrowserAction({ kind: "fill", value: "secret@example.invalid" }).value, "[REDACTED]");
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
  const summary = summarizeBrowserResult(result);
  assert.equal(summary.kind, "observation");
  assert.equal(summary.origin, "https://example.com");
  assert.equal("nodes" in summary, false);
});
