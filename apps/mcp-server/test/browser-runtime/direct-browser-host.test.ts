import assert from "node:assert/strict";
import test from "node:test";

import type { BrowserAction, BridgeSessionInit } from "@newton-browser/core";
import { startDirectDriverSession } from "@newton-browser/driver/direct-session-runtime";

import {
  createDirectBrowserHost,
  type DirectHostSession,
  type DirectOwnedRuntime,
} from "../../src/browser-runtime/direct-browser-host.ts";

type Deferred<T = void> = { promise: Promise<T>; resolve(value: T | PromiseLike<T>): void };
function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

class FakeRuntime implements DirectOwnedRuntime {
  readonly receipt = { status: "ready" as const, identityId: "nbi_fake", browserFamily: "chrome" as const, pid: 1234 };
  readonly unavailable = new Promise<void>(() => {});
  readonly claimCalls: readonly string[][] = [] as string[][];
  closeCalls = 0;
  closeFailures = 0;
  private claimed = false;
  private state: "ready" | "closing" | "cleanup_uncertain" | "closed" = "ready";

  claimDriverBootstrap(allowedOrigins: readonly string[]) {
    if (this.claimed || this.state !== "ready") throw Object.assign(new Error("bootstrap_unavailable"), { code: "bootstrap_unavailable" });
    this.claimed = true;
    (this.claimCalls as string[][]).push([...allowedOrigins]);
    return { transport: inertTransport(), rootTargetId: "root-target", syntheticTabId: 77 };
  }

  cleanupState() { return this.state; }
  async close(): Promise<void> {
    this.closeCalls += 1;
    this.state = "closing";
    if (this.closeFailures > 0) {
      this.closeFailures -= 1;
      this.state = "cleanup_uncertain";
      throw new Error("private runtime cleanup detail");
    }
    this.state = "closed";
  }
}

class FakeSession implements DirectHostSession {
  initialObservation = undefined;
  executeCalls: BrowserAction[] = [];
  executeTimeouts: Array<number | undefined> = [];
  stopCalls = 0;
  stopFailures = 0;
  executeHandler: (action: BrowserAction) => Promise<Record<string, unknown>> = async () => ({ status: "verified" });

  execute(action: BrowserAction, _context?: { commandId?: string }, timeoutMs?: number): Promise<Record<string, unknown>> {
    this.executeCalls.push(action);
    this.executeTimeouts.push(timeoutMs);
    return this.executeHandler(action);
  }
  async stop(): Promise<void> {
    this.stopCalls += 1;
    if (this.stopFailures > 0) {
      this.stopFailures -= 1;
      throw new Error("private detach uncertainty");
    }
  }
  snapshot() {
    return { state: "active" as const, runningCommands: 0, queuedCommands: 0, runningBytes: 0, queuedBytes: 0, queueClosed: false };
  }
}

function validInit(origin = "https://example.com"): BridgeSessionInit {
  return {
    origin,
    allowedOrigins: [origin, "https://assets.example.com"],
    goal: "test",
    instanceLabel: "direct-test",
  };
}

function harness(overrides: {
  runtime?: FakeRuntime;
  session?: FakeSession;
  launch?: (input: { sessionId: string; init: BridgeSessionInit }) => Promise<DirectOwnedRuntime>;
  start?: (options: Parameters<typeof startDirectDriverSession>[0]) => Promise<DirectHostSession>;
  maxSessions?: number;
} = {}) {
  const runtime = overrides.runtime ?? new FakeRuntime();
  const session = overrides.session ?? new FakeSession();
  const launchCalls: Array<{ sessionId: string; init: BridgeSessionInit }> = [];
  const startCalls: Array<Parameters<typeof startDirectDriverSession>[0]> = [];
  let defaultLaunchCount = 0;
  const host = createDirectBrowserHost({
    hostInstanceId: "direct_host_test",
    maxSessions: overrides.maxSessions,
    launchOwnedRuntime: async (input) => {
      launchCalls.push(input);
      if (overrides.launch) return overrides.launch(input);
      if (defaultLaunchCount++ === 0) return runtime;
      return new FakeRuntime();
    },
    startDriverSession: async (options) => {
      startCalls.push(options);
      return overrides.start ? overrides.start(options) : session;
    },
  });
  return { host, runtime, session, launchCalls, startCalls };
}

