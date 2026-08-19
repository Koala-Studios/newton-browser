import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { BrowserSessionInit, BrowserAction } from "@newton-browser/core";

import { createConfiguredDirectBrowserHost } from "../../src/browser-runtime/configured-direct-host.ts";
import type { DirectHostSession, DirectOwnedRuntime } from "../../src/browser-runtime/direct-browser-host.ts";
import {
  createNewtonIdentity,
  listNewtonIdentities,
  openProfileStore,
  removeNewtonIdentity,
  releaseNewtonIdentityLease,
  acquireNewtonIdentityLease,
} from "../../src/browser-runtime/profile-store.ts";

type Deferred<T = void> = { promise: Promise<T>; resolve(value: T | PromiseLike<T>): void };
function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test("blank sessions provision concurrent distinct ephemeral identities and delete them after runtime cleanup", async () => {
  const fixture = configuredFixture();
  const releaseLaunch = deferred();
  const bothLaunching = deferred();
  const launched: FakeOwnedRuntime[] = [];
  const order: string[] = [];
  try {
    const host = configuredHost(fixture, {
      async launchRuntime(options) {
        const runtime = new FakeOwnedRuntime(options.identityId, options.browserFamily, order);
        launched.push(runtime);
        if (launched.length === 2) bothLaunching.resolve();
        await releaseLaunch.promise;
        return runtime;
      },
      removeIdentity(store, id) {
        order.push(`remove:${id}`);
        fixture.removeIdentity(store, id);
      },
    });
    const first = host.createSession(validInit("https://one.test")).sessionId;
    const second = host.createSession(validInit("https://two.test")).sessionId;
    await bothLaunching.promise;
    assert.equal(new Set(launched.map((runtime) => runtime.receipt.identityId)).size, 2);
    assert.equal(listNewtonIdentities(fixture.store).length, 2);
    releaseLaunch.resolve();
    await Promise.all([host.waitForSessionReady(first), host.waitForSessionReady(second)]);

    await Promise.all([host.stopSession(first), host.stopSession(second)]);
    assert.deepEqual(listNewtonIdentities(fixture.store), []);
    for (const runtime of launched) {
      const id = runtime.receipt.identityId;
      assert.ok(order.indexOf(`close:${id}`) < order.indexOf(`remove:${id}`));
    }
  } finally {
    fixture.cleanup();
  }
});

test("persistent identities are used only when explicitly requested", async () => {
  const fixture = configuredFixture();
  try {
    const persistent = createNewtonIdentity(fixture.store, { browserFamily: "edge" });
    const runtimes: FakeOwnedRuntime[] = [];
    const host = configuredHost(fixture, {
      discoverBrowser: (input: { family: "chrome" | "edge" }) => ({ family: input.family, path: `${fixture.executablePath}-${input.family}`, source: "system" }),
      async launchRuntime(options) {
        const runtime = new FakeOwnedRuntime(options.identityId, options.browserFamily);
        runtimes.push(runtime);
        return runtime;
      },
    });
    const first = host.createSession(validInit()).sessionId;
    await host.waitForSessionReady(first);
    assert.equal(runtimes[0]?.receipt.browserFamily, "chrome");
    assert.notEqual(runtimes[0]?.receipt.identityId, persistent.id);
    const second = host.createSession({ ...validInit("https://second.test"), identityId: persistent.id }).sessionId;
    await host.waitForSessionReady(second);
    assert.equal(runtimes[1]?.receipt.identityId, persistent.id);
    assert.equal(runtimes[1]?.receipt.browserFamily, "edge");
    assert.equal(listNewtonIdentities(fixture.store).length, 2);

    const explicitBusy = host.createSession({
      ...validInit("https://busy.test"),
      identityId: persistent.id,
    }).sessionId;
    await assert.rejects(host.waitForSessionReady(explicitBusy), bounded("configured_identity_busy", fixture));

    await Promise.all([host.stopSession(first), host.stopSession(second)]);
    assert.deepEqual(listNewtonIdentities(fixture.store).map((identity) => identity.id), [persistent.id]);
  } finally {
    fixture.cleanup();
  }
});

