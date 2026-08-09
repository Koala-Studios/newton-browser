import test from "node:test";
import assert from "node:assert/strict";
import { DialogTracker, InputDispatcher, keyDescriptor } from "../dist/input-dispatcher.js";

test("key descriptors cover named, function, modifier, and printable keys", () => {
  assert.deepEqual(keyDescriptor("Enter", 0), { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, modifiers: 0, text: "\r", unmodifiedText: "\r" });
  assert.deepEqual(keyDescriptor("ArrowLeft", 2), { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37, nativeVirtualKeyCode: 37, modifiers: 2 });
  assert.deepEqual(keyDescriptor("F12", 0), { key: "F12", code: "F12", windowsVirtualKeyCode: 123, nativeVirtualKeyCode: 123, modifiers: 0 });
  assert.deepEqual(keyDescriptor("Control", 2), { key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17, modifiers: 2 });
  assert.deepEqual(keyDescriptor("A", 10), { key: "A", code: "KeyA", windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 10, text: "A", unmodifiedText: "A" });
  assert.deepEqual(keyDescriptor("a", 8), { key: "A", code: "KeyA", windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 8, text: "A", unmodifiedText: "a" });
  assert.deepEqual(keyDescriptor("/", 0), { key: "/", code: "Slash", windowsVirtualKeyCode: 191, nativeVirtualKeyCode: 191, modifiers: 0, text: "/", unmodifiedText: "/" });
  assert.equal(keyDescriptor("F24").windowsVirtualKeyCode, 135);
  assert.throws(() => keyDescriptor("NotAKey"), /unsupported_key/);
});

test("printable text uses one IME-compatible insertText command", async () => {
  const calls = [];
  const dispatcher = new InputDispatcher(async (method, params, route) => calls.push({ method, params, route }));
  await dispatcher.run({ sessionId: "child" }, (input) => input.insertText("héllo 世界\n"));
  assert.deepEqual(calls, [{ method: "Input.insertText", params: { text: "héllo 世界\n" }, route: { sessionId: "child" } }]);
});

test("modifier chord emits balanced complete CDP key events", async () => {
  const calls = [];
  const dispatcher = new InputDispatcher(async (method, params) => calls.push({ method, params }));
  await dispatcher.run({}, (input) => input.chord(["Control", "Shift", "P"]));
  assert.deepEqual(calls.map((call) => [call.params.type, call.params.key, call.params.modifiers]), [
    ["rawKeyDown", "Control", 2],
    ["rawKeyDown", "Shift", 10],
    ["rawKeyDown", "P", 10],
    ["keyUp", "P", 10],
    ["keyUp", "Shift", 10],
    ["keyUp", "Control", 2],
  ]);
  assert.equal(calls.find((call) => call.params.key === "P" && call.params.type === "rawKeyDown").params.text, undefined);
  assert.equal(calls.find((call) => call.params.type === "keyUp" && call.params.key === "P").params.text, undefined);
});

test("pointer lifecycle releases a pressed button after operation failure", async () => {
  const calls = [];
  const dispatcher = new InputDispatcher(async (method, params) => calls.push({ method, params }));
  await assert.rejects(dispatcher.run({}, async (input) => {
    await input.pointerMove({ x: 20, y: 30 });
    await input.mouseDown("left");
    throw new Error("renderer_failed");
  }), /renderer_failed/);
  assert.deepEqual(calls.filter((call) => call.method === "Input.dispatchMouseEvent").map((call) => [call.params.type, call.params.buttons]), [
    ["mouseMoved", 0], ["mousePressed", 1], ["mouseReleased", 0],
  ]);
});

test("wheel input is routed with exact deltas and timeout route metadata", async () => {
  const calls = [];
  const dispatcher = new InputDispatcher(async (method, params, route) => calls.push({ method, params, route }));
  await dispatcher.run({ timeoutMs: 2000 }, (input) => input.wheel({ x: 10, y: 20 }, { x: -5, y: 900 }));
  assert.deepEqual(calls, [{
    method: "Input.dispatchMouseEvent",
    params: { type: "mouseWheel", x: 10, y: 20, deltaX: -5, deltaY: 900, modifiers: 0, pointerType: "mouse" },
    route: { timeoutMs: 2000 },
  }]);
});

test("cleanup failures do not overwrite an uncertain operation error", async () => {
  const dispatcher = new InputDispatcher(async (_method, params) => {
    if (params.type === "mouseReleased") throw new Error("release_failed");
  });
  let caught;
  try {
    await dispatcher.run({}, async (input) => {
      await input.mouseDown("left");
      throw new Error("effect_unknown");
    });
  } catch (error) {
    caught = error;
  }
  assert.equal(caught.message, "effect_unknown");
  assert.equal(caught.inputCleanupErrors[0].message, "release_failed");
});

test("dialog races subscribe before dispatch and stay target scoped", async () => {
  const tracker = new DialogTracker();
  let releaseEffect;
  const effect = new Promise((resolve) => { releaseEffect = resolve; });
  const raced = tracker.race("session:child-a", "command-1", () => effect);
  tracker.open("session:child-b", { type: "alert", message: "other" });
  let settled = false;
  void raced.then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  tracker.open("session:child-a", { type: "confirm", message: "continue?" });
  assert.deepEqual(await raced, { kind: "dialog", dialog: { dialogType: "confirm", message: "continue?" } });
  releaseEffect("late acknowledgement");
});

test("a pre-existing dialog prevents input dispatch", async () => {
  const tracker = new DialogTracker();
  tracker.open("root", { type: "prompt", message: "name", defaultPrompt: "Ada" });
  let dispatched = false;
  const result = await tracker.race("root", "command-2", () => { dispatched = true; });
  assert.equal(dispatched, false);
  assert.deepEqual(result.dialog, { dialogType: "prompt", message: "name", defaultPrompt: "Ada" });
  assert.equal(tracker.close("root"), true);
  assert.equal(tracker.pending("root"), null);
});

test("whenIdle follows dispatcher cleanup instead of a timer", async () => {
  let releaseSend;
  const sendBlocked = new Promise((resolve) => { releaseSend = resolve; });
  const dispatcher = new InputDispatcher(async () => sendBlocked);
  const running = dispatcher.run({}, (input) => input.pointerMove({ x: 1, y: 2 }));
  let idle = false;
  void dispatcher.whenIdle().then(() => { idle = true; });
  await Promise.resolve();
  assert.equal(idle, false);
  releaseSend();
  await running;
  await dispatcher.whenIdle();
  assert.equal(idle, true);
});