test("provisions exact grants through one bootstrap claim and exposes direct-native status", async () => {
  const current = harness();
  assert.deepEqual(current.host.listen(), { mode: "direct", port: null });
  assert.equal(current.host.getStatus().configured, true);
  assert.equal(current.host.getStatus().runtimeReady, false);
  const created = current.host.createSession(validInit());
  const ready = await current.host.waitForSessionReady(created.sessionId);
  assert.equal(ready.liveOrigin, "https://example.com");
  assert.equal(ready.lifecycleState, "active");
  assert.deepEqual(current.runtime.claimCalls, [["https://example.com", "https://assets.example.com"]]);
  assert.equal(current.startCalls[0]!.primaryOrigin, "https://example.com");
  assert.deepEqual(current.startCalls[0]!.allowedOrigins, ["https://assets.example.com"]);
  assert.equal(current.startCalls[0]!.initialUrl, "https://example.com/");
  assert.deepEqual(current.startCalls[0]!.pump, { maxItems: 32, maxBytes: 1024 * 1024 });
  const status = current.host.getStatus();
  assert.equal(status.mode, "direct");
  assert.equal(status.runtimeReady, true);
  assert.deepEqual(status.browserFamilies, ["chrome"]);
  assert.equal(status.identityCount, 1);
  assert.equal(status.sessionDiagnostics.some((entry) => "sessionId" in entry), false);
  assert.equal("extensionConnected" in status, false);
  assert.equal("extensionVersion" in status, false);
  await current.host.close();
});

test("rejects invalid/current grants and enforces the bounded session cap", async () => {
  const pending = deferred<DirectOwnedRuntime>();
  const current = harness({ maxSessions: 1, launch: () => pending.promise });
  assert.throws(() => current.host.createSession(null as never), /direct_session_invalid_configuration/u);
  assert.throws(() => current.host.createSession({ ...validInit(), browserFamily: "brave" as never }), /invalid_browser_family/u);
  assert.throws(() => current.host.createSession({ ...validInit(), identityId: "operator-name" }), /invalid_identity_id/u);
  assert.throws(() => current.host.createSession({ ...validInit(), origin: "https://example.com/" }), /invalid_origin/u);
  assert.throws(() => current.host.createSession({ ...validInit(), allowedOrigins: ["https://user@example.com"] }), /invalid_origin/u);
  current.host.createSession(validInit());
  assert.throws(() => current.host.createSession(validInit("https://other.test")), /session_limit/u);
  pending.resolve(current.runtime);
  await current.host.close();
});

test("bounds readiness waiting without cancelling the underlying provisioning transaction", async () => {
  const pending = deferred<DirectOwnedRuntime>();
  const current = harness({ launch: () => pending.promise });
  const sessionId = current.host.createSession(validInit()).sessionId;
  await assert.rejects(current.host.waitForSessionReady(sessionId, 5), /session_setup_timeout/u);
  pending.resolve(current.runtime);
  await current.host.waitForSessionReady(sessionId);
  await current.host.close();
});

test("uses DirectDriverSession FIFO within one session and permits cross-session progress", async () => {
  const firstStarted = deferred();
  const leftStarted = deferred();
  const rightStarted = deferred();
  const release = deferred();
  const execution: string[] = [];
  let sessionIndex = 0;
  const current = harness({
    start: (options) => {
      const index = sessionIndex++;
      return startDirectDriverSession({
        ...options,
        driverFactory: () => ({
          async attach() {}, async detach() {}, async navigateInitialGranted() {}, async observe() { return { origin: "https://example.com", title: "", nodes: [] }; },
          async executeAction(action: BrowserAction) {
            const key = "key" in action ? String(action.key) : action.kind;
            execution.push(`start:${index}:${key}`);
            if (key === "A") firstStarted.resolve();
            if (key === "L") leftStarted.resolve();
            if (key === "R") rightStarted.resolve();
            await release.promise;
            execution.push(`end:${index}:${key}`);
            return { status: "verified" };
          },
        }),
      });
    },
  });
  const firstId = current.host.createSession(validInit()).sessionId;
  const secondId = current.host.createSession(validInit("https://other.test")).sessionId;
  await Promise.all([current.host.waitForSessionReady(firstId), current.host.waitForSessionReady(secondId)]);
  const first = current.host.dispatch(firstId, { kind: "press", key: "A" });
  await firstStarted.promise;
  const queued = current.host.dispatch(firstId, { kind: "press", key: "B" });
  const parallel = current.host.dispatch(secondId, { kind: "press", key: "R" });
  await rightStarted.promise;
  assert.deepEqual(execution, ["start:0:A", "start:1:R"]);
  release.resolve();
  const results = await Promise.all([first, queued, parallel]);
  assert.deepEqual(results.map((event) => event.ok), [true, true, true]);
  assert.ok(execution.indexOf("end:0:A") < execution.indexOf("start:0:B"));
  assert.ok(execution.indexOf("start:0:B") < execution.indexOf("end:0:B"));
  assert.ok(execution.includes("end:1:R"));
  await current.host.close();
});

