import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess, SpawnOptions } from "node:child_process";

import { chromiumLaunchArgs, ChromiumLaunchError, launchChromium } from "../../src/browser-runtime/chromium-process.ts";
import type { CdpEventListener, CdpParams, PrivateCdpTransport } from "../../src/browser-runtime/cdp-pipe.ts";
import { startPolicyProxy } from "../../src/browser-runtime/policy-proxy.ts";
import { acquireNewtonIdentityLease, createNewtonIdentity, openProfileStore, releaseNewtonIdentityLease, validateNewtonIdentityLease } from "../../src/browser-runtime/profile-store.ts";

class FakeChild extends EventEmitter {
  pid: number | undefined = 4321;
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
  readonly calls: Array<{ method: string; params: CdpParams }> = [];
  private readonly child: FakeChild;
  private readonly ready: boolean;
  targetResult: CdpParams = { targetId: "root-target-1" };
  constructor(child: FakeChild, ready = true) {
    this.child = child;
    this.ready = ready;
  }
  async send(method: string, params: CdpParams = {}): Promise<CdpParams> {
    this.methods.push(method);
    this.calls.push({ method, params });
    if (method === "Browser.getVersion") {
      if (!this.ready) throw new Error("secret protocol detail");
      return { protocolVersion: "1.3" };
    }
    if (method === "Target.createTarget") return this.targetResult;
    if (method === "Browser.close") this.child.exit();
    return {};
  }
  onEvent(_listener: CdpEventListener): () => void { return () => {}; }
  close(): void { this.closed = true; }
}

function fixture(ready = true) {
  const child = new FakeChild();
  const transport = new FakeTransport(child, ready);
  const spawnCalls: Array<{ command: string; args: readonly string[]; options: SpawnOptions }> = [];
  const spawn = (command: string, args: readonly string[], options: SpawnOptions) => {
    spawnCalls.push({ command, args, options });
    return child as unknown as ChildProcess;
  };
  return { child, transport, spawnCalls, spawn };
}

function profileDirectory(t: TestContext, nonempty = false): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "newton-browser-runtime-"));
  if (nonempty) fs.writeFileSync(path.join(directory, "Identity Marker"), "owned", "utf8");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function executableFile(t: TestContext, platform: NodeJS.Platform = process.platform): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "newton-browser-executable-"));
  const executable = path.join(directory, platform === "win32" ? "chrome.exe" : "chrome");
  fs.writeFileSync(executable, "executable fixture", "utf8");
  if (platform !== "win32") fs.chmodSync(executable, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return executable;
}

test("builds a private pipe launch with an exact blank profile and no debug port", () => {
  const userDataDir = path.resolve("C:/runtime/blank-profile");
  const args = chromiumLaunchArgs({ userDataDir, headless: true });
  assert.ok(args.includes("--remote-debugging-pipe"));
  assert.ok(args.includes(`--user-data-dir=${userDataDir}`));
  assert.ok(args.includes("--headless=new"));
  assert.ok(args.includes("--profile-directory=Default"));
  assert.ok(args.includes("--site-per-process"));
  assert.ok(args.includes("--disable-extensions"));
  assert.equal(args.some((arg) => arg.startsWith("--remote-debugging-port")), false);
  assert.ok(args.includes("--no-startup-window"));
  assert.equal(args.includes("about:blank"), false);
});

test("proves readiness by Browser.getVersion and closes through the supervisor", async (t) => {
  const current = fixture();
  const launched = await launchChromium({
    executablePath: executableFile(t),
    userDataDir: profileDirectory(t),
    spawn: current.spawn,
    transportFactory: () => current.transport,
  });
  assert.deepEqual(current.transport.methods, ["Browser.getVersion", "Target.createTarget"]);
  assert.deepEqual(current.transport.calls[1], { method: "Target.createTarget", params: { url: "about:blank" } });
  assert.equal(launched.rootTargetId, "root-target-1");
  assert.equal(current.spawnCalls.length, 1);
  assert.deepEqual(current.spawnCalls[0].options.stdio, ["ignore", "ignore", "pipe", "pipe", "pipe"]);
  current.child.stderr.write(Buffer.alloc(20_000, 0x73));
  const diagnostics = launched.diagnostics();
  assert.equal(diagnostics.stderrBytesObserved, (16 * 1024) + 1);
  assert.equal(diagnostics.stderrBytesRetained, 16 * 1024);
  assert.equal(diagnostics.stderrTruncated, true);
  await launched.close();
  assert.deepEqual(current.transport.methods, ["Browser.getVersion", "Target.createTarget", "Browser.close"]);
  assert.equal(current.transport.closed, true);
});