test("operator origin bindings reuse one persistent identity without affecting unrelated origins", async () => {
  const fixture = configuredFixture();
  try {
    const persistent = createNewtonIdentity(fixture.store, { browserFamily: "edge" });
    const runtimes: FakeOwnedRuntime[] = [];
    const host = configuredHost(fixture, {
      identityBindings: [{ origin: "https://bound.test", identityId: persistent.id }],
      discoverBrowser: (input: { family: "chrome" | "edge" }) => ({ family: input.family, path: `${fixture.executablePath}-${input.family}`, source: "system" }),
      async launchRuntime(options: { identityId: string; browserFamily: "chrome" | "edge" }) {
        const runtime = new FakeOwnedRuntime(options.identityId, options.browserFamily);
        runtimes.push(runtime);
        return runtime;
      },
    });
    const bound = host.createSession(validInit("https://bound.test")).sessionId;
    await host.waitForSessionReady(bound);
    assert.equal(runtimes[0]?.receipt.identityId, persistent.id);
    assert.equal(runtimes[0]?.receipt.browserFamily, "edge");
    const unrelated = host.createSession(validInit("https://unrelated.test")).sessionId;
    await host.waitForSessionReady(unrelated);
    assert.notEqual(runtimes[1]?.receipt.identityId, persistent.id);
    assert.equal(runtimes[1]?.receipt.browserFamily, "chrome");
    const busy = host.createSession(validInit("https://bound.test")).sessionId;
    await assert.rejects(host.waitForSessionReady(busy), bounded("configured_identity_busy", fixture));
    await Promise.all([host.stopSession(bound), host.stopSession(unrelated)]);
    assert.deepEqual(listNewtonIdentities(fixture.store).map((identity) => identity.id), [persistent.id]);
  } finally {
    fixture.cleanup();
  }
});

test("configured host rejects malformed or duplicate identity bindings before discovery", () => {
  const fixture = configuredFixture();
  try {
    for (const identityBindings of [
      [{ origin: "https://example.test/path", identityId: "nbi_0123456789abcdef0123456789abcdef" }],
      [{ origin: "https://example.test", identityId: "bad" }],
      [
        { origin: "https://example.test", identityId: "nbi_0123456789abcdef0123456789abcdef" },
        { origin: "https://example.test", identityId: "nbi_fedcba9876543210fedcba9876543210" },
      ],
    ]) {
      assert.throws(() => configuredHost(fixture, { identityBindings }), /configured_identity_bindings_invalid/u);
    }
  } finally {
    fixture.cleanup();
  }
});

test("browser discovery failure is bounded and creates no ephemeral identity", () => {
  const fixture = configuredFixture();
  try {
    const persistent = createNewtonIdentity(fixture.store, { browserFamily: "edge" });
    assert.throws(() => configuredHost(fixture, {
      discoverBrowser: () => null,
    }), bounded("configured_browser_unavailable", fixture));
    assert.deepEqual(listNewtonIdentities(fixture.store).map((identity) => identity.id), [persistent.id]);
  } finally {
    fixture.cleanup();
  }
});