test("normalizes containment prevention and uncertain driver failures into honest BridgeResultEvent outcomes", async () => {
  const current = harness();
  const sessionId = current.host.createSession(validInit()).sessionId;
  await current.host.waitForSessionReady(sessionId);
  current.session.executeHandler = async () => ({
    status: "blocked",
    reason: "ungranted_mutation",
    changed: { containmentPrevention: "ungranted_mutation" },
  });
  const prevented = await current.host.dispatch(sessionId, { kind: "click", target: { selector: "#save" } });
  assert.equal(prevented.ok, false);
  assert.equal(prevented.outcome, "prevented");
  if (!prevented.ok) assert.equal(prevented.errorCode, "ungranted_mutation");
  current.session.executeHandler = async () => { throw new Error("PAGE_SECRET_failure"); };
  const uncertain = await current.host.dispatch(sessionId, { kind: "click", target: { selector: "#save" } });
  assert.equal(uncertain.ok, false);
  assert.equal(uncertain.outcome, "outcome_unknown");
  assert.equal(uncertain.retrySafe, false);
  if (!uncertain.ok) assert.equal(uncertain.errorCode, "driver_error");
  assert.equal(JSON.stringify(uncertain).includes("PAGE_SECRET"), false);
  await current.host.close();
});

test("does not report incomplete driver statuses as completed actions", async () => {
  const current = harness();
  const sessionId = current.host.createSession(validInit()).sessionId;
  await current.host.waitForSessionReady(sessionId);
  for (const status of ["not_found", "ambiguous", "stale_target"] as const) {
    current.session.executeHandler = async () => ({ status });
    const event = await current.host.dispatch(sessionId, { kind: "click", target: { selector: "#save" } });
    assert.equal(event.ok, false);
    assert.equal(event.outcome, "not_started");
    assert.equal(event.retrySafe, true);
    if (!event.ok) assert.equal(event.errorCode, status);
  }
  current.session.executeHandler = async () => ({ status: "timed_out" });
  const wait = await current.host.dispatch(sessionId, { kind: "wait_for", waitFor: { selector: "#ready" } });
  assert.equal(wait.ok, false);
  assert.equal(wait.outcome, "not_started");
  const click = await current.host.dispatch(sessionId, { kind: "click", target: { selector: "#save" } });
  assert.equal(click.ok, false);
  assert.equal(click.outcome, "outcome_unknown");
  assert.equal(click.retrySafe, false);
  await current.host.close();
});

test("ignores temporally scoped proxy results and relies on causal driver prevention evidence", async () => {
  const current = harness();
  assert.equal("beginContainmentCommand" in current.runtime, false);
  const sessionId = current.host.createSession(validInit()).sessionId;
  await current.host.waitForSessionReady(sessionId);

  const unaffected = await current.host.dispatch(sessionId, { kind: "click", target: { selector: "#worker" } });
  assert.equal(unaffected.ok, true);

  const completed = await current.host.dispatch(sessionId, { kind: "click", target: { selector: "#safe" } });
  assert.equal(completed.ok, true);
  const navigated = await current.host.dispatch(sessionId, { kind: "navigate", url: "https://example.com/next" });
  assert.equal(navigated.ok, true);
  const observed = await current.host.dispatch(sessionId, { kind: "observe" });
  assert.equal(observed.ok, true);
  assert.equal(current.session.executeCalls.length, 4);
  await current.host.close();
});

test("proxy scope failures cannot block direct actions or rewrite driver uncertainty", async () => {
  const current = harness();
  const sessionId = current.host.createSession(validInit()).sessionId;
  await current.host.waitForSessionReady(sessionId);

  const completed = await current.host.dispatch(sessionId, { kind: "click", target: { selector: "#save" } });
  assert.equal(completed.ok, true);
  assert.equal(current.session.executeCalls.length, 1);

  const completedAgain = await current.host.dispatch(sessionId, { kind: "click", target: { selector: "#save" } });
  assert.equal(completedAgain.ok, true);

  current.session.executeHandler = async () => { throw new Error("PAGE_SECRET_failure"); };
  const driverUnknown = await current.host.dispatch(sessionId, { kind: "click", target: { selector: "#save" } });
  assert.equal(driverUnknown.ok, false);
  assert.equal(driverUnknown.outcome, "outcome_unknown");
  if (!driverUnknown.ok) assert.equal(driverUnknown.errorCode, "driver_error");
  assert.equal(JSON.stringify([completed, completedAgain, driverUnknown]).includes("PAGE_SECRET"), false);
  await current.host.close();
});