test("retains an exact post-readiness process exit signal", async (t) => {
  const current = fixture();
  const launched = await launchChromium({
    executablePath: executableFile(t),
    userDataDir: profileDirectory(t),
    spawn: current.spawn,
    transportFactory: () => current.transport,
  });
  assert.equal(launched.exitedConfirmed(), false);
  assert.equal(current.child.listenerCount("exit") >= 1, true);
  current.child.exit(9);
  await launched.exited;
  assert.equal(launched.exitedConfirmed(), true);
  await launched.close();
  assert.equal(current.transport.methods.includes("Browser.close"), false);
  assert.equal(current.transport.closed, true);
});

test("fails readiness and rolls back when Target.createTarget does not return one exact target ID", async (t) => {
  for (const targetResult of [{}, { targetId: "" }, { targetId: "root", extra: true }]) {
    const current = fixture();
    current.transport.targetResult = targetResult;
    const error = await launchChromium({
      executablePath: executableFile(t),
      userDataDir: profileDirectory(t),
      spawn: current.spawn,
      transportFactory: () => current.transport,
    }).catch((value: unknown) => value);
    assert.ok(error instanceof ChromiumLaunchError);
    assert.equal(error.phase, "protocol_readiness");
    assert.deepEqual(current.transport.methods, ["Browser.getVersion", "Target.createTarget", "Browser.close"]);
    assert.equal(current.transport.methods.includes("Target.getTargets"), false);
    assert.equal(current.child.exitCode, 0);
  }
});

test("derives proxy flags only from an exact live PolicyProxy capability", async (t) => {
  const proxy = await startPolicyProxy({ allowedOrigins: ["https://example.com"] });
  t.after(() => proxy.close());
  const args = chromiumLaunchArgs({ userDataDir: path.resolve("C:/runtime/profile"), policyProxy: proxy });
  assert.ok(args.includes(`--proxy-server=http://127.0.0.1:${proxy.port}`));
  assert.ok(args.includes("--proxy-bypass-list=<-loopback>"));
  assert.ok(args.includes("--disable-quic"));

  const current = fixture();
  const error = await launchChromium({
    executablePath: executableFile(t),
    userDataDir: profileDirectory(t),
    policyProxy: { ...proxy },
    spawn: current.spawn,
  }).catch((value: unknown) => value);
  assert.ok(error instanceof ChromiumLaunchError);
  assert.equal(error.phase, "profile_validation");
  assert.equal(current.spawnCalls.length, 0);
});

test("rejects a copied identity lease capability before spawn", async (t) => {
  const storeRoot = path.join(profileDirectory(t), "store");
  const store = openProfileStore(storeRoot);
  const identity = createNewtonIdentity(store, { browserFamily: "chrome" });
  const lease = acquireNewtonIdentityLease(store, identity.id);
  const current = fixture();
  const error = await launchChromium({
    executablePath: executableFile(t),
    userDataDir: identity.path,
    profileLease: { ...lease },
    validateOwnedProfileLease: (directory, candidate) => candidate === lease && validateNewtonIdentityLease(lease, directory),
    spawn: current.spawn,
  }).catch((value: unknown) => value);
  assert.ok(error instanceof ChromiumLaunchError);
  assert.equal(error.phase, "profile_validation");
  assert.equal(current.spawnCalls.length, 0);
  releaseNewtonIdentityLease(lease);
});

test("protocol readiness failure closes the exact process and reports no raw detail", async (t) => {
  const current = fixture(false);
  let kills = 0;
  const error = await launchChromium({
    executablePath: executableFile(t),
    userDataDir: profileDirectory(t),
    spawn: current.spawn,
    transportFactory: () => current.transport,
    killTree: async () => { kills += 1; current.child.exit(137); },
  }).catch((value: unknown) => value);
  assert.ok(error instanceof ChromiumLaunchError);
  assert.equal(error.phase, "protocol_readiness");
  assert.equal(error.message.includes("secret"), false);
  assert.equal(kills, 0);
  assert.deepEqual(current.transport.methods, ["Browser.getVersion", "Browser.close"]);
  assert.equal(current.transport.closed, true);
});

test("process exit before protocol readiness fails immediately and removes readiness listeners", async (t) => {
  const current = fixture();
  const neverReady: PrivateCdpTransport = {
    closed: false,
    pendingRequestCount: 1,
    send: () => new Promise<CdpParams>(() => {}),
    onEvent: () => () => {},
    close: () => {},
  };
  const launched = launchChromium({
    executablePath: executableFile(t),
    userDataDir: profileDirectory(t),
    spawn: current.spawn,
    transportFactory: () => neverReady,
  });
  current.child.exit(1);
  const error = await launched.catch((value: unknown) => value);
  assert.ok(error instanceof ChromiumLaunchError);
  assert.equal(error.phase, "protocol_readiness");
  assert.equal(current.child.listenerCount("error"), 0);
  assert.equal(current.child.listenerCount("exit"), 0);
});

