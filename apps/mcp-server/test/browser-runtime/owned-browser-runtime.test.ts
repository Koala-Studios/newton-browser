import assert from "node:assert/strict";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test, { type TestContext } from "node:test";

import type { CdpEventListener, CdpParams, PrivateCdpTransport } from "../../src/browser-runtime/cdp-pipe.ts";
import { OwnedBrowserRuntimeError, launchOwnedBrowserRuntime } from "../../src/browser-runtime/owned-browser-runtime.ts";
import { startPolicyProxy } from "../../src/browser-runtime/policy-proxy.ts";
import {
  acquireNewtonIdentityLease,
  createNewtonIdentity,
  inspectNewtonIdentityLease,
  openProfileStore,
  releaseNewtonIdentityLease,
  type ProfileStore,
} from "../../src/browser-runtime/profile-store.ts";

class FakeChild extends EventEmitter {
  pid: number | undefined = 9876;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  stderr = new PassThrough();
  stdio: Array<PassThrough | null> = [null, null, this.stderr, new PassThrough(), new PassThrough()];
  kill(): boolean { return true; }
  exit(code = 0): void { this.exitCode = code; this.emit("exit", code, null); }
}

class FakeTransport implements PrivateCdpTransport {
  closed = false;
  pendingRequestCount = 0;
  readonly methods: string[] = [];
  ready = true;
  failClose = false;
  holdClose: Promise<void> | undefined;
  private readonly child: FakeChild;

  constructor(child: FakeChild) { this.child = child; }

  async send(method: string): Promise<CdpParams> {
    if (this.closed) throw new Error("closed transport");
    this.methods.push(method);
    if (method === "Browser.getVersion") {
      if (!this.ready) throw new Error("private readiness detail");
      return { protocolVersion: "1.3" };
    }
    if (method === "Target.createTarget") return { targetId: "owned-root-target" };
    if (method === "Browser.close") {
      if (this.holdClose) await this.holdClose;
      if (this.failClose) throw new Error("private close detail");
      this.child.exit();
    }
    return {};
  }

  onEvent(_listener: CdpEventListener): () => void { return () => {}; }
  close(): void { this.closed = true; }
}

function runtimeFixture(t: TestContext, family: "chrome" | "edge" = "chrome") {
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "newton-owned-runtime-"));
  const store = openProfileStore(path.join(root, "store"));
  const identity = createNewtonIdentity(store, { browserFamily: family });
  const executable = path.join(root, process.platform === "win32" ? "chrome.exe" : "chrome");
  fs.writeFileSync(executable, "fixture", "utf8");
  if (process.platform !== "win32") fs.chmodSync(executable, 0o700);
  const child = new FakeChild();
  const transport = new FakeTransport(child);
  const spawnCalls: Array<{ command: string; args: readonly string[]; options: SpawnOptions }> = [];
  const spawn = (command: string, args: readonly string[], options: SpawnOptions) => {
    spawnCalls.push({ command, args, options });
    return child as unknown as ChildProcess;
  };
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { store, identity, executable, child, transport, spawn, spawnCalls };
}

function options(fixture: ReturnType<typeof runtimeFixture>) {
  return {
    executablePath: fixture.executable,
    browserFamily: fixture.identity.browserFamily,
    profileStore: fixture.store,
    identityId: fixture.identity.id,
    allowedOrigins: ["https://example.com"],
    spawn: fixture.spawn,
    transportFactory: () => fixture.transport,
  } as const;
}

function proxyPort(args: readonly string[]): number {
  const argument = args.find((value) => value.startsWith("--proxy-server=http://127.0.0.1:"));
  assert.ok(argument);
  return Number(new URL(argument.slice("--proxy-server=".length)).port);
}

function connectionRejected(port: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    socket.once("connect", () => { socket.destroy(); reject(new Error("proxy_still_listening")); });
    socket.once("error", () => resolve());
  });
}

