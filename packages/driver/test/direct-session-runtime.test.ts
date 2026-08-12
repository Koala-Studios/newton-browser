import test from "node:test";
import assert from "node:assert/strict";

import { startDirectDriverSession } from "../dist/direct-session-runtime.js";

type Deferred<T = void> = {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
};

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("real direct composition attaches, installs containment, commits initial navigation, and uses no extension globals", async () => {
  const originalChrome = globalThis.chrome;
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: new Proxy({}, { get() { throw new Error("extension global accessed"); } }),
  });
  const transport = new FakeBrowserTransport();
  try {
    const runtime = await startDirectDriverSession({
      bootstrap: { transport, rootTargetId: "root-target", syntheticTabId: 71 },
      primaryOrigin: "https://example.com",
      allowedOrigins: ["https://assets.example.com"],
      initialUrl: "https://example.com/start?direct=1",
    });

    assert.deepEqual(runtime.snapshot(), {
      state: "active",
      runningCommands: 0,
      queuedCommands: 0,
      runningBytes: 0,
      queuedBytes: 0,
      queueClosed: false,
    });
    assert.equal(JSON.stringify(runtime), "{}", "transport and driver identities are not enumerable runtime state");
    const methods = transport.calls.map((call) => call.method);
    assert.equal(methods[0], "Target.attachToTarget");
    assert.ok(methods.indexOf("Fetch.enable") > methods.indexOf("Target.attachToTarget"));
    assert.ok(methods.indexOf("Page.navigate") > methods.indexOf("Fetch.enable"));
    const browserAutoAttach = transport.calls.find((call) => call.method === "Target.setAutoAttach"
      && call.sessionId === null && Array.isArray(call.params.filter));
    assert.deepEqual(browserAutoAttach?.params.filter, [
      { type: "page", exclude: false },
      { exclude: true },
    ]);
    const childAutoAttach = transport.calls.find((call) => call.method === "Target.setAutoAttach"
      && call.sessionId === "root-session" && Array.isArray(call.params.filter));
    assert.deepEqual(childAutoAttach?.params.filter, [
      { type: "iframe", exclude: false },
      { type: "worker", exclude: false },
      { type: "shared_worker", exclude: false },
      { type: "service_worker", exclude: false },
      { exclude: true },
    ]);
    assert.equal(transport.calls.find((call) => call.method === "Page.navigate")?.params.url, "https://example.com/start?direct=1");
    assert.equal(transport.emittedNavigation, true);

    await runtime.stop();
    assert.equal(runtime.snapshot().state, "stopped");
    assert.deepEqual(transport.calls.at(-1), {
      method: "Target.detachFromTarget",
      params: { sessionId: "root-session" },
      sessionId: null,
    });
  } finally {
    if (originalChrome === undefined) delete globalThis.chrome;
    else Object.defineProperty(globalThis, "chrome", { configurable: true, value: originalChrome });
  }
});

test("start publishes only after initial observation completes", async () => {
  const observationStarted = deferred();
  const releaseObservation = deferred();
  const order: string[] = [];
  const observation = { origin: "https://example.com", title: "Ready", nodes: [] };
  const driver = stubDriver({
    async observe() {
      order.push("observe:start");
      observationStarted.resolve();
      await releaseObservation.promise;
      order.push("observe:end");
      return observation;
    },
  }, order);
  let published = false;
  const starting = startDirectDriverSession({
    ...validOptions(),
    initialObservation: true,
    driverFactory: () => driver,
  }).then((runtime) => {
    published = true;
    return runtime;
  });

  await observationStarted.promise;
  assert.equal(published, false);
  assert.deepEqual(order, ["attach", "navigate", "observe:start"]);
  releaseObservation.resolve();
  const runtime = await starting;
  assert.equal(runtime.initialObservation, observation);
  assert.deepEqual(order, ["attach", "navigate", "observe:start", "observe:end"]);
  await runtime.stop();
});

