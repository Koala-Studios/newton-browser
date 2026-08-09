import test from "node:test";
import assert from "node:assert/strict";

import { SessionCommandPump } from "../dist/session-command-pump.js";

function deferredGate() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("SessionCommandPump runs queued commands FIFO and never overlaps executors", async () => {
  const pump = new SessionCommandPump({ maxItems: 4, maxBytes: 1024 });
  const release = deferredGate();
  const firstStarted = deferredGate();
  const timeline = [];
  let running = 0;
  let maxRunning = 0;

  const first = pump.enqueue("first", 1, async () => {
    running += 1;
    maxRunning = Math.max(maxRunning, running);
    firstStarted.resolve();
    timeline.push("first-start");
    await release.promise;
    timeline.push("first-end");
    running -= 1;
    return "first";
  });

  const second = pump.enqueue("second", 1, async () => {
    running += 1;
    maxRunning = Math.max(maxRunning, running);
    timeline.push("second-start");
    timeline.push("second-end");
    running -= 1;
    return "second";
  });

  await firstStarted.promise;
  const during = pump.snapshot();
  assert.equal(during.running, true);
  assert.equal(during.runningCount, 1);
  assert.equal(during.queueLength, 1);
  assert.equal(during.queuedBytes, 1);
  assert.equal(during.runningBytes, 1);
  assert.equal(timeline.includes("second-start"), false);

  release.resolve();
  const resolved = await Promise.all([first, second]);
  assert.deepEqual(resolved, ["first", "second"]);
  assert.deepEqual(timeline, ["first-start", "first-end", "second-start", "second-end"]);
  assert.equal(maxRunning, 1);
});

test("SessionCommandPump allows independent session pumps to progress concurrently", async () => {
  const left = new SessionCommandPump({ maxItems: 4, maxBytes: 1024 });
  const right = new SessionCommandPump({ maxItems: 4, maxBytes: 1024 });
  const leftStarted = deferredGate();
  const rightStarted = deferredGate();
  const leftRelease = deferredGate();
  const rightRelease = deferredGate();

  const leftRun = left.enqueue("left", 1, async () => {
    leftStarted.resolve();
    await leftRelease.promise;
    return "left";
  });
  const rightRun = right.enqueue("right", 1, async () => {
    rightStarted.resolve();
    await rightRelease.promise;
    return "right";
  });

  await Promise.all([leftStarted.promise, rightStarted.promise]);
  leftRelease.resolve();
  rightRelease.resolve();

  const both = await Promise.all([leftRun, rightRun]);
  assert.equal(both.sort().join("|"), "left|right");
});

test("SessionCommandPump requires strict constructor bounds", () => {
  assert.throws(() => new SessionCommandPump({ maxItems: 0 }), /invalid_command_size/);
  assert.throws(() => new SessionCommandPump({ maxItems: -1 }), /invalid_command_size/);
  assert.throws(() => new SessionCommandPump({ maxItems: 1.5 }), /invalid_command_size/);
  assert.throws(() => new SessionCommandPump({ maxItems: Number.NaN }), /invalid_command_size/);
  assert.throws(() => new SessionCommandPump({ maxItems: Number.MAX_SAFE_INTEGER + 1 }), /invalid_command_size/);

  assert.throws(() => new SessionCommandPump({ maxBytes: 0 }), /invalid_command_size/);
  assert.throws(() => new SessionCommandPump({ maxBytes: -1 }), /invalid_command_size/);
  assert.throws(() => new SessionCommandPump({ maxBytes: 1.5 }), /invalid_command_size/);
  assert.throws(() => new SessionCommandPump({ maxBytes: Number.NaN }), /invalid_command_size/);
  assert.throws(() => new SessionCommandPump({ maxBytes: Number.MAX_SAFE_INTEGER + 1 }), /invalid_command_size/);
});

test("SessionCommandPump rejects invalid enqueue byte values", async () => {
  const pump = new SessionCommandPump({ maxItems: 4, maxBytes: 1024 });

  await assert.rejects(() => pump.enqueue("invalid-neg", -1, () => "nope"), /invalid_command_size/);
  await assert.rejects(() => pump.enqueue("invalid-float", 3.14, () => "nope"), /invalid_command_size/);
  await assert.rejects(() => pump.enqueue("invalid-string", "3", () => "nope"), /invalid_command_size/);
  await assert.rejects(() => pump.enqueue("invalid-nan", Number.NaN, () => "nope"), /invalid_command_size/);
});

test("SessionCommandPump enforces in-flight item boundaries (running + queued)", async () => {
  const pump = new SessionCommandPump({ maxItems: 2, maxBytes: 1024 });
  const running = deferredGate();
  const release = deferredGate();

  const first = pump.enqueue("first", 0, async () => {
    running.resolve();
    await release.promise;
    return "first";
  });

  await running.promise;
  const queued = pump.enqueue("queued", 0, () => "queued");
  await assert.rejects(() => pump.enqueue("overflow-item", 0, () => "nope"), /session_queue_full/);

  const during = pump.snapshot();
  assert.equal(during.runningCount, 1);
  assert.equal(during.queueLength, 1);
  assert.equal(during.queuedBytes, 0);

  release.resolve();
  const values = await Promise.all([first, queued]);
  assert.deepEqual(values, ["first", "queued"]);
});