test("two explicit persistent identities run concurrently and select their authoritative browser families", async () => {
  const fixture = configuredFixture();
  try {
    const chromeIdentity = createNewtonIdentity(fixture.store, { browserFamily: "chrome" });
    const edgeIdentity = createNewtonIdentity(fixture.store, { browserFamily: "edge" });
    const launches: Array<{ identityId: string; browserFamily: "chrome" | "edge"; executablePath: string }> = [];
    const discoveries: Array<{ family: string; explicitPath?: string }> = [];
    const host = configuredHost(fixture, {
      discoverBrowser(input: { family: "chrome" | "edge"; explicitPath?: string }) {
        discoveries.push({ family: input.family, ...(input.explicitPath ? { explicitPath: input.explicitPath } : {}) });
        return { family: input.family, path: `${fixture.executablePath}-${input.family}`, source: "system" };
      },
      async launchRuntime(options: { identityId: string; browserFamily: "chrome" | "edge"; executablePath: string }) {
        launches.push({
          identityId: options.identityId,
          browserFamily: options.browserFamily,
          executablePath: options.executablePath,
        });
        return new FakeOwnedRuntime(options.identityId, options.browserFamily);
      },
    });
    const chrome = host.createSession({ ...validInit("https://chrome.test"), identityId: chromeIdentity.id }).sessionId;
    const edge = host.createSession({ ...validInit("https://edge.test"), identityId: edgeIdentity.id }).sessionId;
    await Promise.all([host.waitForSessionReady(chrome), host.waitForSessionReady(edge)]);
    assert.deepEqual(launches.map(({ identityId, browserFamily }) => ({ identityId, browserFamily })), [
      { identityId: chromeIdentity.id, browserFamily: "chrome" },
      { identityId: edgeIdentity.id, browserFamily: "edge" },
    ]);
    assert.deepEqual(new Set(discoveries.map(({ family }) => family)), new Set(["chrome", "edge"]));
    await Promise.all([host.stopSession(chrome), host.stopSession(edge)]);
  } finally {
    fixture.cleanup();
  }
});

test("session browser selection applies to ephemeral identities and cannot override a persistent family", async () => {
  const fixture = configuredFixture();
  try {
    const edgeIdentity = createNewtonIdentity(fixture.store, { browserFamily: "edge" });
    const launches: FakeOwnedRuntime[] = [];
    const host = configuredHost(fixture, {
      discoverBrowser: (input: { family: "chrome" | "edge" }) => ({
        family: input.family,
        path: `${fixture.executablePath}-${input.family}`,
        source: "system",
      }),
      async launchRuntime(options: { identityId: string; browserFamily: "chrome" | "edge" }) {
        const runtime = new FakeOwnedRuntime(options.identityId, options.browserFamily);
        launches.push(runtime);
        return runtime;
      },
    });
    const ephemeralEdge = host.createSession({ ...validInit(), browserFamily: "edge" }).sessionId;
    await host.waitForSessionReady(ephemeralEdge);
    assert.equal(launches[0]?.receipt.browserFamily, "edge");

    const mismatch = host.createSession({
      ...validInit("https://mismatch.test"),
      identityId: edgeIdentity.id,
      browserFamily: "chrome",
    }).sessionId;
    await assert.rejects(host.waitForSessionReady(mismatch), bounded("configured_browser_identity_mismatch", fixture));
    await host.stopSession(ephemeralEdge);
  } finally {
    fixture.cleanup();
  }
});

test("an externally leased identity never affects an unspecified ephemeral session", async () => {
  const fixture = configuredFixture();
  const persistent = createNewtonIdentity(fixture.store, { browserFamily: "chrome" });
  const externalLease = acquireNewtonIdentityLease(fixture.store, persistent.id);
  try {
    const launches: FakeOwnedRuntime[] = [];
    const host = configuredHost(fixture, {
      async launchRuntime(options: { identityId: string; browserFamily: "chrome" | "edge" }) {
        if (options.identityId === persistent.id) throw new Error("identity lease is active");
        const runtime = new FakeOwnedRuntime(options.identityId, options.browserFamily);
        launches.push(runtime);
        return runtime;
      },
    });
    const implicit = host.createSession(validInit()).sessionId;
    await host.waitForSessionReady(implicit);
    assert.notEqual(launches[0]?.receipt.identityId, persistent.id);

    const explicit = host.createSession({
      ...validInit("https://explicit.test"),
      identityId: persistent.id,
    }).sessionId;
    await assert.rejects(host.waitForSessionReady(explicit), bounded("configured_runtime_start_failed", fixture));
    await host.stopSession(implicit);
  } finally {
    releaseNewtonIdentityLease(externalLease);
    fixture.cleanup();
  }
});

