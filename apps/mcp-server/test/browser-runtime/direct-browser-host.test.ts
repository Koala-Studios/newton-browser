import assert from "node:assert/strict";
import test from "node:test";

import type { BrowserAction, BrowserHostPolicyManifest, BrowserSessionInit } from "@newton-browser/core";
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
  private readonly unavailableSignal = deferred();
  readonly unavailable = this.unavailableSignal.promise;
  readonly claimCalls: readonly string[][] = [] as string[][];
  closeCalls = 0;
  closeFailures = 0;
  private claimed = false;
  private state: "ready" | "closing" | "cleanup_uncertain" | "closed" = "ready";

  claimDriverBootstrap(allowedOrigins: readonly string[]) {
    if (this.claimed || this.state !== "ready") throw Object.assign(new Error("bootstrap_unavailable"), { code: "bootstrap_unavailable" });
    this.claimed = true;
    (this.claimCalls as string[][]).push([...allowedOrigins]);
    return { transport: inertTransport(), rootTargetId: "root-target" };
  }

  cleanupState() { return this.state; }
  markUnavailable(): void {
    this.state = "closing";
    this.unavailableSignal.resolve();
  }
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
  executeCalls: BrowserAction[] = [];
  executeTimeouts: Array<number | undefined> = [];
  executeHandlerCalls = 0;
  stopCalls = 0;
  stopFailures = 0;
  resolvedEvidence: Record<string, unknown> = {};
  executeHandler: (action: BrowserAction) => Promise<Record<string, unknown>> = async () => ({ status: "verified" });

  async execute(
    action: BrowserAction,
    _context?: { commandId?: string },
    timeoutMs?: number,
    _signal?: AbortSignal,
    guard?: (evidence: Record<string, unknown>) => Promise<void> | void,
  ): Promise<Record<string, unknown>> {
    this.executeCalls.push(action);
    this.executeTimeouts.push(timeoutMs);
    if (guard) await guard(this.resolvedEvidence);
    this.executeHandlerCalls += 1;
    return await this.executeHandler(action);
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

function validInit(origin = "https://example.com"): BrowserSessionInit {
  return {
    origin,
    allowedOrigins: [origin, "https://assets.example.com"],
  };
}

function harness(overrides: {
  runtime?: FakeRuntime;
  session?: FakeSession;
  launch?: (input: { sessionId: string; init: BrowserSessionInit }) => Promise<DirectOwnedRuntime>;
  start?: (options: Parameters<typeof startDirectDriverSession>[0]) => Promise<DirectHostSession>;
  maxSessions?: number;
  hostPolicies?: readonly BrowserHostPolicyManifest[];
} = {}) {
  const runtime = overrides.runtime ?? new FakeRuntime();
  const session = overrides.session ?? new FakeSession();
  const launchCalls: Array<{ sessionId: string; init: BrowserSessionInit }> = [];
  const startCalls: Array<Parameters<typeof startDirectDriverSession>[0]> = [];
  let defaultLaunchCount = 0;
  const host = createDirectBrowserHost({
    ...(overrides.maxSessions === undefined ? {} : { maxSessions: overrides.maxSessions }),
    ...(overrides.hostPolicies === undefined ? {} : { hostPolicies: overrides.hostPolicies }),
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
  assert.equal(current.host.getStatus().configured, true);
  assert.equal(current.host.getStatus().runtimeReady, false);
  const created = current.host.createSession(validInit());
  const ready = await current.host.waitForSessionReady(created.sessionId);
  assert.equal(ready.origin, "https://example.com");
  assert.equal(ready.lifecycleState, "active");
  assert.deepEqual(current.runtime.claimCalls, [["https://example.com", "https://assets.example.com"]]);
  assert.equal(current.startCalls[0]!.primaryOrigin, "https://example.com");
  assert.deepEqual(current.startCalls[0]!.allowedOrigins, ["https://assets.example.com"]);
  assert.equal(current.startCalls[0]!.initialUrl, "https://example.com/");
  assert.deepEqual(current.startCalls[0]!.pump, { maxItems: 32, maxBytes: 1024 * 1024 });
  const status = current.host.getStatus();
  assert.equal(status.mode, "direct");
  assert.equal(status.runtimeReady, true);
  assert.deepEqual(status.sessionDiagnostics.map((entry) => entry.sessionId), [created.sessionId]);
  assert.equal("extensionConnected" in status, false);
  assert.equal("extensionVersion" in status, false);
  await current.host.close();
});

test("stop during browser launch aborts provisioning before bootstrap, attach, or navigation", async () => {
  const pending = deferred<DirectOwnedRuntime>();
  const runtime = new FakeRuntime();
  const current = harness({ launch: () => pending.promise });
  const created = current.host.createSession(validInit());
  const stopping = current.host.stopSession(created.sessionId);
  pending.resolve(runtime);
  await stopping;
  assert.equal(runtime.claimCalls.length, 0);
  assert.equal(current.startCalls.length, 0);
  assert.equal(runtime.closeCalls, 1);
  assert.deepEqual(current.host.listSessions(), []);
});

test("rejects invalid/current grants and enforces the bounded session cap", async () => {
  const pending = deferred<DirectOwnedRuntime>();
  const current = harness({ maxSessions: 1, launch: () => pending.promise });
  assert.throws(() => current.host.createSession(null as never), /direct_session_invalid_configuration/u);
  assert.throws(() => current.host.createSession({ ...validInit(), browserFamily: "brave" as never }), /invalid_browser_family/u);
  assert.throws(() => current.host.createSession({ ...validInit(), identityId: "operator-name" }), /invalid_identity_id/u);
  assert.throws(() => current.host.createSession({ ...validInit(), origin: "https://example.com/" }), /invalid_origin/u);
  assert.throws(() => current.host.createSession({ ...validInit(), allowedOrigins: ["https://user@example.com"] }), /invalid_origin/u);
  assert.throws(() => current.host.createSession({ ...validInit(), allowedOrigins: ["https://assets.example.com"] }), /invalid_origin/u);
  assert.throws(() => current.host.createSession({ ...validInit(), allowedOrigins: ["https://example.com", "https://example.com"] }), /invalid_origin/u);
  assert.throws(
    () => current.host.createSession({ ...validInit(), retiredCompatibilityField: true } as never),
    /direct_session_invalid_configuration/u,
  );
  current.host.createSession(validInit());
  assert.throws(() => current.host.createSession(validInit("https://other.test")), /session_limit/u);
  pending.resolve(current.runtime);
  await current.host.close();
});

test("accepts the exact 32-origin session bound and rejects a 33rd origin", async () => {
  const current = harness();
  const origin = "https://primary.example";
  const maximum = [origin, ...Array.from({ length: 31 }, (_, index) => `https://origin-${index}.example`)];
  const created = current.host.createSession({ origin, allowedOrigins: maximum });
  await current.host.waitForSessionReady(created.sessionId);
  assert.deepEqual(current.runtime.claimCalls, [maximum]);
  assert.throws(
    () => current.host.createSession({ origin, allowedOrigins: [...maximum, "https://overflow.example"] }),
    /invalid_origin/u,
  );
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
          async attach() {}, async detach() {}, async navigateInitialGranted() {},
          async executeAction(action: BrowserAction) {
            const key = action.keys?.[0] ?? action.kind;
            execution.push(`start:${index}:${key}`);
            if (key === "A") firstStarted.resolve();
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
  const first = current.host.dispatch(firstId, { kind: "press", keys: ["A"] });
  await firstStarted.promise;
  const queued = current.host.dispatch(firstId, { kind: "press", keys: ["B"] });
  const parallel = current.host.dispatch(secondId, { kind: "press", keys: ["R"] });
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

test("normalizes containment prevention and uncertain driver failures into honest command outcomes", async () => {
  const current = harness();
  const sessionId = current.host.createSession(validInit()).sessionId;
  await current.host.waitForSessionReady(sessionId);
  current.session.executeHandler = async () => ({
    status: "blocked",
    reason: "ungranted_mutation",
    changed: { containmentPrevention: "ungranted_mutation" },
  });
  const prevented = await current.host.dispatch(sessionId, { kind: "click", selector: "#save" });
  assert.equal(prevented.ok, false);
  assert.equal(prevented.outcome, "prevented");
  if (!prevented.ok) assert.equal(prevented.errorCode, "ungranted_mutation");
  current.session.executeHandler = async () => { throw new Error("PAGE_SECRET_failure"); };
  const uncertain = await current.host.dispatch(sessionId, { kind: "click", selector: "#save" });
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
    const event = await current.host.dispatch(sessionId, { kind: "click", selector: "#save" });
    assert.equal(event.ok, false);
    assert.equal(event.outcome, "not_started");
    assert.equal(event.retrySafe, true);
    if (!event.ok) assert.equal(event.errorCode, status);
  }
  current.session.executeHandler = async () => ({ status: "timed_out" });
  const wait = await current.host.dispatch(sessionId, { kind: "wait_for", waitFor: { selector: "#ready" } });
  assert.equal(wait.ok, false);
  assert.equal(wait.outcome, "not_started");
  const click = await current.host.dispatch(sessionId, { kind: "click", selector: "#save" });
  assert.equal(click.ok, false);
  assert.equal(click.outcome, "outcome_unknown");
  assert.equal(click.retrySafe, false);
  for (const malformed of [{}, { status: "future_status" }]) {
    current.session.executeHandler = async () => malformed;
    const invalid = await current.host.dispatch(sessionId, { kind: "click", selector: "#save" });
    assert.equal(invalid.ok, false);
    assert.equal(invalid.outcome, "outcome_unknown");
    assert.equal(invalid.retrySafe, false);
    if (!invalid.ok) assert.equal(invalid.errorCode, "runner_contract_invalid");
  }
  await current.host.close();
});

test("ignores temporally scoped proxy results and relies on causal driver prevention evidence", async () => {
  const current = harness();
  assert.equal("beginContainmentCommand" in current.runtime, false);
  const sessionId = current.host.createSession(validInit()).sessionId;
  await current.host.waitForSessionReady(sessionId);

  const unaffected = await current.host.dispatch(sessionId, { kind: "click", selector: "#worker" });
  assert.equal(unaffected.ok, true);

  const completed = await current.host.dispatch(sessionId, { kind: "click", selector: "#safe" });
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

  const completed = await current.host.dispatch(sessionId, { kind: "click", selector: "#save" });
  assert.equal(completed.ok, true);
  assert.equal(current.session.executeCalls.length, 1);

  const completedAgain = await current.host.dispatch(sessionId, { kind: "click", selector: "#save" });
  assert.equal(completedAgain.ok, true);

  current.session.executeHandler = async () => { throw new Error("PAGE_SECRET_failure"); };
  const driverUnknown = await current.host.dispatch(sessionId, { kind: "click", selector: "#save" });
  assert.equal(driverUnknown.ok, false);
  assert.equal(driverUnknown.outcome, "outcome_unknown");
  if (!driverUnknown.ok) assert.equal(driverUnknown.errorCode, "driver_error");
  assert.equal(JSON.stringify([completed, completedAgain, driverUnknown]).includes("PAGE_SECRET"), false);
  await current.host.close();
});

test("resolved target facts are evaluated inside the direct FIFO before input dispatch", async () => {
  const current = harness();
  current.session.resolvedEvidence = {
    resolved: { role: "textbox", inputType: "password", accessibleName: "Account field" },
    signals: { secretField: true },
  };
  const sessionId = current.host.createSession(validInit()).sessionId;
  await current.host.waitForSessionReady(sessionId);

  const result = await current.host.dispatch(sessionId, { kind: "fill", ref: "d1:e7", value: "must-not-dispatch" });
  assert.equal(result.ok, false);
  assert.equal(result.outcome, "prevented");
  assert.equal(result.retrySafe, true);
  assert.equal(result.decision?.class, "blocked");
  assert.equal(current.session.executeCalls.length, 1);
  assert.equal(current.session.executeHandlerCalls, 0);
  await current.host.close();
});

test("binds an immutable host-policy snapshot to the direct host", async () => {
  const origins = ["https://example.com"];
  const commitRule = {
    match: { role: "button", name: "publish" },
    effect: "external_effect" as const,
    reason: "configured_publish_action",
  };
  const policies = [{ origins, commitRules: [commitRule] }] satisfies BrowserHostPolicyManifest[];
  const current = harness({ hostPolicies: policies });
  origins[0] = "https://mutated.invalid";
  commitRule.reason = "mutated_reason";
  current.session.resolvedEvidence = {
    resolved: { role: "button", accessibleName: "Publish changes" },
  };
  const sessionId = current.host.createSession(validInit()).sessionId;
  await current.host.waitForSessionReady(sessionId);

  const result = await current.host.dispatch(sessionId, { kind: "click", ref: "d1:e9" });
  assert.equal(result.ok, true);
  assert.equal(result.decision?.commitBoundary, "external_effect");
  assert.equal(result.decision?.reason, "configured_publish_action");
  assert.equal(current.session.executeHandlerCalls, 1);
  await current.host.close();
});

test("renderer uncertainty is never rewritten as prevention by an unrelated proxy event", async () => {
  const current = harness();
  current.session.executeHandler = async () => {
    throw Object.assign(new Error("Renderer stalled."), { code: "renderer_unresponsive", detail: "cdp_timeout_Input.dispatchMouseEvent" });
  };
  const sessionId = current.host.createSession(validInit()).sessionId;
  await current.host.waitForSessionReady(sessionId);
  const result = await current.host.dispatch(sessionId, { kind: "click", selector: "#popup" });
  assert.equal(result.ok, false);
  assert.equal(result.outcome, "outcome_unknown");
  assert.equal(result.retrySafe, false);
  if (!result.ok) assert.equal(result.errorCode, "renderer_unresponsive");
  assert.equal(current.host.listSessions().length, 1);
  await current.host.stopSession(sessionId);
});

test("host maps queued cancellation to retry-safe not-started and running cancellation to uncertainty", async () => {
  for (const [driverCode, expectedOutcome, retrySafe] of [
    ["command_cancelled_not_started", "not_started", true],
    ["command_cancelled_outcome_unknown", "outcome_unknown", false],
  ] as const) {
    const current = harness();
    current.session.executeHandler = async () => {
      throw Object.assign(new Error(driverCode), { code: driverCode });
    };
    const sessionId = current.host.createSession(validInit()).sessionId;
    await current.host.waitForSessionReady(sessionId);
    const result = await current.host.dispatch(sessionId, { kind: "click", selector: "#action" });
    assert.equal(result.ok, false);
    assert.equal(result.outcome, expectedOutcome);
    assert.equal(result.retrySafe, retrySafe);
    if (!result.ok) assert.equal(result.errorCode, "command_cancelled");
    await current.host.stopSession(sessionId);
  }
});

test("runtime loss immediately degrades the session and fences an in-flight completion", async () => {
  const current = harness();
  const gate = deferred<Record<string, unknown>>();
  const started = deferred();
  current.session.executeHandler = async () => {
    started.resolve();
    return gate.promise;
  };
  const sessionId = current.host.createSession(validInit()).sessionId;
  await current.host.waitForSessionReady(sessionId);
  const action = current.host.dispatch(sessionId, { kind: "click", selector: "#save" });
  await started.promise;
  current.runtime.markUnavailable();
  await current.runtime.unavailable;
  const listed = current.host.listSessions().find((session) => session.sessionId === sessionId);
  assert.equal(listed?.lifecycleState, "degraded");
  assert.equal(current.host.getStatus().cleanupUncertainCount, 1);
  gate.resolve({ status: "verified", changed: { value: "must-not-escape" } });
  const result = await action;
  assert.equal(result.ok, false);
  assert.equal(result.outcome, "outcome_unknown");
  if (!result.ok) assert.equal(result.errorCode, "direct_runtime_unavailable");
  await current.host.stopSession(sessionId);
});

test("joins exact idempotent dispatches and rejects conflicting reuse", async () => {
  const current = harness();
  const gate = deferred<Record<string, unknown>>();
  current.session.executeHandler = async () => gate.promise;
  const sessionId = current.host.createSession(validInit()).sessionId;
  await current.host.waitForSessionReady(sessionId);
  const action = { kind: "fill" as const, selector: "#name", value: "Ada" };
  const first = current.host.dispatch(sessionId, action, { idempotencyKey: "field-01" });
  const joined = current.host.dispatch(sessionId, action, { idempotencyKey: "field-01" });
  assert.equal(first, joined);
  const reordered = current.host.dispatch(sessionId, { value: "Ada", selector: "#name", kind: "fill" }, { idempotencyKey: "field-01" });
  assert.equal(first, reordered);
  const conflict = await current.host.dispatch(sessionId, { ...action, value: "Grace" }, { idempotencyKey: "field-01" });
  assert.equal(conflict.ok, false);
  if (!conflict.ok) assert.equal(conflict.errorCode, "idempotency_conflict");
  gate.resolve({ status: "verified" });
  assert.equal((await first).ok, true);
  assert.equal(current.session.executeCalls.length, 1);
  await current.host.close();
});

test("idempotency joins a structurally floor-blocked command without resolving its target", async () => {
  const current = harness();
  current.session.resolvedEvidence = { resolved: { inputType: "password" } };
  const sessionId = current.host.createSession(validInit()).sessionId;
  await current.host.waitForSessionReady(sessionId);
  const action = { kind: "fill" as const, selector: "#password", value: "not-dispatched" };
  const first = current.host.dispatch(sessionId, action, { idempotencyKey: "blocked-field-01" });
  const joined = current.host.dispatch(sessionId, action, { idempotencyKey: "blocked-field-01" });
  assert.equal(first, joined);
  const result = await first;
  assert.equal(result.ok, false);
  assert.equal(result.outcome, "prevented");
  assert.equal(current.session.executeCalls.length, 0);
  assert.equal(current.session.executeHandlerCalls, 0);
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
      const event = await current.host.dispatch(sessionId, { kind: "observe", query: `q-${index}` }, { idempotencyKey: `key-${String(index).padStart(4, "0")}` });
      assert.equal(event.ok, true);
    }
    const capped = await current.host.dispatch(sessionId, { kind: "observe" }, { idempotencyKey: "overflow-key" });
    assert.equal(capped.ok, false);
    if (!capped.ok) assert.equal(capped.errorCode, "idempotency_limit");
    now += 10 * 60 * 1_000;
    const expiredReuse = await current.host.dispatch(sessionId, { kind: "observe", query: "fresh" }, { idempotencyKey: "key-0000" });
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

test("validates and forwards the canonical bounded timeout object to the command pump", async () => {
  const current = harness();
  const sessionId = current.host.createSession(validInit()).sessionId;
  await current.host.waitForSessionReady(sessionId);
  const object = await current.host.dispatch(sessionId, { kind: "observe" }, { timeoutMs: 2000 });
  assert.equal(object.ok, true);
  assert.deepEqual(current.session.executeTimeouts, [2000]);
  for (const invalid of [0, -1, 300_001, 1.5, Number.NaN]) {
    const event = await current.host.dispatch(sessionId, { kind: "observe" }, { timeoutMs: invalid });
    assert.equal(event.ok, false);
    assert.equal(event.outcome, "prevented");
    if (!event.ok) assert.equal(event.errorCode, "invalid_timeout");
  }
  assert.equal(current.session.executeCalls.length, 1);
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
  await uncertain.host.stopSession(uncertainId);
  assert.equal(uncertainRuntime.closeCalls, 2);
  assert.equal(uncertain.host.listSessions().length, 0);
});

test("stopSession removes an active direct session", async () => {
  const current = harness();
  const firstId = current.host.createSession(validInit()).sessionId;
  await current.host.waitForSessionReady(firstId);
  await current.host.stopSession(firstId);
  assert.equal(current.host.listSessions().length, 0);
});

function inertTransport() {
  return {
    async send() { return {}; },
    onEvent() { return () => {}; },
  };
}