test("composes proxy, exact lease, and Chromium readiness without exposing paths or origins", async (t) => {
  const fixture = runtimeFixture(t);
  const runtime = await launchOwnedBrowserRuntime(options(fixture));
  assert.equal(fixture.spawnCalls.length, 1);
  assert.equal(inspectNewtonIdentityLease(fixture.store, fixture.identity.id), "active_or_stale");
  assert.ok(fixture.spawnCalls[0]!.args.includes("--profile-directory=Default"));
  assert.ok(fixture.spawnCalls[0]!.args.includes("--proxy-bypass-list=<-loopback>"));
  assert.deepEqual(runtime.receipt, {
    status: "ready", identityId: fixture.identity.id, browserFamily: "chrome", pid: 9876,
  });
  const receiptText = JSON.stringify(runtime.receipt);
  assert.equal(receiptText.includes(fixture.identity.path), false);
  assert.equal(receiptText.includes("example.com"), false);
  assert.equal(receiptText.includes("owned-root-target"), false);
  const methodsBeforeClaim = [...fixture.transport.methods];
  assert.throws(
    () => runtime.claimDriverBootstrap(["https://outside.example"]),
    (error: unknown) => error instanceof OwnedBrowserRuntimeError && error.phase === "browser_start",
  );
  assert.deepEqual(fixture.transport.methods, methodsBeforeClaim);
  const bootstrap = runtime.claimDriverBootstrap(["https://example.com"]);
  assert.throws(
    () => runtime.claimDriverBootstrap(["https://example.com"]),
    (error: unknown) => error instanceof OwnedBrowserRuntimeError && error.phase === "browser_start",
  );
  assert.deepEqual(fixture.transport.methods, methodsBeforeClaim);
  assert.equal(Object.isFrozen(bootstrap), true);
  assert.equal(bootstrap.transport, fixture.transport);
  assert.equal(bootstrap.rootTargetId, "owned-root-target");
  const port = proxyPort(fixture.spawnCalls[0]!.args);
  await runtime.close();
  assert.throws(() => runtime.claimDriverBootstrap(["https://example.com"]), /Owned browser runtime operation failed/u);
  assert.equal(inspectNewtonIdentityLease(fixture.store, fixture.identity.id), "available");
  await connectionRejected(port);
});

test("unexpected proxy loss removes readiness and keeps the lease until process exit is confirmed", async (t) => {
  const fixture = runtimeFixture(t);
  let release!: () => void;
  fixture.transport.holdClose = new Promise<void>((resolve) => { release = resolve; });
  const runtime = await launchOwnedBrowserRuntime(options(fixture));
  const proxy = (runtime as unknown as { proxy: { close(): Promise<void> } }).proxy;
  await proxy.close();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(runtime.cleanupState(), "closing");
  assert.throws(() => runtime.claimDriverBootstrap(["https://example.com"]), /Owned browser runtime operation failed/u);
  assert.equal(fixture.transport.methods.at(-1), "Browser.close");
  assert.equal(inspectNewtonIdentityLease(fixture.store, fixture.identity.id), "active_or_stale");
  release();
  await runtime.close();
  assert.equal(runtime.cleanupState(), "closed");
  assert.equal(inspectNewtonIdentityLease(fixture.store, fixture.identity.id), "available");
});

test("unexpected process exit removes readiness and closes proxy before releasing the lease", async (t) => {
  const fixture = runtimeFixture(t);
  const runtime = await launchOwnedBrowserRuntime(options(fixture));
  const port = proxyPort(fixture.spawnCalls[0]!.args);
  fixture.child.exit(9);
  await Promise.resolve();
  assert.notEqual(runtime.cleanupState(), "ready");
  assert.throws(
    () => runtime.claimDriverBootstrap(["https://example.com"]),
    (error: unknown) => error instanceof OwnedBrowserRuntimeError && error.phase === "browser_cleanup",
  );
  await runtime.close();
  assert.equal(runtime.cleanupState(), "closed");
  assert.equal(fixture.transport.methods.includes("Browser.close"), false);
  assert.equal(inspectNewtonIdentityLease(fixture.store, fixture.identity.id), "available");
  await connectionRejected(port);
});

