import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { ProcessCleanupError, ProcessSupervisor, type SupervisedChild } from "../../src/browser-runtime/process-supervisor.ts";

class FakeChild extends EventEmitter implements SupervisedChild {
  readonly pid = 1234;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kill(): boolean { return true; }
  exit(code = 0): void {
    this.exitCode = code;
    this.emit("exit", code, null);
  }
}

test("graceful protocol close confirms process exit without tree kill", async () => {
  const child = new FakeChild();
  let kills = 0;
  const supervisor = new ProcessSupervisor({
    child,
    gracefulClose: async () => child.exit(),
    killTree: async () => { kills += 1; },
  });
  await supervisor.terminate();
  assert.equal(supervisor.state, "terminated");
  assert.equal(kills, 0);
});

test("failed graceful close falls back to exact tree kill and exit acknowledgement", async () => {
  const child = new FakeChild();
  const order: string[] = [];
  const supervisor = new ProcessSupervisor({
    child,
    gracefulClose: async () => { order.push("graceful"); throw new Error("private detail"); },
    killTree: async (pid, platform) => {
      order.push(`kill:${pid}:${platform}`);
      child.exit(137);
    },
    platform: "linux",
  });
  await supervisor.terminate();
  assert.deepEqual(order, ["graceful", "kill:1234:linux"]);
  assert.equal(supervisor.state, "terminated");
});

test("tree cleanup failure remains uncertain and supports an exact retry", async () => {
  const child = new FakeChild();
  let attempts = 0;
  const supervisor = new ProcessSupervisor({
    child,
    gracefulClose: async () => { throw new Error("closed transport"); },
    killTree: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("sensitive OS text");
      child.exit(137);
    },
  });
  const first = await supervisor.terminate().catch((error: unknown) => error);
  assert.ok(first instanceof ProcessCleanupError);
  assert.equal(first.message.includes("sensitive"), false);
  assert.equal(supervisor.state, "uncertain");
  await supervisor.terminate();
  assert.equal(supervisor.state, "terminated");
  assert.equal(attempts, 2);
});

test("concurrent terminate callers share one state transition", async () => {
  const child = new FakeChild();
  let kills = 0;
  const supervisor = new ProcessSupervisor({
    child,
    killTree: async () => { kills += 1; child.exit(137); },
  });
  await Promise.all([supervisor.terminate(), supervisor.terminate()]);
  assert.equal(kills, 1);
  assert.equal(supervisor.state, "terminated");
});