test("an explicit browser family selects an ephemeral identity without using stored identities", async () => {
  const fixture = configuredFixture();
  try {
    const chromeIdentity = createNewtonIdentity(fixture.store, { browserFamily: "chrome" });
    const launches: FakeOwnedRuntime[] = [];
    const host = configuredHost(fixture, {
      discoverBrowser: (input: { family: "chrome" | "edge" }) => ({
        family: input.family,
        path: `${fixture.executablePath}-${input.family}`,
        source: "system",
      }),
      async launchRuntime(options: { identityId: string; browserFamily: "chrome" | "edge" }) {
        const runtime = new FakeOwnedRuntime(options.identityId, options.browserFamily);
        launches.push(runtime);
        return runtime;
      },
    });
    const sessionId = host.createSession({ ...validInit(), browserFamily: "edge" }).sessionId;
    await host.waitForSessionReady(sessionId);
    assert.equal(launches[0]?.receipt.browserFamily, "edge");
    assert.notEqual(launches[0]?.receipt.identityId, chromeIdentity.id);
    await host.stopSession(sessionId);
  } finally {
    fixture.cleanup();
  }
});

test("startup rollback removes an ephemeral identity and never exposes private launch detail", async () => {
  const fixture = configuredFixture();
  try {
    const host = configuredHost(fixture, {
      async launchRuntime() { throw new Error(`private launch ${fixture.executablePath} ${fixture.store.root}`); },
    });
    const sessionId = host.createSession(validInit()).sessionId;
    await assert.rejects(host.waitForSessionReady(sessionId), bounded("configured_runtime_start_failed", fixture));
    assert.deepEqual(listNewtonIdentities(fixture.store), []);
  } finally {
    fixture.cleanup();
  }
});

test("startup cleanup uncertainty without a real retry retains the identity and never claims cleanup", async () => {
  const fixture = configuredFixture();
  try {
    const host = configuredHost(fixture, {
      async launchRuntime() {
        throw Object.assign(new Error("private uncertain startup"), { cleanupUncertain: true });
      },
    });
    const sessionId = host.createSession(validInit()).sessionId;
    await assert.rejects(host.waitForSessionReady(sessionId), bounded("configured_runtime_start_uncertain", fixture));
    assert.equal(listNewtonIdentities(fixture.store).length, 1);
    await assert.rejects(host.stopSession(sessionId), bounded("direct_cleanup_uncertain", fixture));
    assert.equal(listNewtonIdentities(fixture.store).length, 1);
  } finally {
    fixture.cleanup();
  }
});

test("cleanup uncertainty retains the ephemeral identity and retries runtime before deletion", async () => {
  const fixture = configuredFixture();
  const order: string[] = [];
  let runtime: FakeOwnedRuntime | null = null;
  try {
    const host = configuredHost(fixture, {
      async launchRuntime(options) {
        runtime = new FakeOwnedRuntime(options.identityId, options.browserFamily, order);
        runtime.closeFailures = 1;
        return runtime;
      },
      removeIdentity(store, id) {
        order.push(`remove:${id}`);
        fixture.removeIdentity(store, id);
      },
    });
    const sessionId = host.createSession(validInit()).sessionId;
    await host.waitForSessionReady(sessionId);
    const identityId = runtime?.receipt.identityId ?? "";
    await assert.rejects(host.stopSession(sessionId), bounded("direct_cleanup_uncertain", fixture));
    assert.equal(listNewtonIdentities(fixture.store).some((identity) => identity.id === identityId), true);
    assert.equal(order.some((entry) => entry.startsWith("remove:")), false);

    await host.stopSession(sessionId);
    assert.equal(runtime?.closeCalls, 2);
    assert.deepEqual(listNewtonIdentities(fixture.store), []);
    assert.ok(order.lastIndexOf(`close:${identityId}`) < order.indexOf(`remove:${identityId}`));
  } finally {
    fixture.cleanup();
  }
});

