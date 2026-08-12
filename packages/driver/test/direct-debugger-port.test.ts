import assert from "node:assert/strict";
import test from "node:test";

import {
  createDirectDebuggerPort,
  type BrowserLevelTransport,
  type BrowserTransportEvent,
  type BrowserTransportEventListener,
  type DirectDebuggerPortError,
} from "../src/direct-debugger-port.ts";

type RecordValue = Record<string, unknown>;

type TransportCall = Readonly<{
  method: string;
  params: RecordValue;
  sessionId: string | null | undefined;
}>;

function createTransport() {
  const calls: TransportCall[] = [];
  const listeners = new Set<BrowserTransportEventListener>();
  const staleListeners: BrowserTransportEventListener[] = [];
  let rootSessionId = "root-session-1";
  let failure: Error | null = null;
  let subscriptionFailure: Error | null = null;
  let attachEvents: BrowserTransportEvent[] = [];
  let callObserver: ((call: TransportCall) => void) | null = null;

  const transport: BrowserLevelTransport = {
    async send(method, params, sessionId) {
      const call = { method, params, sessionId };
      calls.push(call);
      callObserver?.(call);
      if (failure) {
        const current = failure;
        failure = null;
        throw current;
      }
      if (method === "Target.attachToTarget") {
        for (const event of attachEvents) {
          for (const listener of [...listeners]) void Promise.resolve(listener(event)).catch(() => {});
        }
        attachEvents = [];
        return { sessionId: rootSessionId };
      }
      return { acknowledged: true };
    },
    onEvent(listener) {
      if (subscriptionFailure) {
        const current = subscriptionFailure;
        subscriptionFailure = null;
        throw current;
      }
      listeners.add(listener);
      staleListeners.push(listener);
      return () => listeners.delete(listener);
    },
  };

  return {
    calls,
    listeners,
    staleListeners,
    transport,
    failNext(error: Error) { failure = error; },
    failSubscription(error: Error) { subscriptionFailure = error; },
    setRootSession(value: string) { rootSessionId = value; },
    setAttachEvent(event: BrowserTransportEvent) { attachEvents = [event]; },
    setAttachEvents(events: BrowserTransportEvent[]) { attachEvents = [...events]; },
    observeCalls(observer: (call: TransportCall) => void) { callObserver = observer; },
    emit(method: string, params: RecordValue, sessionId?: string | null) {
      const event = { method, params, sessionId: sessionId ?? null };
      for (const listener of [...listeners]) void listener(event);
    },
    async emitAndWait(method: string, params: RecordValue, sessionId?: string | null) {
      const event = { method, params, sessionId: sessionId ?? null };
      await Promise.all([...listeners].map((listener) => listener(event)));
    },
    emitCaptured(method: string, params: RecordValue, sessionId?: string | null): Promise<void>[] {
      const event = { method, params, sessionId: sessionId ?? null };
      return [...listeners].map((listener) => {
        try {
          return Promise.resolve(listener(event));
        } catch (error) {
          return Promise.reject(error);
        }
      });
    },
  };
}

function expectCode(error: unknown, code: DirectDebuggerPortError["code"]): boolean {
  assert.equal((error as Partial<DirectDebuggerPortError>).code, code);
  return true;
}

