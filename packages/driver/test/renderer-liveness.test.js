import test from "node:test";
import assert from "node:assert/strict";
import { RendererLiveness } from "../dist/renderer-liveness.js";

test("renderer liveness follows event-driven detach reconciliation", () => {
  const liveness = new RendererLiveness();
  assert.equal(liveness.register("tab:7", 1).state, "healthy");
  assert.equal(liveness.transition("tab:7", "debugger_detached", { epoch: 1, detail: "replaced_with_devtools" }).state, "debugger_detached");
  assert.equal(liveness.transition("tab:7", "reconciling", { epoch: 1 }).state, "reconciling");
  assert.equal(liveness.transition("tab:7", "healthy", { epoch: 1 }).state, "healthy");
});

test("failure wait is target-scoped and resolves to a typed category", async () => {
  const liveness = new RendererLiveness();
  liveness.register("tab:1", 3);
  liveness.register("tab:2", 8);
  const first = liveness.failureFor("tab:1", 3);
  let secondResolved = false;
  void liveness.failureFor("tab:2", 8).then(() => { secondResolved = true; });
  liveness.transition("tab:1", "dialog_blocked", { epoch: 3, detail: "confirm" });
  assert.deepEqual(await first, { status: "dialog_blocked", errorCode: "dialog_blocked", detail: "confirm" });
  await Promise.resolve();
  assert.equal(secondResolved, false);
});

test("epochs prevent stale lifecycle events from corrupting a replacement target", () => {
  const liveness = new RendererLiveness();
  liveness.register("tab:7", 4);
  liveness.register("tab:7", 5);
  assert.throws(() => liveness.transition("tab:7", "discarded", { epoch: 4 }), /stale_target_epoch/);
  assert.equal(liveness.snapshot("tab:7").state, "healthy");
});

test("terminal and invalid transitions fail deterministically", () => {
  const liveness = new RendererLiveness();
  liveness.register("tab:7", 1);
  liveness.transition("tab:7", "target_gone");
  assert.throws(() => liveness.transition("tab:7", "healthy"), /invalid_liveness_transition/);
  assert.throws(() => liveness.transition("missing", "healthy"), /unknown_liveness_target/);
});

test("target and waiter bounds are explicit", async () => {
  const liveness = new RendererLiveness({ maxTargets: 1, maxWaitersPerTarget: 1 });
  liveness.register("one", 1);
  assert.throws(() => liveness.register("two", 1), /liveness_target_limit/);
  void liveness.failureFor("one", 1);
  assert.deepEqual(await liveness.failureFor("one", 1), { status: "unresponsive", errorCode: "renderer_unresponsive", detail: "liveness_waiter_limit" });
});