test("unexpected underlying runtime loss is visible through configured cleanup state", async () => {
  const fixture = configuredFixture();
  let runtime: FakeOwnedRuntime | null = null;
  try {
    const host = configuredHost(fixture, {
      async launchRuntime(options) {
        runtime = new FakeOwnedRuntime(options.identityId, options.browserFamily);
        return runtime;
      },
    });
    const sessionId = host.createSession(validInit()).sessionId;
    await host.waitForSessionReady(sessionId);
    runtime?.markCleanupUncertain();
    const result = await host.dispatch(sessionId, { kind: "observe" });
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, "direct_runtime_unavailable");
    assert.equal(host.getStatus().cleanupUncertainCount, 1);
    await host.stopSession(sessionId);
  } finally {
    fixture.cleanup();
  }
});

test("identity deletion uncertainty retries only after runtime cleanup remains confirmed", async () => {
  const fixture = configuredFixture();
  let runtime: FakeOwnedRuntime | null = null;
  let removeCalls = 0;
  try {
    const host = configuredHost(fixture, {
      async launchRuntime(options) {
        runtime = new FakeOwnedRuntime(options.identityId, options.browserFamily);
        return runtime;
      },
      removeIdentity(store, id) {
        removeCalls += 1;
        if (removeCalls === 1) throw new Error(`private deletion ${fixture.store.root}`);
        fixture.removeIdentity(store, id);
      },
    });
    const sessionId = host.createSession(validInit()).sessionId;
    await host.waitForSessionReady(sessionId);
    await assert.rejects(host.stopSession(sessionId), bounded("direct_cleanup_uncertain", fixture));
    assert.equal(runtime?.closeCalls, 1);
    assert.equal(listNewtonIdentities(fixture.store).length, 1);

    await host.stopSession(sessionId);
    assert.equal(runtime?.closeCalls, 1, "a confirmed runtime close is not repeated for identity-only cleanup");
    assert.equal(removeCalls, 2);
    assert.deepEqual(listNewtonIdentities(fixture.store), []);
  } finally {
    fixture.cleanup();
  }
});

test("status and errors contain no identity, PID, executable, or profile-store paths", async () => {
  const fixture = configuredFixture();
  let runtime: FakeOwnedRuntime | null = null;
  try {
    const host = configuredHost(fixture, {
      async launchRuntime(options) {
        runtime = new FakeOwnedRuntime(options.identityId, options.browserFamily);
        return runtime;
      },
    });
    const sessionId = host.createSession(validInit()).sessionId;
    await host.waitForSessionReady(sessionId);
    const serialized = JSON.stringify(host.getStatus());
    for (const secret of [runtime?.receipt.identityId ?? "", "4242", fixture.executablePath, fixture.store.root]) {
      assert.equal(serialized.includes(secret), false, secret);
    }
    await host.stopSession(sessionId);
  } finally {
    fixture.cleanup();
  }
});

test("production configuration values can come from explicit environment inputs", async () => {
  const fixture = configuredFixture(false);
  const discoveryCalls: unknown[] = [];
  try {
    const host = createConfiguredDirectBrowserHost({
      env: {
        NEWTON_BROWSER_PROFILE_STORE_DIR: fixture.storeRoot,
        NEWTON_BROWSER_BROWSER: "chrome",
        NEWTON_BROWSER_BROWSER_EXECUTABLE: fixture.executablePath,
      },
      discoverBrowser(input) {
        discoveryCalls.push(input);
        return { family: "chrome", path: fixture.executablePath, source: "explicit" };
      },
      launchRuntime: async (options) => new FakeOwnedRuntime(options.identityId, options.browserFamily),
      startDriverSession: fakeDriverFactory,
    });
    const sessionId = host.createSession(validInit()).sessionId;
    await host.waitForSessionReady(sessionId);
    assert.equal(discoveryCalls.length, 1);
    assert.equal((discoveryCalls[0] as { explicitPath?: string }).explicitPath, fixture.executablePath);
    await host.stopSession(sessionId);
  } finally {
    fixture.cleanup();
  }
});

