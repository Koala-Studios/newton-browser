import test from "node:test";
import assert from "node:assert/strict";
import { TabClaims } from "../apps/tab-adapter/src/claims.ts";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

// Captures stay in flight until released by the test; everything else answers at once.
function fixture(options) {
  const log = [];
  const captures = [];
  const authority = new TabClaims({
    attach: async () => {},
    detach: async () => { log.push("detach"); },
    sendCommand: (_target, method, params) => {
      log.push(method === "Input.dispatchMouseEvent" ? `${method}:${params.type}` : method);
      if (method !== "Page.captureScreenshot") return Promise.resolve({});
      const gate = deferred();
      captures.push(gate);
      return gate.promise.then(() => ({ data: "" }));
    },
  }, "epoch", options);
  return { authority, log, captures };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));
const press = (type) => ({ type, x: 100, y: 100, button: "left", clickCount: 1 });

test("a held tab is set to render as shown when it is claimed", async () => {
  const { authority, log } = fixture();
  await authority.claim(authority.bindPort(), 1);
  await settle();
  assert.deepEqual(log, ["Emulation.setFocusEmulationEnabled"]);
});

test("input sent during a screenshot is dispatched after it, never during it", async () => {
  const { authority, log, captures } = fixture();
  const owner = authority.bindPort();
  const token = await authority.claim(owner, 1);
  const shot = authority.command(owner, token, "Page.captureScreenshot", { format: "png" });
  const pressed = authority.command(owner, token, "Input.dispatchMouseEvent", press("mousePressed"));
  const released = authority.command(owner, token, "Input.dispatchMouseEvent", press("mouseReleased"));
  await settle();
  assert.equal(log.includes("Input.dispatchMouseEvent:mousePressed"), false, "held while the capture is in flight");
  captures[0].resolve();
  await Promise.all([shot, pressed, released]);
  assert.deepEqual(log.slice(1), ["Page.captureScreenshot", "Input.dispatchMouseEvent:mousePressed", "Input.dispatchMouseEvent:mouseReleased"]);
});

test("held input keeps its order across a capture that starts while it waits", async () => {
  const { authority, log, captures } = fixture();
  const owner = authority.bindPort();
  const token = await authority.claim(owner, 1);
  const first = authority.command(owner, token, "Page.captureScreenshot", {});
  const pressed = authority.command(owner, token, "Input.dispatchMouseEvent", press("mousePressed"));
  const second = authority.command(owner, token, "Page.captureScreenshot", {});
  const released = authority.command(owner, token, "Input.dispatchMouseEvent", press("mouseReleased"));
  await settle();
  captures[0].resolve();
  await settle();
  assert.equal(log.includes("Input.dispatchMouseEvent:mousePressed"), false, "the second capture is still in flight");
  captures[1].resolve();
  await Promise.all([first, second, pressed, released]);
  assert.deepEqual(log.filter((step) => step.startsWith("Input.")), ["Input.dispatchMouseEvent:mousePressed", "Input.dispatchMouseEvent:mouseReleased"]);
});

test("input reads and other commands are not held behind a capture", async () => {
  const { authority, log, captures } = fixture();
  const owner = authority.bindPort();
  const token = await authority.claim(owner, 1);
  const shot = authority.command(owner, token, "Page.captureScreenshot", {});
  await authority.command(owner, token, "Runtime.evaluate", { expression: "1" });
  await authority.command(owner, token, "Input.setInterceptDrags", { enabled: false });
  assert.deepEqual(log.slice(1), ["Page.captureScreenshot", "Runtime.evaluate", "Input.setInterceptDrags"]);
  captures[0].resolve();
  await shot;
});

test("a capture that never finishes holds input only up to the limit", async () => {
  const { authority, log } = fixture({ inputHoldMs: 50 });
  const owner = authority.bindPort();
  const token = await authority.claim(owner, 1);
  void authority.command(owner, token, "Page.captureScreenshot", {}).catch(() => undefined);
  const started = performance.now();
  await authority.command(owner, token, "Input.insertText", { text: "x" });
  assert.ok(performance.now() - started >= 45);
  assert.ok(log.includes("Input.insertText"));
  await authority.disconnect(owner);
});

test("input held when the claim is released is never dispatched", async () => {
  const { authority, log, captures } = fixture();
  const owner = authority.bindPort();
  const token = await authority.claim(owner, 1);
  void authority.command(owner, token, "Page.captureScreenshot", {}).catch(() => undefined);
  const typed = authority.command(owner, token, "Input.insertText", { text: "late" });
  await authority.release(owner, token);
  await assert.rejects(typed, /connection_lost/);
  captures[0].resolve();
  await settle();
  assert.equal(log.includes("Input.insertText"), false);
});

test("a client can undo its device metrics override", async () => {
  const { authority, log } = fixture();
  const owner = authority.bindPort();
  const token = await authority.claim(owner, 1);
  await authority.command(owner, token, "Emulation.setDeviceMetricsOverride", { width: 800, height: 600, deviceScaleFactor: 2, mobile: false });
  await authority.command(owner, token, "Emulation.clearDeviceMetricsOverride", {});
  assert.deepEqual(log.slice(1), ["Emulation.setDeviceMetricsOverride", "Emulation.clearDeviceMetricsOverride"]);
});
