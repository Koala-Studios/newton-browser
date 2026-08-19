import assert from "node:assert/strict";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test, { type TestContext } from "node:test";

import type { CdpEventListener, CdpParams, PrivateCdpTransport } from "../../src/browser-runtime/cdp-pipe.ts";
import { OwnedBrowserRuntimeError, launchOwnedBrowserRuntime } from "../../src/browser-runtime/owned-browser-runtime.ts";
import { acquireNewtonIdentityLease, createNewtonIdentity, inspectNewtonIdentityLease, openProfileStore, releaseNewtonIdentityLease, type ProfileStore } from "../../src/browser-runtime/profile-store.ts";

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
  private readonly child: FakeChild;
  closed = false;
  pendingRequestCount = 0;
  readonly methods: string[] = [];
  ready = true;
  failClose = false;
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
      if (this.failClose) throw new Error("private close detail");
      this.child.exit();
    }
    return {};
  }
  onEvent(_listener: CdpEventListener): () => void { return () => {}; }
  close(): void { this.closed = true; }
}

function fixture(t: TestContext, family: "chrome" | "edge" = "chrome") {
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

function options(value: ReturnType<typeof fixture>) {
  return { executablePath: value.executable, browserFamily: value.identity.browserFamily, profileStore: value.store, identityId: value.identity.id, spawn: value.spawn, transportFactory: () => value.transport } as const;
}

test("launches normal Chromium networking with one exact identity lease and private CDP", async (t) => {
  const value = fixture(t);
  const runtime = await launchOwnedBrowserRuntime(options(value));
  const args = value.spawnCalls[0]!.args;
  assert.equal(args.some((argument) => argument.startsWith("--proxy-")), false);
  for (const flag of ["--disable-background-networking", "--disable-component-update", "--disable-extensions", "--disable-sync"]) assert.equal(args.includes(flag), false);
  assert.ok(args.includes("--profile-directory=Default"));
  assert.equal(inspectNewtonIdentityLease(value.store, value.identity.id), "active_or_stale");
  assert.deepEqual(runtime.receipt, { status: "ready", identityId: value.identity.id, browserFamily: "chrome", pid: 9876 });
  const bootstrap = runtime.claimDriverBootstrap();
  assert.equal(Object.isFrozen(bootstrap), true);
  assert.equal(bootstrap.transport, value.transport);
  assert.equal(bootstrap.rootTargetId, "owned-root-target");
  assert.throws(() => runtime.claimDriverBootstrap(), /Owned browser runtime operation failed/u);
  await runtime.close();
  assert.equal(inspectNewtonIdentityLease(value.store, value.identity.id), "available");
});

test("unexpected process exit revokes readiness and releases the identity after cleanup", async (t) => {
  const value = fixture(t);
  const runtime = await launchOwnedBrowserRuntime(options(value));
  value.child.exit(9);
  await Promise.resolve();
  assert.notEqual(runtime.cleanupState(), "ready");
  assert.throws(() => runtime.claimDriverBootstrap(), (error: unknown) => error instanceof OwnedBrowserRuntimeError);
  await runtime.close();
  assert.equal(runtime.cleanupState(), "closed");
  assert.equal(value.transport.methods.includes("Browser.close"), false);
  assert.equal(inspectNewtonIdentityLease(value.store, value.identity.id), "available");
});

test("a second runtime cannot steal a live identity lease", async (t) => {
  const value = fixture(t);
  const first = await launchOwnedBrowserRuntime(options(value));
  const second = await launchOwnedBrowserRuntime(options(value)).catch((error: unknown) => error);
  assert.ok(second instanceof OwnedBrowserRuntimeError);
  assert.equal(second.phase, "identity_lease");
  assert.equal(value.spawnCalls.length, 1);
  await first.close();
});

test("confirmed startup failures release the identity without raw diagnostics", async (t) => {
  const leased = fixture(t);
  const held = acquireNewtonIdentityLease(leased.store, leased.identity.id);
  const busy = await launchOwnedBrowserRuntime(options(leased)).catch((error: unknown) => error);
  assert.ok(busy instanceof OwnedBrowserRuntimeError);
  assert.equal(busy.phase, "identity_lease");
  assert.equal(leased.spawnCalls.length, 0);
  releaseNewtonIdentityLease(held);

  const failed = fixture(t);
  const error = await launchOwnedBrowserRuntime({ ...options(failed), spawn: () => { throw new Error("private spawn detail"); } }).catch((value: unknown) => value);
  assert.ok(error instanceof OwnedBrowserRuntimeError);
  assert.equal(error.phase, "browser_start");
  assert.equal(error.message.includes("private"), false);
  assert.equal(inspectNewtonIdentityLease(failed.store, failed.identity.id), "available");
});

test("family mismatch and forged stores fail before spawn", async (t) => {
  const mismatch = fixture(t, "edge");
  const first = await launchOwnedBrowserRuntime({ ...options(mismatch), browserFamily: "chrome" }).catch((error: unknown) => error);
  assert.ok(first instanceof OwnedBrowserRuntimeError);
  assert.equal(first.phase, "identity_lease");
  assert.equal(mismatch.spawnCalls.length, 0);

  const forged = fixture(t);
  const second = await launchOwnedBrowserRuntime({ ...options(forged), profileStore: { ...forged.store } as ProfileStore }).catch((error: unknown) => error);
  assert.ok(second instanceof OwnedBrowserRuntimeError);
  assert.equal(second.phase, "identity_lease");
  assert.equal(forged.spawnCalls.length, 0);
});

test("uncertain process cleanup retains the lease until exact retry confirms exit", async (t) => {
  const value = fixture(t);
  value.transport.failClose = true;
  let kills = 0;
  const runtime = await launchOwnedBrowserRuntime({ ...options(value), killTree: async () => {
    kills += 1;
    if (kills === 1) throw new Error("private kill detail");
    value.child.exit(137);
  } });
  const first = await runtime.close().catch((error: unknown) => error);
  assert.ok(first instanceof OwnedBrowserRuntimeError);
  assert.equal(first.cleanupUncertain, true);
  assert.equal(inspectNewtonIdentityLease(value.store, value.identity.id), "active_or_stale");
  await runtime.close();
  assert.equal(kills, 2);
  assert.equal(inspectNewtonIdentityLease(value.store, value.identity.id), "available");
});
