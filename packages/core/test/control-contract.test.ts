import test from "node:test";
import assert from "node:assert/strict";

import {
  evaluateBrowserFloor,
  normalizeHttpOrigin,
  redactBrowserAction,
  redactBrowserResult,
  type BrowserAction,
} from "../src/index.ts";

const youtubePolicy = { allowedOrigins: ["https://www.youtube.com"] };

test("core session-origin normalization rejects paths, credentials, and wildcard hosts", () => {
  assert.equal(normalizeHttpOrigin("https://example.com:443"), "https://example.com");
  assert.equal(normalizeHttpOrigin("https://api.example.com:8443/"), "https://api.example.com:8443");
  for (const value of ["https://example.com/path", "https://user@example.com", "https://*.example.com", "file:///tmp/a"]) {
    assert.equal(normalizeHttpOrigin(value), "");
  }
});

test("per-kind target descriptors are preserved without leaking fill values", () => {
  const action: BrowserAction = {
    kind: "fill",
    target: { role: "textbox", name: "Email token=secret" },
    value: "user@example.invalid",
  };
  const redacted = redactBrowserAction(action);
  assert.deepEqual(redacted.target, { role: "textbox", name: "Email token=[REDACTED]" });
  assert.equal(redacted.value, "[REDACTED]");
  assert.deepEqual(redactBrowserAction({ kind: "wait_for", waitFor: { text: "Saved", timeoutMs: 2500 } }).waitFor, { text: "Saved", timeoutMs: 2500 });
  assert.throws(() => redactBrowserAction({ ...action, waitFor: { text: "Saved" } } as BrowserAction), /unsupported field/);
});

test("new target descriptors feed the safety floor", () => {
  const decision = evaluateBrowserFloor({
    action: { kind: "click", target: { role: "button", name: "Like" } },
    origin: "https://www.youtube.com/watch?v=test",
    policy: youtubePolicy,
  });
  assert.equal(decision.class, "approval_required");
  assert.equal(decision.commitBoundary, "external_effect");
  assert.equal(decision.reasons.includes("social_engagement_action"), true);
});

test("compact observations accept driver bbox arrays but do not expose raw DOM", () => {
  const result = redactBrowserResult({
    kind: "observation",
    mode: "cdp",
    origin: "https://example.com/path?token=secret",
    title: "Example",
    nodes: [
      {
        ref: "n0",
        role: "button",
        name: "Continue",
        bbox: [10.4, 20.6, 100.2, 30.8],
        rawHtml: "<button>Continue</button>",
      },
    ],
    nodeCount: 1,
    truncated: false,
    capturedAt: "2026-06-26T00:00:00.000Z",
  });
  assert.equal(result?.kind, "observation");
  if (result?.kind !== "observation") throw new Error("expected observation");
  assert.deepEqual(result.nodes[0]?.bbox, { x: 10, y: 21, width: 100, height: 31 });
  assert.equal("rawHtml" in (result.nodes[0] as Record<string, unknown>), false);
});

test("frame provenance and excluded frames survive redaction with strict bounds", () => {
  const result = redactBrowserResult({
    kind: "observation", mode: "cdp", origin: "https://example.com", title: "Frames",
    nodes: [{ ref: "d2:f1:e7", role: "button", documentEpoch: 2, frameId: "child", frameOrigin: "https://child.test" }],
    excludedFrames: [
      { frameId: "denied", frameOrigin: "https://denied.test/path?secret=x", reason: "origin_not_granted" },
      { frameId: "ignored", frameOrigin: "https://ignored.test", reason: "invented" },
    ],
    nodeCount: 1, truncated: false, capturedAt: "2026-08-09T00:00:00.000Z",
  });
  assert.equal(result?.kind, "observation");
  if (result?.kind !== "observation") throw new Error("expected observation");
  assert.deepEqual(result.nodes[0], {
    ref: "d2:f1:e7", role: "button", documentEpoch: 2, frameId: "child", frameOrigin: "https://child.test",
  });
  assert.deepEqual(result.excludedFrames, [{ frameId: "denied", frameOrigin: "https://denied.test", reason: "origin_not_granted" }]);
});

test("a pending dialog is surfaced on observations with its message secret-masked", () => {
  const result = redactBrowserResult({
    kind: "observation",
    mode: "cdp",
    origin: "https://example.com",
    title: "Example",
    nodes: [],
    nodeCount: 0,
    truncated: false,
    capturedAt: "2026-06-26T00:00:00.000Z",
    pendingDialog: { dialogType: "confirm", message: "Charge card 4111 1111 1111 1111 now?" },
  });
  assert.equal(result?.kind, "observation");
  if (result?.kind !== "observation") throw new Error("expected observation");
  const pending = (result as Record<string, unknown>).pendingDialog as { dialogType: string; message: string };
  assert.equal(pending.dialogType, "confirm");
  assert.equal(pending.message.includes("4111"), false);
  assert.ok(pending.message.includes("[REDACTED_CARD]"));
});

test("a set_files delta keeps sanitized filenames through result redaction", () => {
  const result = redactBrowserResult({
    kind: "observation", mode: "cdp", origin: "https://example.com", title: "Upload",
    nodes: [], nodeCount: 0, truncated: false, capturedAt: "2026-06-26T00:00:00.000Z",
    actionStatus: "verified", verified: true,
    changed: { files: [{ filename: "asset.png", path: "C:/secret/asset.png" }] },
  }) as Record<string, unknown>;
  const changed = (result as { changed?: Record<string, unknown> }).changed ?? {};
  const files = changed.files as Array<{ filename: string }>;
  assert.equal(files[0].filename, "asset.png");
  assert.equal("path" in files[0], false, "absolute paths must never survive redaction");
});

test("an unknown pendingDialog shape is dropped rather than passed through", () => {
  const result = redactBrowserResult({
    kind: "observation", mode: "cdp", origin: "https://example.com", title: "Example",
    nodes: [], nodeCount: 0, truncated: false, capturedAt: "2026-06-26T00:00:00.000Z",
    pendingDialog: { dialogType: "evil", message: "x" },
  }) as Record<string, unknown>;
  assert.equal("pendingDialog" in result, false);
});
