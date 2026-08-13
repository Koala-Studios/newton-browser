import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { once } from "node:events";

import { CdpPipeTransport, CdpTransportError } from "../../src/browser-runtime/cdp-pipe.ts";

function frame(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\0`, "utf8");
}

test("correlates split response frames and preserves child session routing", async () => {
  const fromBrowser = new PassThrough();
  const toBrowser = new PassThrough();
  const transport = new CdpPipeTransport(fromBrowser, toBrowser);
  const writes: Buffer[] = [];
  toBrowser.on("data", (chunk) => writes.push(Buffer.from(chunk as Buffer)));

  const pending = transport.send("Runtime.evaluate", { expression: "1" }, "child-1");
  await new Promise<void>((resolve) => setImmediate(resolve));
  const command = JSON.parse(Buffer.concat(writes).subarray(0, -1).toString("utf8"));
  assert.equal(command.method, "Runtime.evaluate");
  assert.equal(command.sessionId, "child-1");

  const response = frame({ id: command.id, result: { value: 1 } });
  fromBrowser.write(response.subarray(0, 3));
  fromBrowser.write(response.subarray(3));
  assert.deepEqual(await pending, { value: 1 });
  assert.equal(transport.pendingRequestCount, 0);
  transport.close();
});

test("parses coalesced events and responses in exact order", async () => {
  const fromBrowser = new PassThrough();
  const toBrowser = new PassThrough();
  const transport = new CdpPipeTransport(fromBrowser, toBrowser);
  const events: string[] = [];
  transport.onEvent((event) => events.push(`${event.sessionId}:${event.method}`));
  const writtenPromise = once(toBrowser, "data");
  const commandPromise = transport.send("Browser.getVersion");
  const [written] = await writtenPromise as [Buffer];
  const id = JSON.parse(written.subarray(0, -1).toString("utf8")).id;

  fromBrowser.write(Buffer.concat([
    frame({ method: "Target.attachedToTarget", sessionId: "s1", params: { waitingForDebugger: true } }),
    frame({ id, result: { protocolVersion: "1.3" } }),
    frame({ method: "Page.loadEventFired", params: {} }),
  ]));
  assert.deepEqual(await commandPromise, { protocolVersion: "1.3" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["s1:Target.attachedToTarget", "null:Page.loadEventFired"]);
  transport.close();
});

test("accepts a coalesced chunk whose aggregate exceeds the per-frame limit", async () => {
  const fromBrowser = new PassThrough();
  const toBrowser = new PassThrough();
  const transport = new CdpPipeTransport(fromBrowser, toBrowser, { maxMessageBytes: 80 });
  const events: string[] = [];
  transport.onEvent((event) => events.push(event.method));
  fromBrowser.write(Buffer.concat([
    frame({ method: "A.first", params: { value: "x".repeat(30) } }),
    frame({ method: "A.second", params: { value: "y".repeat(30) } }),
  ]));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(transport.closed, false);
  assert.deepEqual(events, ["A.first", "A.second"]);
  transport.close();
});

test("terminally rejects unknown and duplicate completed response IDs", async () => {
  for (const duplicate of [false, true]) {
    const fromBrowser = new PassThrough();
    const toBrowser = new PassThrough();
    const writes: Buffer[] = [];
    toBrowser.on("data", (chunk) => writes.push(Buffer.from(chunk as Buffer)));
    const transport = new CdpPipeTransport(fromBrowser, toBrowser);
    const first = transport.send("A.first");
    await new Promise<void>((resolve) => setImmediate(resolve));
    const firstId = JSON.parse(Buffer.concat(writes).subarray(0, -1).toString("utf8")).id;
    if (duplicate) {
      fromBrowser.write(frame({ id: firstId, result: {} }));
      await first;
    }
    const pending = transport.send("A.pending");
    fromBrowser.write(frame({ id: duplicate ? firstId : firstId + 1000, result: {} }));
    const error = await pending.catch((value: unknown) => value);
    assert.ok(error instanceof CdpTransportError);
    assert.equal(error.code, "cdp_invalid_frame");
    assert.equal(transport.closed, true);
    if (!duplicate) await first.catch(() => {});
  }
});

test("serializes bounded event delivery, isolates rejection, and honors unsubscribe", async () => {
  const fromBrowser = new PassThrough();
  const transport = new CdpPipeTransport(fromBrowser, new PassThrough(), { maxEventQueue: 2, maxListeners: 3 });
  const order: string[] = [];
  let releaseFirst: (() => void) | undefined;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  transport.onEvent(async (event) => {
    order.push(`start:${event.method}`);
    if (event.method === "A.first") await firstGate;
    order.push(`end:${event.method}`);
  });
  transport.onEvent(() => { throw new Error("isolated listener detail"); });
  const unsubscribe = transport.onEvent((event) => { order.push(`removed:${event.method}`); });
  fromBrowser.write(frame({ method: "A.first" }));
  unsubscribe();
  fromBrowser.write(frame({ method: "A.second" }));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["start:A.first"]);
  releaseFirst?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["start:A.first", "end:A.first", "start:A.second", "end:A.second"]);
  assert.equal(transport.closed, false);
  transport.close();
});

test("terminally fails when the bounded event queue or listener set overflows", async () => {
  {
    const fromBrowser = new PassThrough();
    const toBrowser = new PassThrough();
    toBrowser.resume();
    const transport = new CdpPipeTransport(fromBrowser, toBrowser, { maxEventQueue: 1 });
    transport.onEvent(() => new Promise<void>(() => {}));
    const pending = transport.send("A.pending");
    fromBrowser.write(frame({ method: "A.first" }));
    fromBrowser.write(frame({ method: "A.second" }));
    fromBrowser.write(frame({ method: "A.third" }));
    const error = await pending.catch((value: unknown) => value);
    assert.ok(error instanceof CdpTransportError);
    assert.equal(error.code, "cdp_event_queue_overflow");
  }
  {
    const transport = new CdpPipeTransport(new PassThrough(), new PassThrough(), { maxListeners: 1 });
    transport.onEvent(() => {});
    transport.onEvent(() => {});
    assert.equal(transport.closed, true);
    const error = await transport.send("A.after").catch((value: unknown) => value);
    assert.ok(error instanceof CdpTransportError);
    assert.equal(error.code, "cdp_event_listener_limit");
  }
});

test("rejects malformed, oversized, and incomplete EOF without leaking frame content", async () => {
  for (const scenario of ["malformed", "oversized", "incomplete"] as const) {
    const fromBrowser = new PassThrough();
    const toBrowser = new PassThrough();
    const transport = new CdpPipeTransport(fromBrowser, toBrowser, { maxMessageBytes: 32 });
    const pending = transport.send("A.b");
    toBrowser.resume();
    if (scenario === "malformed") fromBrowser.write(Buffer.from('{"secret":"TOKEN",}\0'));
    if (scenario === "oversized") fromBrowser.write(Buffer.alloc(34, 0x61));
    if (scenario === "incomplete") fromBrowser.end(Buffer.from('{"secret":"TOKEN"'));
    const error = await pending.catch((value: unknown) => value);
    assert.ok(error instanceof CdpTransportError);
    assert.equal(error.message.includes("TOKEN"), false);
    assert.equal(transport.pendingRequestCount, 0);
  }
});

test("enforces the pending cap and rejects every pending command on closure", async () => {
  const fromBrowser = new PassThrough();
  const toBrowser = new PassThrough();
  toBrowser.resume();
  const transport = new CdpPipeTransport(fromBrowser, toBrowser, { maxPendingRequests: 2 });
  const first = transport.send("A.one");
  const second = transport.send("A.two");
  const capped = await transport.send("A.three").catch((error: unknown) => error);
  assert.ok(capped instanceof CdpTransportError);
  assert.equal(capped.code, "cdp_pending_limit");
  fromBrowser.end();
  const failures = await Promise.all([first.catch((error) => error), second.catch((error) => error)]);
  assert.deepEqual(failures.map((error) => error.code), ["cdp_transport_closed", "cdp_transport_closed"]);
});

test("serializes writes across writable backpressure", async () => {
  const fromBrowser = new PassThrough();
  const observed: Buffer[] = [];
  const callbacks: Array<() => void> = [];
  const writable = new Writable({
    highWaterMark: 1,
    write(chunk, _encoding, callback) {
      observed.push(Buffer.from(chunk as Buffer));
      callbacks.push(callback);
    },
  });
  const transport = new CdpPipeTransport(fromBrowser, writable);
  const first = transport.send("A.one");
  const second = transport.send("A.two");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(observed.length, 1);
  const drained = once(writable, "drain");
  callbacks.shift()?.();
  await drained;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(observed.length, 2);
  callbacks.shift()?.();
  transport.close();
  await Promise.all([first.catch(() => {}), second.catch(() => {})]);
});