test("validates ownership and attaches the exact target with flattening", async () => {
  const fake = createTransport();
  assert.throws(
    () => createDirectDebuggerPort({ transport: fake.transport, rootTargetId: "bad target", tabId: 7 }),
    /direct_debugger_invalid_root_target/u,
  );
  assert.throws(
    () => createDirectDebuggerPort({ transport: fake.transport, rootTargetId: "target-1", tabId: -1 }),
    /direct_debugger_invalid_tab_id/u,
  );

  const port = createDirectDebuggerPort({ transport: fake.transport, rootTargetId: "target-1", tabId: 7 });
  await assert.rejects(port.sendCommand({ tabId: 7 }, "Page.enable", {}), (error) =>
    expectCode(error, "direct_debugger_not_attached"));
  const stopPreattachListener = port.onDebuggerEvent(() => undefined);
  stopPreattachListener();
  await assert.rejects(port.attach({ tabId: 8 }, "1.3"), (error) =>
    expectCode(error, "direct_debugger_wrong_tab"));
  await assert.rejects(port.attach({ tabId: 7 }, "1.2"), (error) =>
    expectCode(error, "direct_debugger_wrong_version"));
  assert.equal(fake.calls.length, 0);

  await port.attach({ tabId: 7 }, "1.3");
  assert.deepEqual(fake.calls, [{
    method: "Target.attachToTarget",
    params: { targetId: "target-1", flatten: true },
    sessionId: null,
  }]);
  assert.equal(fake.listeners.size, 1);
  await assert.rejects(port.attach({ tabId: 7 }, "1.3"), (error) =>
    expectCode(error, "direct_debugger_already_attached"));
});

test("maps root, child, and synthetic browser commands without exposing a real browser session", async () => {
  const fake = createTransport();
  const port = createDirectDebuggerPort({ transport: fake.transport, rootTargetId: "target-2", tabId: 9 });
  await port.attach({ tabId: 9 }, "1.3");
  fake.calls.length = 0;

  await port.sendCommand({ tabId: 9 }, "Page.enable", {});
  await port.sendCommand({ tabId: 9, sessionId: "child-session" }, "Runtime.enable", {});
  const attached = await port.sendCommand({ tabId: 9 }, "Target.attachToBrowserTarget", {});
  const token = attached.sessionId;
  assert.equal(typeof token, "string");
  assert.match(token as string, /^newton-direct-browser:/u);
  await port.sendCommand(
    { tabId: 9, sessionId: token as string },
    "Target.autoAttachRelated",
    { targetId: "target-2", waitForDebuggerOnStart: true },
  );
  await port.sendCommand({ tabId: 9 }, "Target.detachFromTarget", { sessionId: token });

  assert.deepEqual(fake.calls, [
    { method: "Page.enable", params: {}, sessionId: "root-session-1" },
    { method: "Runtime.enable", params: {}, sessionId: "child-session" },
    {
      method: "Target.autoAttachRelated",
      params: { targetId: "target-2", waitForDebuggerOnStart: true },
      sessionId: null,
    },
  ]);

  await assert.rejects(
    port.sendCommand({ tabId: 9, sessionId: token as string }, "Runtime.enable", {}),
    (error) => expectCode(error, "direct_debugger_forged_session"),
  );
  await assert.rejects(
    port.sendCommand({ tabId: 9, sessionId: "newton-direct-browser:forged" }, "Target.setAutoAttach", {}),
    (error) => expectCode(error, "direct_debugger_forged_session"),
  );
  await assert.rejects(
    port.sendCommand({ tabId: 9, sessionId: token as string }, "Target.attachToBrowserTarget", {}),
    (error) => expectCode(error, "direct_debugger_already_attached"),
  );
  await assert.rejects(
    port.sendCommand({ tabId: 9 }, "Target.attachToBrowserTarget", { unexpected: true }),
    (error) => expectCode(error, "direct_debugger_invalid_params"),
  );
});