class FakeOwnedRuntime implements DirectOwnedRuntime {
  readonly receipt;
  readonly unavailable = new Promise<void>(() => {});
  closeCalls = 0;
  closeFailures = 0;
  private state: "ready" | "cleanup_uncertain" | "closed" = "ready";
  private claimed = false;
  private readonly order: string[];
  constructor(identityId: string, browserFamily: "chrome" | "edge", order: string[] = []) {
    this.order = order;
    this.receipt = { status: "ready" as const, identityId, browserFamily, pid: 4242 };
  }
  claimDriverBootstrap() {
    if (this.claimed) throw new Error("already_claimed");
    this.claimed = true;
    return { transport: inertTransport(), rootTargetId: "root-target" };
  }
  cleanupState() { return this.state; }
  markCleanupUncertain() { this.state = "cleanup_uncertain"; }
  async close() {
    this.closeCalls += 1;
    this.order.push(`close:${this.receipt.identityId}`);
    if (this.closeFailures > 0) {
      this.closeFailures -= 1;
      this.state = "cleanup_uncertain";
      throw new Error("private runtime uncertainty");
    }
    this.state = "closed";
  }
}

const fakeDriverFactory = async (): Promise<DirectHostSession> => ({
  async execute(_action: BrowserAction) { return { status: "verified" }; },
  async stop() {},
  snapshot() {
    return { state: "active", runningCommands: 0, queuedCommands: 0, runningBytes: 0, queuedBytes: 0, queueClosed: false };
  },
});

function configuredHost(fixture: ReturnType<typeof configuredFixture>, overrides: Record<string, unknown> = {}) {
  return createConfiguredDirectBrowserHost({
    profileStore: fixture.store,
    env: {},
    browserFamily: "chrome",
    discoverBrowser: (input) => ({ family: input.family, path: fixture.executablePath, source: "explicit" }),
    launchRuntime: async (options) => new FakeOwnedRuntime(options.identityId, options.browserFamily),
    startDriverSession: fakeDriverFactory,
    ...overrides,
  });
}

function configuredFixture(open = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "newton-configured-direct-secret-"));
  const storeRoot = path.join(root, "PRIVATE_PROFILE_STORE");
  const store = open ? openProfileStore(storeRoot) : null;
  const executablePath = path.join(root, "PRIVATE_BROWSER_PATH", "chrome");
  return {
    root,
    store: store ?? openProfileStore(storeRoot),
    storeRoot,
    executablePath,
    removeIdentity: releaseSafeIdentity,
    cleanup() { fs.rmSync(root, { recursive: true, force: true }); },
  };
}

function releaseSafeIdentity(store: ReturnType<typeof openProfileStore>, id: string): void {
  // A configured host removes only identities whose runtime has already closed.
  const identity = listNewtonIdentities(store).find((candidate) => candidate.id === id);
  assert.ok(identity);
  const leaseInspection = (() => {
    try {
      const lease = acquireNewtonIdentityLease(store, id);
      releaseNewtonIdentityLease(lease);
      return "available";
    } catch {
      return "busy";
    }
  })();
  assert.equal(leaseInspection, "available");
  removeNewtonIdentity(store, id);
}

function validInit(origin = "https://example.com"): BrowserSessionInit {
  return { origin };
}

function inertTransport() {
  return { async send() { return {}; }, onEvent() { return () => {}; } };
}

function bounded(code: string, fixture: ReturnType<typeof configuredFixture>) {
  return (error: unknown) => {
    assert.equal(error instanceof Error, true);
    const message = error instanceof Error ? error.message : String(error);
    assert.equal(message, code);
    for (const secret of [fixture.store.root, fixture.executablePath, "PRIVATE_PROFILE_STORE", "PRIVATE_BROWSER_PATH"] ) {
      assert.equal(message.includes(secret), false);
    }
    return true;
  };
}