test("renderer uncertainty is never rewritten as prevention by an unrelated proxy event", async () => {
  const current = harness();
  current.session.executeHandler = async () => {
    throw Object.assign(new Error("Renderer stalled."), { code: "renderer_unresponsive", detail: "cdp_timeout_Input.dispatchMouseEvent" });
  };
  const sessionId = current.host.createSession(validInit()).sessionId;
  await current.host.waitForSessionReady(sessionId);
  const result = await current.host.dispatch(sessionId, { kind: "click", target: { selector: "#popup" } });
  assert.equal(result.ok, false);
  assert.equal(result.outcome, "outcome_unknown");
  assert.equal(result.retrySafe, false);
  if (!result.ok) assert.equal(result.errorCode, "renderer_unresponsive");
  assert.equal(current.host.listSessions().length, 1);
  await current.host.stopSession(sessionId);
});

test("joins exact idempotent dispatches and rejects conflicting reuse", async () => {
  const current = harness();
  const gate = deferred<Record<string, unknown>>();
  current.session.executeHandler = async () => gate.promise;
  const sessionId = current.host.createSession(validInit()).sessionId;
  await current.host.waitForSessionReady(sessionId);
  const action = { kind: "fill" as const, target: { selector: "#name" }, value: "Ada" };
  const first = current.host.dispatch(sessionId, action, { idempotencyKey: "field-1" });
  const joined = current.host.dispatch(sessionId, action, { idempotencyKey: "field-1" });
  assert.equal(first, joined);
  const reordered = current.host.dispatch(sessionId, { value: "Ada", target: { selector: "#name" }, kind: "fill" }, { idempotencyKey: "field-1" });
  assert.equal(first, reordered);
  const conflict = await current.host.dispatch(sessionId, { ...action, value: "Grace" }, { idempotencyKey: "field-1" });
  assert.equal(conflict.ok, false);
  if (!conflict.ok) assert.equal(conflict.errorCode, "idempotency_conflict");
  gate.resolve({ status: "verified" });
  assert.equal((await first).ok, true);
  assert.equal(current.session.executeCalls.length, 1);
  await current.host.close();
});

test("bounds idempotency at 256 entries and expires entries after ten minutes", async () => {
  const current = harness();
  const sessionId = current.host.createSession(validInit()).sessionId;
  await current.host.waitForSessionReady(sessionId);
  const originalNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  try {
    for (let index = 0; index < 256; index += 1) {
      const event = await current.host.dispatch(sessionId, { kind: "observe", query: `q-${index}` }, { idempotencyKey: `key-${index}` });
      assert.equal(event.ok, true);
    }
    const capped = await current.host.dispatch(sessionId, { kind: "observe" }, { idempotencyKey: "overflow" });
    assert.equal(capped.ok, false);
    if (!capped.ok) assert.equal(capped.errorCode, "idempotency_limit");
    now += 10 * 60 * 1_000;
    const expiredReuse = await current.host.dispatch(sessionId, { kind: "observe", query: "fresh" }, { idempotencyKey: "key-0" });
    assert.equal(expiredReuse.ok, true);
  } finally {
    Date.now = originalNow;
    await current.host.close();
  }
});

test("host close is retryable after retained cleanup uncertainty", async () => {
  const current = harness();
  current.runtime.closeFailures = 1;
  const sessionId = current.host.createSession(validInit()).sessionId;
  await current.host.waitForSessionReady(sessionId);
  await assert.rejects(current.host.close(), /direct_cleanup_uncertain/u);
  assert.equal(current.host.listSessions().length, 1);
  await current.host.close();
  assert.equal(current.host.listSessions().length, 0);
});

test("validates and forwards bounded timeout semantics to the per-session command pump", async () => {
  const current = harness();
  const sessionId = current.host.createSession(validInit()).sessionId;
  await current.host.waitForSessionReady(sessionId);
  const numeric = await current.host.dispatch(sessionId, { kind: "observe" }, 1000);
  const object = await current.host.dispatch(sessionId, { kind: "observe" }, { timeoutMs: 2000 });
  assert.equal(numeric.ok, true);
  assert.equal(object.ok, true);
  assert.deepEqual(current.session.executeTimeouts, [1000, 2000]);
  for (const invalid of [0, -1, 300_001, 1.5, Number.NaN]) {
    const event = await current.host.dispatch(sessionId, { kind: "observe" }, invalid);
    assert.equal(event.ok, false);
    assert.equal(event.outcome, "prevented");
    if (!event.ok) assert.equal(event.errorCode, "invalid_timeout");
  }
  assert.equal(current.session.executeCalls.length, 2);
  await current.host.close();
});