test("one direct runtime executes commands FIFO with exact serialized byte accounting", async () => {
  const firstStarted = deferred();
  const releaseFirst = deferred();
  const executionOrder: string[] = [];
  const driver = stubDriver({
    async executeAction(action) {
      const key = String(action.key);
      executionOrder.push(`start:${key}`);
      if (key === "A") {
        firstStarted.resolve();
        await releaseFirst.promise;
      }
      executionOrder.push(`end:${key}`);
      return { key };
    },
  });
  const runtime = await startDirectDriverSession({ ...validOptions(), driverFactory: () => driver });
  const firstAction = { kind: "press" as const, key: "A" };
  const secondAction = { kind: "press" as const, key: "B" };
  const first = runtime.execute(firstAction, { commandId: "one" });
  await firstStarted.promise;
  const second = runtime.execute(secondAction, { commandId: "two" });
  const snapshot = runtime.snapshot();
  assert.equal(snapshot.runningCommands, 1);
  assert.equal(snapshot.queuedCommands, 1);
  assert.equal(snapshot.runningBytes, encodedBytes({ action: firstAction, context: { commandId: "one" } }));
  assert.equal(snapshot.queuedBytes, encodedBytes({ action: secondAction, context: { commandId: "two" } }));
  assert.deepEqual(executionOrder, ["start:A"]);

  releaseFirst.resolve();
  assert.deepEqual(await Promise.all([first, second]), [{ key: "A" }, { key: "B" }]);
  assert.deepEqual(executionOrder, ["start:A", "end:A", "start:B", "end:B"]);
  await runtime.stop();
});

test("direct runtime preflights each action before execution and does not execute rejected actions", async () => {
  const order: string[] = [];
  const invalidSelector = Object.assign(new Error("invalid_selector"), { code: "invalid_selector" });
  const driver = stubDriver({
    async preflightAction(action: { kind: string }) {
      order.push(`preflight:${action.kind}`);
      if (action.kind === "click") throw invalidSelector;
    },
    async executeAction(action: { kind: string }) {
      order.push(`execute:${action.kind}`);
      return { status: "verified" };
    },
  });
  const runtime = await startDirectDriverSession({ ...validOptions(), driverFactory: () => driver });

  await assert.rejects(
    runtime.execute({ kind: "click", target: { selector: "]" } }),
    (error) => error === invalidSelector,
  );
  assert.deepEqual(order, ["preflight:click"]);

  assert.deepEqual(await runtime.execute({ kind: "press", key: "A" }), { status: "verified" });
  assert.deepEqual(order, ["preflight:click", "preflight:press", "execute:press"]);
  await runtime.stop();
});

test("two direct runtimes execute concurrently without a shared mutex", async () => {
  const leftStarted = deferred();
  const rightStarted = deferred();
  const release = deferred();
  const left = await startDirectDriverSession({
    ...validOptions(81),
    driverFactory: () => stubDriver({
      async executeAction() { leftStarted.resolve(); await release.promise; return { side: "left" }; },
    }),
  });
  const right = await startDirectDriverSession({
    ...validOptions(82),
    driverFactory: () => stubDriver({
      async executeAction() { rightStarted.resolve(); await release.promise; return { side: "right" }; },
    }),
  });

  const leftCommand = left.execute({ kind: "press", key: "L" });
  const rightCommand = right.execute({ kind: "press", key: "R" });
  await Promise.all([leftStarted.promise, rightStarted.promise]);
  assert.equal(left.snapshot().runningCommands, 1);
  assert.equal(right.snapshot().runningCommands, 1);
  release.resolve();
  assert.deepEqual(await Promise.all([leftCommand, rightCommand]), [{ side: "left" }, { side: "right" }]);
  await Promise.all([left.stop(), right.stop()]);
});

test("start rollback detaches and surfaces cleanup uncertainty instead of the setup error", async () => {
  const setupError = Object.assign(new Error("initial_navigation_failed"), { code: "initial_navigation_failed" });
  const cleanupError = Object.assign(new Error("shutdown_detach_failed"), { code: "shutdown_detach_failed" });
  let detachCalls = 0;
  const cleanupFails = stubDriver({
    async navigateInitialGranted() { throw setupError; },
    async detach() { detachCalls += 1; throw cleanupError; },
  });
  await assert.rejects(
    startDirectDriverSession({ ...validOptions(), driverFactory: () => cleanupFails }),
    (error) => error === cleanupError,
  );
  assert.equal(detachCalls, 1);

  const cleanupSucceeds = stubDriver({
    async navigateInitialGranted() { throw setupError; },
    async detach() { detachCalls += 1; },
  });
  await assert.rejects(
    startDirectDriverSession({ ...validOptions(), driverFactory: () => cleanupSucceeds }),
    (error) => error === setupError,
  );
  assert.equal(detachCalls, 2);
});