test("a second runtime cannot steal a live identity lease", async (t) => {
  const fixture = runtimeFixture(t);
  const first = await launchOwnedBrowserRuntime(options(fixture));
  const second = await launchOwnedBrowserRuntime(options(fixture)).catch((value: unknown) => value);
  assert.ok(second instanceof OwnedBrowserRuntimeError);
  assert.equal(second.phase, "identity_lease");
  assert.equal(fixture.spawnCalls.length, 1);
  assert.equal(inspectNewtonIdentityLease(fixture.store, fixture.identity.id), "active_or_stale");
  await first.close();
  assert.equal(inspectNewtonIdentityLease(fixture.store, fixture.identity.id), "available");
});

test("rolls back proxy and lease for every confirmed startup failure stage", async (t) => {
  const proxyFailure = runtimeFixture(t);
  const first = await launchOwnedBrowserRuntime({ ...options(proxyFailure), allowedOrigins: [] }).catch((value: unknown) => value);
  assert.ok(first instanceof OwnedBrowserRuntimeError);
  assert.equal(first.phase, "proxy_start");
  assert.equal(inspectNewtonIdentityLease(proxyFailure.store, proxyFailure.identity.id), "available");

  const leaseFailure = runtimeFixture(t);
  const held = acquireNewtonIdentityLease(leaseFailure.store, leaseFailure.identity.id);
  const second = await launchOwnedBrowserRuntime(options(leaseFailure)).catch((value: unknown) => value);
  assert.ok(second instanceof OwnedBrowserRuntimeError);
  assert.equal(second.phase, "identity_lease");
  assert.equal(leaseFailure.spawnCalls.length, 0);
  releaseNewtonIdentityLease(held);

  const spawnFailure = runtimeFixture(t);
  const third = await launchOwnedBrowserRuntime({ ...options(spawnFailure), spawn: () => { throw new Error("private spawn"); } }).catch((value: unknown) => value);
  assert.ok(third instanceof OwnedBrowserRuntimeError);
  assert.equal(third.phase, "browser_start");
  assert.equal(third.message.includes("private"), false);
  assert.equal(inspectNewtonIdentityLease(spawnFailure.store, spawnFailure.identity.id), "available");

  const readinessFailure = runtimeFixture(t);
  readinessFailure.transport.ready = false;
  const fourth = await launchOwnedBrowserRuntime(options(readinessFailure)).catch((value: unknown) => value);
  assert.ok(fourth instanceof OwnedBrowserRuntimeError);
  assert.equal(fourth.phase, "browser_start");
  assert.equal(readinessFailure.child.exitCode, 0);
  assert.equal(inspectNewtonIdentityLease(readinessFailure.store, readinessFailure.identity.id), "available");
});

test("confirmed startup rollback closes the policy boundary before releasing its identity lease", async (t) => {
  const fixture = runtimeFixture(t);
  let leaseStateWhenProxyClosed = "not_observed";
  const error = await launchOwnedBrowserRuntime({
    ...options(fixture),
    spawn: () => { throw new Error("private spawn failure"); },
    startProxy: async (proxyOptions) => {
      const proxy = await startPolicyProxy(proxyOptions);
      void proxy.closed.then(() => {
        leaseStateWhenProxyClosed = inspectNewtonIdentityLease(fixture.store, fixture.identity.id);
      });
      return proxy;
    },
  }).catch((value: unknown) => value);
  assert.ok(error instanceof OwnedBrowserRuntimeError);
  assert.equal(error.phase, "browser_start");
  assert.equal(leaseStateWhenProxyClosed, "active_or_stale");
  assert.equal(inspectNewtonIdentityLease(fixture.store, fixture.identity.id), "available");
});

test("rejects family mismatch and forged ProfileStore capabilities with zero process residue", async (t) => {
  const mismatch = runtimeFixture(t, "edge");
  const first = await launchOwnedBrowserRuntime({ ...options(mismatch), browserFamily: "chrome" }).catch((value: unknown) => value);
  assert.ok(first instanceof OwnedBrowserRuntimeError);
  assert.equal(first.phase, "identity_lease");
  assert.equal(mismatch.spawnCalls.length, 0);
  assert.equal(inspectNewtonIdentityLease(mismatch.store, mismatch.identity.id), "available");

  const forged = runtimeFixture(t);
  const second = await launchOwnedBrowserRuntime({ ...options(forged), profileStore: { ...forged.store } as ProfileStore }).catch((value: unknown) => value);
  assert.ok(second instanceof OwnedBrowserRuntimeError);
  assert.equal(second.phase, "identity_lease");
  assert.equal(forged.spawnCalls.length, 0);
});