test("maps ordered events and suppresses malformed, forged, unsubscribed, and stale events", async () => {
  const fake = createTransport();
  const port = createDirectDebuggerPort({ transport: fake.transport, rootTargetId: "target-3", tabId: 11 });
  await port.attach({ tabId: 11 }, "1.3");
  const token = (await port.sendCommand({ tabId: 11 }, "Target.attachToBrowserTarget", {})).sessionId as string;
  const deliveries: Array<Readonly<{ listener: string; source: unknown; method: string }>> = [];
  const stopFirst = port.onDebuggerEvent((source, method) => {
    deliveries.push({ listener: "first", source, method });
    if (method === "Page.first") throw new Error("listener failure");
  });
  let finishDelivery: (() => void) | null = null;
  const deliveryFinished = new Promise<void>((resolve) => { finishDelivery = resolve; });
  port.onDebuggerEvent((source, method) => {
    deliveries.push({ listener: "second", source, method });
    if (method === "Page.second") finishDelivery?.();
  });

  fake.emit("Target.created", {}, null);
  fake.emit("Page.first", {}, "root-session-1");
  fake.emit("Runtime.consoleAPICalled", {}, "child-1");
  fake.emit("bad method", {}, "child-1");
  fake.emit("Target.created", {}, "newton-direct-browser:forged");
  stopFirst();
  fake.emit("Page.second", {}, "root-session-1");
  await deliveryFinished;

  assert.deepEqual(deliveries, [
    { listener: "first", source: { tabId: 11, sessionId: token }, method: "Target.created" },
    { listener: "second", source: { tabId: 11, sessionId: token }, method: "Target.created" },
    { listener: "first", source: { tabId: 11 }, method: "Page.first" },
    { listener: "second", source: { tabId: 11 }, method: "Page.first" },
    { listener: "first", source: { tabId: 11, sessionId: "child-1" }, method: "Runtime.consoleAPICalled" },
    { listener: "second", source: { tabId: 11, sessionId: "child-1" }, method: "Runtime.consoleAPICalled" },
    { listener: "second", source: { tabId: 11 }, method: "Page.second" },
  ]);

  const staleListener = fake.staleListeners[0];
  assert.ok(staleListener);
  await port.detach({ tabId: 11 });
  assert.equal(fake.listeners.size, 0);
  await staleListener({ method: "Page.stale", params: {}, sessionId: "root-session-1" });
  assert.equal(deliveries.length, 7);
  await assert.rejects(port.sendCommand({ tabId: 11 }, "Page.enable", {}), (error) =>
    expectCode(error, "direct_debugger_not_attached"));
});

test("retains preattach listeners and awaits asynchronous listeners in event order", async () => {
  const fake = createTransport();
  const port = createDirectDebuggerPort({ transport: fake.transport, rootTargetId: "target-async", tabId: 12 });
  const order: string[] = [];
  let releaseFirst: () => void = () => assert.fail("first gate was not initialized");
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let firstStarted: (() => void) | null = null;
  const firstStartedSignal = new Promise<void>((resolve) => { firstStarted = resolve; });
  let secondFinished: (() => void) | null = null;
  const secondFinishedSignal = new Promise<void>((resolve) => { secondFinished = resolve; });

  port.onDebuggerEvent(async (_source, method) => {
    order.push(`${method}:start`);
    if (method === "Page.first") {
      firstStarted?.();
      await firstGate;
    }
    order.push(`${method}:end`);
    if (method === "Page.second") secondFinished?.();
  });
  await port.attach({ tabId: 12 }, "1.3");
  let firstTransportDeliveryFinished = false;
  const firstTransportDelivery = fake.emitAndWait("Page.first", {}, "root-session-1")
    .then(() => { firstTransportDeliveryFinished = true; });
  const secondTransportDelivery = fake.emitAndWait("Page.second", {}, "root-session-1");
  await firstStartedSignal;
  assert.deepEqual(order, ["Page.first:start"]);
  assert.equal(firstTransportDeliveryFinished, false);
  releaseFirst();
  await Promise.all([firstTransportDelivery, secondTransportDelivery, secondFinishedSignal]);
  assert.equal(firstTransportDeliveryFinished, true);
  assert.deepEqual(order, [
    "Page.first:start",
    "Page.first:end",
    "Page.second:start",
    "Page.second:end",
  ]);
});