test("missing pipe cleanup failure is explicitly uncertain", async (t) => {
  const current = fixture();
  current.child.stdio[4] = null;
  const error = await launchChromium({
    executablePath: executableFile(t),
    userDataDir: profileDirectory(t),
    spawn: current.spawn,
    killTree: async () => { throw new Error("private cleanup text"); },
  }).catch((value: unknown) => value);
  assert.ok(error instanceof ChromiumLaunchError);
  assert.equal(error.phase, "pipe_acquisition");
  assert.equal(error.cleanupUncertain, true);
  assert.equal(error.message.includes("private"), false);
});

test("normal launch does not force basic password storage or a mock keychain", () => {
  const args = chromiumLaunchArgs({ userDataDir: path.resolve("C:/runtime/profile") });
  assert.equal(args.includes("--password-store=basic"), false);
  assert.equal(args.includes("--use-mock-keychain"), false);
});

test("accepts a nonempty persistent identity only through its exact owned lease validator", async (t) => {
  const rejectedFixture = fixture();
  const rejected = await launchChromium({
    executablePath: executableFile(t),
    userDataDir: profileDirectory(t, true),
    spawn: rejectedFixture.spawn,
  }).catch((value: unknown) => value);
  assert.ok(rejected instanceof ChromiumLaunchError);
  assert.equal(rejected.phase, "profile_validation");
  assert.equal(rejectedFixture.spawnCalls.length, 0);

  const acceptedFixture = fixture();
  const lease = Object.freeze({ id: "owned-identity-1" });
  const persistentDirectory = profileDirectory(t, true);
  const launched = await launchChromium({
    executablePath: executableFile(t),
    userDataDir: persistentDirectory,
    profileLease: lease,
    validateOwnedProfileLease: (directory, candidate) => directory === persistentDirectory && candidate === lease,
    spawn: acceptedFixture.spawn,
    transportFactory: () => acceptedFixture.transport,
  });
  assert.equal(acceptedFixture.spawnCalls.length, 1);
  await launched.close();
});

test("rejects directories, symlinks, and platform-nonexecutable browser paths before spawn", async (t) => {
  const profile = profileDirectory(t);
  const directory = profileDirectory(t);
  const target = executableFile(t);
  const link = path.join(path.dirname(target), process.platform === "win32" ? "linked.exe" : "linked");
  fs.symlinkSync(target, link, "file");
  const nonExecutable = executableFile(t, "linux");
  fs.chmodSync(nonExecutable, 0o600);
  const wrongWindowsExtension = executableFile(t, "linux");
  const missing = path.join(path.dirname(target), "missing-browser.exe");
  for (const [candidate, platform] of [
    [directory, process.platform],
    [link, process.platform],
    [missing, process.platform],
    [nonExecutable, "linux"],
    [wrongWindowsExtension, "win32"],
  ] as const) {
    const current = fixture();
    const error = await launchChromium({
      executablePath: candidate,
      userDataDir: profile,
      platform,
      spawn: current.spawn,
    }).catch((value: unknown) => value);
    assert.ok(error instanceof ChromiumLaunchError);
    assert.equal(error.phase, "process_spawn");
    assert.equal(current.spawnCalls.length, 0);
  }
});

test("launch accepts an executable beneath a linked ancestor without accepting a linked leaf", async (t) => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "newton-chromium-linked-parent-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const physicalParent = path.join(root, "physical");
  const linkedParent = path.join(root, "linked");
  fs.mkdirSync(physicalParent);
  fs.symlinkSync(physicalParent, linkedParent, process.platform === "win32" ? "junction" : "dir");
  const name = process.platform === "win32" ? "browser.exe" : "browser";
  const physicalExecutable = path.join(physicalParent, name);
  fs.writeFileSync(physicalExecutable, "fixture", { mode: 0o700 });
  if (process.platform !== "win32") fs.chmodSync(physicalExecutable, 0o700);
  const current = fixture();
  const launched = await launchChromium({
    executablePath: path.join(linkedParent, name),
    userDataDir: profileDirectory(t),
    spawn: current.spawn,
    transportFactory: () => current.transport,
  });
  assert.equal(current.spawnCalls.length, 1);
  await launched.close();
});