test("SessionCommandPump enforces in-flight byte boundaries with 0/max/max+1", async () => {
  const pump = new SessionCommandPump({ maxItems: 8, maxBytes: 5 });
  const running = deferredGate();
  const release = deferredGate();

  const first = pump.enqueue("first", 3, async () => {
    running.resolve();
    await release.promise;
    return "first";
  });

  await running.promise;

  const zero = pump.enqueue("zero", 0, () => "zero");
  const max = pump.enqueue("max", 2, () => "max");
  await assert.rejects(() => pump.enqueue("overflow", 1, () => "nope"), /session_queue_full/);

  const during = pump.snapshot();
  assert.equal(during.runningBytes, 3);
  assert.equal(during.queuedBytes, 2);
  assert.equal(during.queueLength, 2);

  release.resolve();
  const values = await Promise.all([first, zero, max]);
  assert.deepEqual(values, ["first", "zero", "max"]);

  const final = pump.snapshot();
  assert.equal(final.queuedBytes, 0);
  assert.equal(final.runningBytes, 0);
  assert.equal(final.runningCount, 0);
});

test("SessionCommandPump waits for active work on close while rejecting queued work immediately", async () => {
  const pump = new SessionCommandPump({ maxItems: 4, maxBytes: 1024 });
  const firstRelease = deferredGate();
  const started = deferredGate();

  const first = pump.enqueue("first", 1, async () => {
    started.resolve();
    await firstRelease.promise;
    return "first";
  });

  await started.promise;
  const queued = pump.enqueue("queued", 1, () => "queued");
  const close = pump.closeAfterCurrent();
  const closeTwin = pump.closeAfterCurrent();
  assert.equal(close, closeTwin);

  let queuedRejected = false;
  queued.catch((error) => {
    queuedRejected = error.code === "session_finalizing";
  });
  await assert.rejects(() => queued, /session_finalizing/);
  assert.equal(queuedRejected, true);

  const duringClose = pump.snapshot();
  assert.equal(duringClose.running, true);
  assert.equal(duringClose.queueLength, 0);
  assert.equal(duringClose.queuedBytes, 0);

  firstRelease.resolve();
  assert.equal(await first, "first");
  await close;
});

test("SessionCommandPump closeAfterCurrent resolves immediately when idle and is idempotent", async () => {
  const pump = new SessionCommandPump({ maxItems: 4, maxBytes: 1024 });

  const firstClose = pump.closeAfterCurrent();
  const secondClose = pump.closeAfterCurrent();
  assert.equal(firstClose, secondClose);

  let resolved = false;
  firstClose.then(() => {
    resolved = true;
  });
  await Promise.resolve();
  assert.equal(resolved, true);

  await firstClose;
  await assert.rejects(() => pump.enqueue("after-close", 1, () => "never"), /session_finalizing/);
});

test("SessionCommandPump supports reentrant enqueue and keeps FIFO order", async () => {
  const pump = new SessionCommandPump({ maxItems: 4, maxBytes: 1024 });
  const release = deferredGate();
  const rootStarted = deferredGate();
  const reentrantReady = deferredGate();
  const timeline = [];

  let reentrant;
  const root = pump.enqueue("root", 1, async () => {
    timeline.push("root");
    rootStarted.resolve();
    await release.promise;
    reentrant = pump.enqueue("reentrant", 1, () => {
      timeline.push("reentrant");
      return "reentrant";
    });
    reentrantReady.resolve();
    return "root";
  });

  const queued = pump.enqueue("queued", 1, () => {
    timeline.push("queued");
    return "queued";
  });

  await rootStarted.promise;
  release.resolve();
  await reentrantReady.promise;

  const values = await Promise.all([root, queued, reentrant]);
  assert.deepEqual(values, ["root", "queued", "reentrant"]);
  assert.deepEqual(timeline, ["root", "queued", "reentrant"]);
});

test("SessionCommandPump settles sync/async failures and thenable `then` throws", async () => {
  const pump = new SessionCommandPump({ maxItems: 8, maxBytes: 1024 });
  const thenableRejected = pump.enqueue("thenable", 1, () => ({
    then() {
      throw new Error("then-throws");
    },
  }));
  const syncRejected = pump.enqueue("sync", 1, () => {
    throw new Error("sync-failure");
  });
  const asyncRejected = pump.enqueue("async", 1, async () => {
    throw new Error("async-failure");
  });
  const success = pump.enqueue("success", 1, () => "ok");

  thenableRejected.catch(() => {});
  syncRejected.catch(() => {});
  asyncRejected.catch(() => {});

  await assert.rejects(() => thenableRejected, /then-throws/);
  await assert.rejects(() => syncRejected, /sync-failure/);
  await assert.rejects(() => asyncRejected, /async-failure/);
  assert.equal(await success, "ok");

  const final = pump.snapshot();
  assert.equal(final.queuedBytes, 0);
  assert.equal(final.runningBytes, 0);
});

test("SessionCommandPump exposes bounded diagnostics without payload content", async () => {
  const pump = new SessionCommandPump({ maxItems: 2, maxBytes: 8 });
  const release = deferredGate();
  const firstStarted = deferredGate();

  const first = pump.enqueue("first", 3, async () => {
    firstStarted.resolve();
    await release.promise;
    return "first";
  });

  await firstStarted.promise;
  const second = pump.enqueue("second", 5, () => "second");

  const snapshot = pump.snapshot();
  assert.equal(snapshot.running, true);
  assert.equal(snapshot.runningCount, 1);
  assert.equal(snapshot.runningBytes, 3);
  assert.equal(snapshot.queueLength, 1);
  assert.equal(snapshot.queuedBytes, 5);
  assert.equal(snapshot.maxItems, 2);
  assert.equal(snapshot.maxBytes, 8);
  assert.equal(snapshot.closed, false);
  assert.equal("queue" in snapshot, false);
  assert.equal("items" in snapshot, false);

  release.resolve();
  await Promise.all([first, second]);
});
