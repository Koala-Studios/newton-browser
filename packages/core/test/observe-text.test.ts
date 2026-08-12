import test from "node:test";
import assert from "node:assert/strict";

import { parseBrowserAction, redactBrowserResult } from "../src/index.ts";

test("parseBrowserAction accepts mode:text and a bounded maxChars", () => {
  const action = parseBrowserAction({ kind: "observe", mode: "text", maxChars: 5000 });
  assert.equal(action.mode, "text");
  assert.equal(action.maxChars, 5000);
});

test("out-of-range maxChars is rejected instead of silently repaired", () => {
  assert.throws(() => parseBrowserAction({ kind: "observe", mode: "text", maxChars: 10 }), /outside bounds/);
  assert.throws(() => parseBrowserAction({ kind: "observe", mode: "text", maxChars: 9_999_999 }), /outside bounds/);
});

test("an unknown mode is rejected instead of silently falling back", () => {
  assert.throws(() => parseBrowserAction({ kind: "observe", mode: "bogus" }), /allowed value/);
});

test("observation_text survives redaction and keeps readable prose", () => {
  const result = redactBrowserResult({
    kind: "observation_text",
    mode: "text",
    origin: "https://example.com",
    title: "Docs",
    text: "The quick brown fox jumps over the lazy dog.",
    chars: 44,
    truncated: false,
    capturedAt: "2026-07-10T00:00:00.000Z",
  });
  assert.equal(result?.kind, "observation_text");
  if (result?.kind !== "observation_text") throw new Error("expected observation_text");
  assert.equal(result.text, "The quick brown fox jumps over the lazy dog.");
  assert.equal(result.origin, "https://example.com");
  assert.equal(result.chars, 44);
});

test("secrets, cards, SSNs, and emails are stripped from text observations", () => {
  const text = [
    "API_KEY=sk_live_abcdef0123456789abcdef",
    "Authorization: Bearer abcdef0123456789abcdef",
    "Card 4111 1111 1111 1111 on file",
    "SSN 123-45-6789",
    "reach me at person@example.com",
  ].join("\n");
  const result = redactBrowserResult({
    kind: "observation_text",
    mode: "text",
    origin: "https://example.com",
    title: "Leak",
    text,
    chars: text.length,
    truncated: false,
    capturedAt: "2026-07-10T00:00:00.000Z",
  });
  if (result?.kind !== "observation_text") throw new Error("expected observation_text");
  assert.ok(!result.text.includes("sk_live_abcdef0123456789abcdef"));
  assert.ok(!result.text.includes("4111 1111 1111 1111"));
  assert.ok(!result.text.includes("123-45-6789"));
  assert.ok(!result.text.includes("person@example.com"));
  assert.match(result.text, /\[REDACTED_CARD\]/);
  assert.match(result.text, /\[REDACTED_SSN\]/);
});

test("oversized text is truncated at the hard cap", () => {
  const huge = "a".repeat(250_000);
  const result = redactBrowserResult({
    kind: "observation_text",
    mode: "text",
    origin: "https://example.com",
    title: "Big",
    text: huge,
    chars: huge.length,
    truncated: false,
    capturedAt: "2026-07-10T00:00:00.000Z",
  });
  if (result?.kind !== "observation_text") throw new Error("expected observation_text");
  assert.equal(result.text.length, 200_000);
  assert.equal(result.truncated, true);
});