test("concurrent close shares one operation and cleans process before network and lease boundaries", async (t) => {
  const fixture = runtimeFixture(t);
  let release!: () => void;
  fixture.transport.holdClose = new Promise<void>((resolve) => { release = resolve; });
  const runtime = await launchOwnedBrowserRuntime(options(fixture));
  const port = proxyPort(fixture.spawnCalls[0]!.args);
  const first = runtime.close();
  const second = runtime.close();
  assert.equal(first, second);
  assert.equal(runtime.cleanupState(), "closing");
  assert.equal(inspectNewtonIdentityLease(fixture.store, fixture.identity.id), "active_or_stale");
  await new Promise<void>((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    socket.once("connect", () => { socket.destroy(); resolve(); });
    socket.once("error", reject);
  });
  release();
  await first;
  assert.equal(fixture.transport.methods.filter((method) => method === "Browser.close").length, 1);
  assert.equal(runtime.cleanupState(), "closed");
  assert.equal(inspectNewtonIdentityLease(fixture.store, fixture.identity.id), "available");
});

test("uncertain process cleanup retains proxy and lease, then exact retry finishes without duplicate graceful close", async (t) => {
  const fixture = runtimeFixture(t);
  fixture.transport.failClose = true;
  let kills = 0;
  const runtime = await launchOwnedBrowserRuntime({
    ...options(fixture),
    killTree: async () => {
      kills += 1;
      if (kills === 1) throw new Error("private kill detail");
      fixture.child.exit(137);
    },
  });
  const port = proxyPort(fixture.spawnCalls[0]!.args);
  const first = await runtime.close().catch((value: unknown) => value);
  assert.ok(first instanceof OwnedBrowserRuntimeError);
  assert.equal(first.phase, "browser_cleanup");
  assert.equal(first.cleanupUncertain, true);
  assert.equal(first.message.includes("private"), false);
  assert.equal(runtime.cleanupState(), "cleanup_uncertain");
  assert.equal(inspectNewtonIdentityLease(fixture.store, fixture.identity.id), "active_or_stale");
  await new Promise<void>((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    socket.once("connect", () => { socket.destroy(); resolve(); });
    socket.once("error", reject);
  });

  await runtime.close();
  assert.equal(kills, 2);
  assert.equal(fixture.transport.methods.filter((method) => method === "Browser.close").length, 1);
  assert.equal(inspectNewtonIdentityLease(fixture.store, fixture.identity.id), "available");
  await connectionRejected(port);
});

test("uncertain startup cleanup exposes an exact retry that preserves boundaries until process exit", async (t) => {
  const fixture = runtimeFixture(t);
  fixture.transport.ready = false;
  fixture.transport.failClose = true;
  let kills = 0;
  const error = await launchOwnedBrowserRuntime({
    ...options(fixture),
    killTree: async () => {
      kills += 1;
      if (kills === 1) throw new Error("private first cleanup failure");
      fixture.child.exit(137);
    },
  }).catch((value: unknown) => value);
  assert.ok(error instanceof OwnedBrowserRuntimeError);
  assert.equal(error.phase, "browser_start");
  assert.equal(error.cleanupUncertain, true);
  const port = proxyPort(fixture.spawnCalls[0]!.args);
  assert.equal(inspectNewtonIdentityLease(fixture.store, fixture.identity.id), "active_or_stale");
  await new Promise<void>((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    socket.once("connect", () => { socket.destroy(); resolve(); });
    socket.once("error", reject);
  });
  await error.retryCleanup();
  assert.equal(kills, 2);
  assert.equal(inspectNewtonIdentityLease(fixture.store, fixture.identity.id), "available");
  await connectionRejected(port);
});