test("uses the real event-object shape and preserves an event received while attach is pending", async () => {
  const fake = createTransport();
  const port = createDirectDebuggerPort({ transport: fake.transport, rootTargetId: "target-during-attach", tabId: 14 });
  let delivered: (() => void) | null = null;
  const deliveredSignal = new Promise<void>((resolve) => { delivered = resolve; });
  const observed: Array<Readonly<{ source: unknown; method: string; params: RecordValue }>> = [];
  port.onDebuggerEvent((source, method, params) => {
    observed.push({ source, method, params });
    delivered?.();
  });
  fake.setAttachEvent({
    method: "Page.frameAttached",
    params: { frameId: "bounded-frame" },
    sessionId: "root-session-1",
  });

  await port.attach({ tabId: 14 }, "1.3");
  await deliveredSignal;
  assert.deepEqual(observed, [{
    source: { tabId: 14 },
    method: "Page.frameAttached",
    params: { frameId: "bounded-frame" },
  }]);
});

test("retains attachment after uncertain detach and retries the exact root detach", async () => {
  const fake = createTransport();
  const port = createDirectDebuggerPort({ transport: fake.transport, rootTargetId: "target-4", tabId: 13 });
  await port.attach({ tabId: 13 }, "1.3");
  fake.calls.length = 0;
  fake.failNext(new Error("ambiguous transport failure"));

  await assert.rejects(port.detach({ tabId: 13 }), (error) => {
    const typed = error as DirectDebuggerPortError;
    assert.equal(typed.code, "direct_debugger_detach_uncertain");
    assert.equal(typed.retryable, true);
    assert.equal(typed.uncertain, true);
    return true;
  });
  await port.sendCommand({ tabId: 13 }, "Page.enable", {});
  await port.detach({ tabId: 13 });
  assert.deepEqual(fake.calls.map(({ method, sessionId }) => ({ method, sessionId })), [
    { method: "Target.detachFromTarget", sessionId: null },
    { method: "Page.enable", sessionId: "root-session-1" },
    { method: "Target.detachFromTarget", sessionId: null },
  ]);

  fake.setRootSession("root-session-2");
  await port.attach({ tabId: 13 }, "1.3");
  await port.sendCommand({ tabId: 13 }, "Page.enable", {});
  assert.equal(fake.calls.at(-1)?.sessionId, "root-session-2");
});

test("detach waits for active delivery and invalidates queued events before cleanup", async () => {
  const fake = createTransport();
  const port = createDirectDebuggerPort({ transport: fake.transport, rootTargetId: "target-drain", tabId: 16 });
  let releaseDelivery: () => void = () => assert.fail("delivery gate was not initialized");
  const deliveryGate = new Promise<void>((resolve) => { releaseDelivery = resolve; });
  let deliveryStarted: (() => void) | null = null;
  const deliveryStartedSignal = new Promise<void>((resolve) => { deliveryStarted = resolve; });
  let detachSent: (() => void) | null = null;
  const detachSentSignal = new Promise<void>((resolve) => { detachSent = resolve; });
  const delivered: string[] = [];
  let detachFinished = false;

  port.onDebuggerEvent(async (_source, method) => {
    delivered.push(method);
    if (method === "Page.blocked") {
      deliveryStarted?.();
      await deliveryGate;
    }
  });
  await port.attach({ tabId: 16 }, "1.3");
  fake.observeCalls((call) => {
    if (call.method === "Target.detachFromTarget") detachSent?.();
  });
  fake.emit("Page.blocked", {}, "root-session-1");
  fake.emit("Page.queued", {}, "root-session-1");
  await deliveryStartedSignal;

  const detaching = port.detach({ tabId: 16 }).then(() => { detachFinished = true; });
  await detachSentSignal;
  assert.equal(detachFinished, false);
  releaseDelivery();
  await detaching;
  assert.equal(detachFinished, true);
  assert.deepEqual(delivered, ["Page.blocked"]);
  assert.equal(fake.listeners.size, 0);
});

