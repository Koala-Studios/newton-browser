import test from "node:test";
import assert from "node:assert/strict";

import {
  BROWSER_ACTION_FIELDS,
  BROWSER_ACTION_FIELD_SPECS,
  parseBrowserAction,
  redactBrowserAction,
} from "../src/index.ts";

test("action schema fields survive parse and redact", () => {
  const parsed = parseBrowserAction({
    kind: "screenshot",
    target: { role: "button", name: "Continue", exact: true },
    waitFor: {
      url: "https://example.com/next?token=drop#frag",
      title: "Ready",
      text: "Loaded",
      selector: "#ready",
      role: "status",
      name: "Done",
      ref: "e1",
      state: "visible",
      value: "complete",
      timeoutMs: 999_999,
    },
    ref: "e2",
    role: "button",
    name: "Continue",
    label: "Primary",
    placeholder: "Search",
    testId: "primary-action",
    exact: true,
    value: "draft field value",
    url: "https://example.com/path?token=drop#frag",
    text: "Visible content",
    selector: "#primary",
    query: "Visible",
    maxNodes: 999,
    timeoutMs: 999_999,
    x: 10.4,
    y: 20.6,
    keys: ["Control", "Shift", "P", "Enter", "A", "B", "C", "D", "E"],
    files: ["C:\\fixtures\\asset.png"],
    sensitiveZones: [{ selector: "[data-private]", label: "private" }],
    checked: false,
    intent: "capture the current view",
    fullPage: true,
    device: "mobile",
    waitMs: 99_999,
    inline: true,
    clip: { x: 1.2, y: 2.6, width: 300.2, height: 200.8 },
    mode: "diff",
    maxChars: 5000,
    promptText: "Ada",
    viewport: { width: 1024, height: 768 },
    unknown: "drop me",
  });
  const redacted = redactBrowserAction(parsed);

  assert.deepEqual([...BROWSER_ACTION_FIELDS].sort(), Object.keys(BROWSER_ACTION_FIELD_SPECS).sort());
  for (const key of BROWSER_ACTION_FIELDS) assert.equal(key in redacted, true, `${key} should survive`);
  assert.equal("unknown" in (parsed as Record<string, unknown>), false);
  assert.equal("unknown" in (redacted as Record<string, unknown>), false);
  assert.equal(parsed.maxNodes, 250);
  assert.equal(parsed.timeoutMs, 120_000);
  assert.equal(parsed.waitMs, 10_000);
  assert.deepEqual(parsed.clip, { x: 1, y: 3, width: 300, height: 201 });
  assert.deepEqual(parsed.keys, ["Control", "Shift", "P", "Enter", "A", "B", "C", "D"]);
  assert.equal(redacted.url, "https://example.com/path");
  assert.equal(redacted.waitFor?.url, "https://example.com/next");
});

test("only action value is replaced as the secret field", () => {
  const redacted = redactBrowserAction(parseBrowserAction({
    kind: "fill",
    text: "Visible content",
    name: "Display name",
    value: "raw private value",
  }));

  assert.equal(redacted.value, "[REDACTED]");
  assert.equal(redacted.text, "Visible content");
  assert.equal(redacted.name, "Display name");
});