test("stop fences queued work, awaits the running command, and retries an uncertain exact detach", async () => {
  const commandStarted = deferred();
  const releaseCommand = deferred();
  let detachCalls = 0;
  const detachError = Object.assign(new Error("shutdown_detach_failed"), { code: "shutdown_detach_failed" });
  const driver = stubDriver({
    async executeAction() {
      commandStarted.resolve();
      await releaseCommand.promise;
      return { done: true };
    },
    async detach() {
      detachCalls += 1;
      if (detachCalls === 1) throw detachError;
    },
  });
  const runtime = await startDirectDriverSession({ ...validOptions(), driverFactory: () => driver });
  const running = runtime.execute({ kind: "press", key: "A" });
  await commandStarted.promise;
  const queued = runtime.execute({ kind: "press", key: "B" });
  const stopping = runtime.stop();
  await assert.rejects(queued, (error) => error?.code === "session_finalizing");
  assert.deepEqual(runtime.snapshot(), {
    state: "stopping",
    runningCommands: 1,
    queuedCommands: 0,
    runningBytes: encodedBytes({ action: { kind: "press", key: "A" }, context: {} }),
    queuedBytes: 0,
    queueClosed: true,
  });
  assert.equal(detachCalls, 0);
  releaseCommand.resolve();
  await running;
  await assert.rejects(stopping, (error) => error === detachError);
  assert.equal(runtime.snapshot().state, "detach_uncertain");
  await assert.rejects(runtime.execute({ kind: "press", key: "C" }), (error) => error?.code === "session_finalizing");

  await runtime.stop();
  assert.equal(detachCalls, 2);
  assert.equal(runtime.snapshot().state, "stopped");
});

test("direct session validates exact bootstrap, normalized unique grants, and initial URL origin", async () => {
  const base = validOptions();
  await assert.rejects(
    startDirectDriverSession({ ...base, bootstrap: { ...base.bootstrap, extra: true } } as never),
    (error) => error?.code === "direct_session_invalid_bootstrap",
  );
  await assert.rejects(
    startDirectDriverSession({ ...base, allowedOrigins: [base.primaryOrigin] }),
    (error) => error?.code === "direct_session_invalid_origin_grant",
  );
  await assert.rejects(
    startDirectDriverSession({ ...base, primaryOrigin: "https://example.com/" }),
    (error) => error?.code === "direct_session_invalid_origin_grant",
  );
  await assert.rejects(
    startDirectDriverSession({ ...base, initialUrl: "https://outside.test/" }),
    (error) => error?.code === "direct_session_invalid_initial_url",
  );
});

class FakeBrowserTransport {
  calls: Array<{ method: string; params: Record<string, unknown>; sessionId: string | null }> = [];
  emittedNavigation = false;
  private listener: ((event: {
    method: string;
    params: Record<string, unknown>;
    sessionId: string | null;
  }) => void | Promise<void>) | null = null;

  onEvent(listener: (event: {
    method: string;
    params: Record<string, unknown>;
    sessionId: string | null;
  }) => void | Promise<void>): () => void {
    assert.equal(this.listener, null);
    this.listener = listener;
    return () => { this.listener = null; };
  }

  async send(method: string, params: Record<string, unknown>, sessionId: string | null = null): Promise<Record<string, unknown>> {
    this.calls.push({ method, params, sessionId });
    if (method === "Target.attachToTarget") return { sessionId: "root-session" };
    if (method === "Target.getTargetInfo") {
      return { targetInfo: { targetId: "root-target", type: "page", url: "https://example.com/start?direct=1" } };
    }
    if (method === "Page.getLayoutMetrics") return { visualViewport: { scale: 1 } };
    if (method === "Runtime.evaluate") return { result: { value: params.expression === "window.devicePixelRatio" ? 1 : "" } };
    if (method === "Page.navigate") {
      assert.equal(sessionId, "root-session");
      this.emittedNavigation = true;
      await this.listener?.({
        method: "Page.frameNavigated",
        params: {
          frame: {
            id: "main-frame",
            loaderId: "initial-loader",
            url: String(params.url),
          },
        },
        sessionId: "root-session",
      });
      return { frameId: "main-frame", loaderId: "initial-loader" };
    }
    return {};
  }
}

function validOptions(syntheticTabId = 71) {
  return {
    bootstrap: {
      transport: inertTransport(),
      rootTargetId: `root-${syntheticTabId}`,
      syntheticTabId,
    },
    primaryOrigin: "https://example.com",
    allowedOrigins: ["https://assets.example.com"],
    initialUrl: "https://example.com/start",
  };
}

function inertTransport() {
  return {
    async send() { return {}; },
    onEvent() { return () => {}; },
  };
}

function stubDriver(overrides: Record<string, unknown> = {}, order?: string[]) {
  return {
    async attach() { order?.push("attach"); },
    async detach() { order?.push("detach"); },
    async navigateInitialGranted() { order?.push("navigate"); return {}; },
    async observe() { order?.push("observe"); return { origin: "https://example.com", title: "", nodes: [] }; },
    async executeAction() { return {}; },
    ...overrides,
  };
}

function encodedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}
