import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { DialogTracker, InputDispatcher, keyDescriptor } from "../../../packages/driver/dist/input-dispatcher.js";
import { RendererLiveness } from "../../../packages/driver/dist/renderer-liveness.js";

test("input fixture vectors retain complete named-key descriptors", () => {
  for (const key of ["Enter", "Tab", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Escape", "Backspace", "Delete", "F1", "F12", "F24"]) {
    const descriptor = keyDescriptor(key, 0);
    assert.equal(descriptor.key, key);
    assert.equal(typeof descriptor.code, "string");
    assert.equal(Number.isInteger(descriptor.windowsVirtualKeyCode), true);
    assert.equal(Number.isInteger(descriptor.nativeVirtualKeyCode), true);
    assert.equal(descriptor.modifiers, 0);
  }
  assert.equal(keyDescriptor("Escape", 0).text, undefined);
  assert.equal(keyDescriptor("A", 10).text, "A");
  assert.equal(keyDescriptor("A", 10).unmodifiedText, "A");
});

test("input fixture cancellation leaves pointer and modifier lifecycles balanced", async () => {
  const events = [];
  const dispatcher = new InputDispatcher(async (method, params) => events.push([method, params.type, params.key ?? params.button]));
  await assert.rejects(dispatcher.run({}, async (input) => {
    await input.keyDown("Control");
    await input.mouseDown("left");
    throw new Error("cancelled_after_release_boundary");
  }), /cancelled_after_release_boundary/);
  assert.deepEqual(events.map((entry) => entry[1]), ["rawKeyDown", "mousePressed", "mouseReleased", "keyUp"]);
});

test("input fixture dialogs remain scoped to their target", async () => {
  const dialogs = new DialogTracker();
  const waiting = dialogs.race("frame:expected", "command:1", () => new Promise(() => {}));
  dialogs.open("frame:unrelated", { type: "alert", message: "unrelated" });
  dialogs.open("frame:expected", { type: "confirm", message: "expected" });
  assert.deepEqual(await waiting, { kind: "dialog", dialog: { dialogType: "confirm", message: "expected" } });
  assert.equal(dialogs.pending("frame:unrelated")?.message, "unrelated");
});

test("renderer fixture covers every event-driven lifecycle category", () => {
  const allowed = ["dialog_blocked", "discarded", "debugger_detached", "target_gone", "unresponsive"];
  for (const state of allowed) {
    const liveness = new RendererLiveness();
    liveness.register(`target:${state}`, 1);
    assert.equal(liveness.transition(`target:${state}`, state, { epoch: 1 }).state, state);
  }
  const liveness = new RendererLiveness();
  liveness.register("target:recovery", 1);
  liveness.transition("target:recovery", "debugger_detached", { epoch: 1 });
  liveness.transition("target:recovery", "reconciling", { epoch: 1 });
  assert.equal(liveness.transition("target:recovery", "healthy", { epoch: 1 }).state, "healthy");
  assert.equal(liveness.transition("target:recovery", "terminal", { epoch: 1 }).state, "terminal");
});

test("input fixture keeps key evidence compact instead of exposing an unbounded event history", () => {
  const source = fs.readFileSync(new URL("./index.html", import.meta.url), "utf8");
  assert.match(source, /keys:\s*\[\.\.\.new Set\(/u);
  assert.match(source, /types:\s*\[\.\.\.new Set\(/u);
  assert.doesNotMatch(source, /JSON\.stringify\(keyEvents\)/u);
});