test("event overflow permanently fails commands closed while retaining detach cleanup", async () => {
  const fake = createTransport();
  const port = createDirectDebuggerPort({ transport: fake.transport, rootTargetId: "target-overflow", tabId: 18 });
  let releaseDelivery: () => void = () => assert.fail("overflow gate was not initialized");
  const deliveryGate = new Promise<void>((resolve) => { releaseDelivery = resolve; });
  let deliveryStarted: (() => void) | null = null;
  const deliveryStartedSignal = new Promise<void>((resolve) => { deliveryStarted = resolve; });

  port.onDebuggerEvent(async (_source, method) => {
    if (method === "Page.blocked") {
      deliveryStarted?.();
      await deliveryGate;
    }
  });
  await port.attach({ tabId: 18 }, "1.3");
  const pendingDeliveries: Promise<void>[] = [];
  pendingDeliveries.push(...fake.emitCaptured("Page.blocked", {}, "root-session-1"));
  for (let index = 1; index < 256; index += 1) {
    pendingDeliveries.push(...fake.emitCaptured("Page.queued", { index }, "root-session-1"));
  }
  const overflow = fake.emitCaptured("Page.overflow", {}, "root-session-1");
  assert.equal(overflow.length, 1);
  const overflowDelivery = overflow[0];
  assert.ok(overflowDelivery);
  await assert.rejects(overflowDelivery, (error: unknown) => expectCode(error, "direct_debugger_event_overflow"));
  await assert.rejects(port.sendCommand({ tabId: 18 }, "Page.enable", {}), (error) =>
    expectCode(error, "direct_debugger_event_overflow"));
  await deliveryStartedSignal;

  const detaching = port.detach({ tabId: 18 });
  releaseDelivery();
  await detaching;
  await Promise.all(pendingDeliveries);
  assert.equal(fake.listeners.size, 0);
  await assert.rejects(port.attach({ tabId: 18 }, "1.3"), (error) =>
    expectCode(error, "direct_debugger_event_overflow"));
  assert.equal(fake.calls.some((call) => call.method === "Page.enable"), false);
  assert.equal(fake.calls.filter((call) => call.method === "Target.detachFromTarget").length, 1);
});

test("provisional event overflow fails attach and detaches the confirmed root", async () => {
  const fake = createTransport();
  const port = createDirectDebuggerPort({ transport: fake.transport, rootTargetId: "target-attach-overflow", tabId: 19 });
  fake.setAttachEvents(Array.from({ length: 257 }, (_value, index) => ({
    method: "Page.frameAttached",
    params: { index },
    sessionId: "root-session-1",
  })));

  await assert.rejects(port.attach({ tabId: 19 }, "1.3"), (error) =>
    expectCode(error, "direct_debugger_event_overflow"));
  assert.equal(fake.listeners.size, 0);
  assert.deepEqual(fake.calls.map((call) => call.method), [
    "Target.attachToTarget",
    "Target.detachFromTarget",
  ]);
  await assert.rejects(port.attach({ tabId: 19 }, "1.3"), (error) =>
    expectCode(error, "direct_debugger_event_overflow"));
  assert.equal(fake.calls.length, 2);
});

test("does not attach when event subscription fails and classifies transport closure", async () => {
  const fake = createTransport();
  const port = createDirectDebuggerPort({ transport: fake.transport, rootTargetId: "target-5", tabId: 15 });
  fake.failSubscription(new Error("subscription failed"));
  await assert.rejects(port.attach({ tabId: 15 }, "1.3"), (error) =>
    expectCode(error, "direct_debugger_attach_failed"));
  assert.deepEqual(fake.calls, []);

  await port.attach({ tabId: 15 }, "1.3");
  const closed = Object.assign(new Error("closed"), { code: "transport_closed" });
  fake.failNext(closed);
  await assert.rejects(port.sendCommand({ tabId: 15 }, "Page.enable", {}), (error) => {
    const typed = error as DirectDebuggerPortError;
    assert.equal(typed.code, "direct_debugger_transport_closed");
    assert.equal(typed.retryable, true);
    return true;
  });
});