test("composite stop uses confirmed owned-process exit to resolve debugger detach uncertainty", async () => {
  const current = harness();
  current.session.stopFailures = 1;
  const sessionId = current.host.createSession(validInit()).sessionId;
  await current.host.waitForSessionReady(sessionId);
  await current.host.stopSession(sessionId);
  assert.equal(current.session.stopCalls, 1);
  assert.equal(current.runtime.closeCalls, 1);
  assert.equal(current.host.listSessions().length, 0);

  const retained = harness();
  retained.session.stopFailures = 1;
  retained.runtime.closeFailures = 1;
  const retainedId = retained.host.createSession(validInit()).sessionId;
  await retained.host.waitForSessionReady(retainedId);
  await assert.rejects(retained.host.stopSession(retainedId), /direct_cleanup_uncertain/u);
  assert.equal(retained.host.listSessions().length, 1);
  assert.equal(retained.host.getStatus().cleanupUncertainCount, 1);
  await retained.host.stopSession(retainedId);
  assert.equal(retained.session.stopCalls, 2);
  assert.equal(retained.runtime.closeCalls, 2);
  assert.equal(retained.host.listSessions().length, 0);

  const second = harness();
  second.runtime.closeFailures = 1;
  const secondId = second.host.createSession(validInit()).sessionId;
  await second.host.waitForSessionReady(secondId);
  await assert.rejects(second.host.stopSession(secondId), /direct_cleanup_uncertain/u);
  assert.equal(second.host.listSessions().length, 1);
  await second.host.stopSession(secondId);
  assert.equal(second.session.stopCalls, 1);
  assert.equal(second.runtime.closeCalls, 2);
  assert.equal(second.host.listSessions().length, 0);
});

test("driver setup failure closes the owned runtime and setup cleanup uncertainty remains retryable", async () => {
  const clean = harness({ start: async () => { throw new Error("private setup detail"); } });
  const cleanId = clean.host.createSession(validInit()).sessionId;
  await assert.rejects(clean.host.waitForSessionReady(cleanId), /session_setup_failed/u);
  assert.equal(clean.runtime.closeCalls, 1);
  assert.equal(clean.host.listSessions().length, 0);

  const uncertainRuntime = new FakeRuntime();
  uncertainRuntime.closeFailures = 1;
  const uncertain = harness({ runtime: uncertainRuntime, start: async () => { throw new Error("private setup detail"); } });
  const uncertainId = uncertain.host.createSession(validInit()).sessionId;
  await assert.rejects(uncertain.host.waitForSessionReady(uncertainId), /session_setup_failed/u);
  assert.equal(uncertain.host.listSessions().length, 1);
  const cleanup = await uncertain.host.dispatch(uncertainId, { kind: "__stop" });
  assert.equal(cleanup.ok, true, "the public stop path must bypass degraded action readiness");
  assert.equal(uncertainRuntime.closeCalls, 2);
  assert.equal(uncertain.host.listSessions().length, 0);
});

test("only close finalization is accepted and special stop returns a terminal receipt", async () => {
  const current = harness();
  const firstId = current.host.createSession(validInit()).sessionId;
  await current.host.waitForSessionReady(firstId);
  const unsupported = await current.host.dispatch(firstId, { kind: "__finalize", disposition: "deliverable" });
  assert.equal(unsupported.ok, false);
  if (!unsupported.ok) assert.equal(unsupported.errorCode, "invalid_finalize_disposition");
  assert.equal(current.host.listSessions().length, 1);
  const finalized = await current.host.dispatch(firstId, { kind: "__finalize", disposition: "close" });
  assert.equal(finalized.ok, true);
  assert.equal(finalized.outcome, "completed");
  assert.equal(current.host.listSessions().length, 0);

  const secondId = current.host.createSession(validInit("https://other.test")).sessionId;
  await current.host.waitForSessionReady(secondId);
  const stopped = await current.host.dispatch(secondId, { kind: "__stop" });
  assert.equal(stopped.ok, true);
  assert.equal(current.host.listSessions().length, 0);
});

function inertTransport() {
  return {
    async send() { return {}; },
    onEvent() { return () => {}; },
  };
}
