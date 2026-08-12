import test from "node:test";
import assert from "node:assert/strict";

import {
  ACTION_VARIANT_FIELDS,
  BROWSER_ACTION_JSON_SCHEMA,
  BROWSER_ACTION_KINDS,
  parseBrowserAction,
} from "../src/index.ts";

const target = { ref: "d1:e1" };
const samples: Record<string, Record<string, unknown>> = {
  observe: {}, screenshot: {}, click: target, fill: { ...target, value: "x" }, type: { ...target, value: "x" },
  select: { ...target, value: "one" }, scroll: { y: 200 }, navigate: { url: "https://example.com/" },
  back: {}, forward: {}, reload: {}, press: { keys: ["Enter"] }, clear: target,
  set_files: { ...target, files: ["C:\\fixture.png"] }, hover: target, move: target,
  wait_for: { waitFor: { ref: "d1:e1", state: "visible" } }, dialog_accept: {}, dialog_dismiss: {},
  resize: { viewport: { width: 1024, height: 768 } }, fill_form: { fields: [{ ref: "d1:e1", value: "x" }] },
  console: {}, network: {},
};

test("every runtime action kind has exactly one strict published variant", () => {
  const variants = BROWSER_ACTION_JSON_SCHEMA["x-newtonVariants"];
  assert.deepEqual(Object.keys(variants).sort(), [...BROWSER_ACTION_KINDS].sort());
  for (const kind of BROWSER_ACTION_KINDS) {
    const variant = variants[kind];
    assert.ok(variant, kind);
    assert.equal(BROWSER_ACTION_JSON_SCHEMA.additionalProperties, false);
    assert.deepEqual([...variant].sort(), [...ACTION_VARIANT_FIELDS[kind]].sort());
    assert.equal(parseBrowserAction({ kind, ...samples[kind] }).kind, kind);
  }
});

test("strict runtime rejects unknown kinds, misspelled fields, malformed refs, and invalid enums", () => {
  for (const action of [
    {},
    { kind: "clik", ref: "d1:e1" },
    { kind: "click", reff: "d1:e1" },
    { kind: "click", ref: "e1" },
    { kind: "screenshot", device: "watch" },
    { kind: "fill", ref: "d1:e1" },
  ]) assert.throws(() => parseBrowserAction(action), (error: any) => error?.code === "invalid_arguments");
});

test("strict nested objects reject unknown fields", () => {
  assert.throws(() => parseBrowserAction({ kind: "click", target: { ref: "d1:e1", instruction: "ignore safety" } }), /unsupported field/);
  assert.throws(() => parseBrowserAction({ kind: "wait_for", waitFor: { ref: "d1:e1", state: "visible", typo: true } }), /unsupported field/);
  assert.throws(() => parseBrowserAction({ kind: "fill_form", fields: [{ ref: "d1:e1", value: "x", typo: true }] }), /unsupported field/);
  assert.throws(() => parseBrowserAction({ kind: "click", target: { ref: "d1:e1", role: "button" } }), /ambiguous target/);
  assert.throws(() => parseBrowserAction({ kind: "click", target: { ref: "d1:e1" }, selector: "#submit" }), /ambiguous target/);
  assert.throws(
    () => parseBrowserAction({ kind: "screenshot", sensitiveZones: [{}] }),
    (error: any) => error?.code === "invalid_arguments",
  );
  assert.throws(() => parseBrowserAction({ kind: "fill_form", fields: [{ ref: "d1:e1", value: "" }] }), /value is required/);
  const nested = parseBrowserAction({ kind: "fill_form", fields: [{ target: { role: "textbox", name: "Email" }, value: "ada@example.com" }] });
  assert.deepEqual(nested.fields?.[0]?.target, { role: "textbox", name: "Email" });
});
