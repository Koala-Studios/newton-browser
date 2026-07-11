import test from "node:test";
import assert from "node:assert/strict";

import {
  evaluateBrowserFloor,
  redactBrowserAction,
  redactBrowserResult,
  type BrowserAction,
} from "../src/index.ts";

const youtubePolicy = { allowedOrigins: ["https://www.youtube.com"] };

test("generic target descriptors are preserved without leaking fill values", () => {
  const action: BrowserAction = {
    kind: "fill",
    target: { role: "textbox", name: "Email token=secret" },
    value: "user@example.invalid",
    waitFor: { text: "Saved", timeoutMs: 2500 },
  };
  const redacted = redactBrowserAction(action);
  assert.deepEqual(redacted.target, { role: "textbox", name: "Email token=[REDACTED]" });
  assert.equal(redacted.value, "[REDACTED]");
  assert.deepEqual(redacted.waitFor, { text: "Saved", timeoutMs: 2500 });
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

test("compact observations accept bbox arrays from the extension but do not expose raw DOM", () => {
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
