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
    value: "frank@example.invalid",
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
