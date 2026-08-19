import fs from "node:fs";
import path from "node:path";
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Readable, Writable } from "node:stream";

import { CdpPipeTransport, type PrivateCdpTransport } from "./cdp-pipe.ts";
import type { GuardianProfileCleanupPlan } from "./profile-store.ts";
import { ProcessCleanupError, ProcessSupervisor, type SupervisedChild } from "./process-supervisor.ts";

const DEFAULT_READY_DEADLINE_MS = 20_000;
const DEFAULT_STDERR_DIAGNOSTIC_BYTES = 16 * 1024;
const SAFE_CHROMIUM_ARGS = [
  "--remote-debugging-pipe",
  "--no-first-run",
  "--no-default-browser-check",
  "--profile-directory=Default",
  "--no-startup-window",
] as const;

export type ChromiumLaunchPhase =
  | "profile_validation"
  | "process_spawn"
  | "pipe_acquisition"
  | "protocol_readiness"
  | "launch_cleanup";

export class ChromiumLaunchError extends Error {
  readonly code = "browser_launch_failed";
  readonly phase: ChromiumLaunchPhase;
  readonly cleanupUncertain: boolean;
  private readonly cleanupRetry: (() => Promise<void>) | undefined;

  constructor(phase: ChromiumLaunchPhase, cleanupUncertain = false, cleanupRetry?: () => Promise<void>) {
    super("Browser process launch failed.");
    this.name = "ChromiumLaunchError";
    this.phase = phase;
    this.cleanupUncertain = cleanupUncertain;
    this.cleanupRetry = cleanupRetry;
  }

  retryCleanup(): Promise<void> {
    return this.cleanupRetry ? this.cleanupRetry() : Promise.resolve();
  }
}

export type ChromiumDiagnostics = Readonly<{
  stderrBytesObserved: number;
  stderrBytesRetained: number;
  stderrTruncated: boolean;
}>;

type SpawnLike = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export type ChromiumLaunchOptions = Readonly<{
  executablePath: string;
  userDataDir: string;
  headless?: boolean;
  readyDeadlineMs?: number;
  stderrDiagnosticBytes?: number;
  spawn?: SpawnLike;
  transportFactory?: (readable: Readable, writable: Writable) => PrivateCdpTransport;
  profileLease?: unknown;
  validateOwnedProfileLease?: (directory: string, lease: unknown) => boolean;
  killTree?: (pid: number, platform: NodeJS.Platform) => Promise<void>;
  platform?: NodeJS.Platform;
  guardianProfileCleanup?: GuardianProfileCleanupPlan;
}>;

export class ChromiumProcess {
  readonly transport: PrivateCdpTransport;
  readonly supervisor: ProcessSupervisor;
  readonly pid: number;
  readonly args: readonly string[];
  readonly rootTargetId: string;
  readonly exited: Promise<void>;
  readonly guardianManagedProfileCleanup: boolean;
  private readonly diagnosticState: MutableDiagnostics;
  private readonly exitState: ProcessExitState;

  constructor(input: {
    transport: PrivateCdpTransport;
    supervisor: ProcessSupervisor;
    pid: number;
    args: readonly string[];
    diagnostics: MutableDiagnostics;
    rootTargetId: string;
    exitState: ProcessExitState;
    guardianManagedProfileCleanup: boolean;
  }) {
    this.transport = input.transport;
    this.supervisor = input.supervisor;
    this.pid = input.pid;
    this.args = input.args;
    this.rootTargetId = input.rootTargetId;
    this.diagnosticState = input.diagnostics;
    this.exitState = input.exitState;
    this.exited = input.exitState.promise;
    this.guardianManagedProfileCleanup = input.guardianManagedProfileCleanup;
  }

  diagnostics(): ChromiumDiagnostics {
    return {
      stderrBytesObserved: this.diagnosticState.observed,
      stderrBytesRetained: this.diagnosticState.retained,
      stderrTruncated: this.diagnosticState.truncated,
    };
  }

  exitedConfirmed(): boolean { return this.exitState.confirmed; }

  async close(): Promise<void> {
    try {
      await this.supervisor.terminate();
    } finally {
      this.transport.close();
    }
  }
}

type MutableDiagnostics = { observed: number; retained: number; truncated: boolean };
type ProcessExitState = { confirmed: boolean; promise: Promise<void> };

export async function launchChromium(options: ChromiumLaunchOptions): Promise<ChromiumProcess> {
  validateExecutablePath(options.executablePath, options.platform ?? process.platform);
  try { validateUserDataDir(options); } catch { throw new ChromiumLaunchError("profile_validation"); }
  let args: readonly string[];
  try { args = chromiumLaunchArgs(options); } catch (error) {
    if (error instanceof ChromiumLaunchError) throw error;
    throw new ChromiumLaunchError("profile_validation");
  }
  const spawn = options.spawn ?? nodeSpawn;
  let child: ChildProcess;
  let browserPid: number | undefined;
  try {
    if (options.spawn) {
      child = spawn(options.executablePath, args, {
        detached: true,
        stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      browserPid = child.pid;
    } else {
      if (!options.guardianProfileCleanup) throw new ChromiumLaunchError("profile_validation");
      const guarded = await spawnGuardedChromium(options.executablePath, args, options.guardianProfileCleanup, boundedReadyDeadline(options.readyDeadlineMs));
      child = guarded.child;
      browserPid = guarded.browserPid;
    }
  } catch (error) {
    if (error instanceof ChromiumLaunchError) throw error;
    throw new ChromiumLaunchError("process_spawn");
  }

  const pid = browserPid;
  const cdpInput = child.stdio[3];
  const cdpOutput = child.stdio[4];
  if (!Number.isSafeInteger(pid) || Number(pid) <= 0 || !writableStream(cdpInput) || !readableStream(cdpOutput)) {
    const cleanup = await cleanupFailedLaunch(child, options, pid);
    throw new ChromiumLaunchError("pipe_acquisition", !cleanup.confirmed, cleanup.retry);
  }

  const diagnostics = captureBoundedStderr(child.stderr, boundedDiagnosticBytes(options.stderrDiagnosticBytes));
  const exitState = monitorProcessExit(child);
  const transportFactory = options.transportFactory ?? ((readable, writable) => new CdpPipeTransport(readable, writable));
  let transport: PrivateCdpTransport;
  try { transport = transportFactory(cdpOutput, cdpInput); } catch {
    const cleanup = await cleanupFailedLaunch(child, options, pid);
    throw new ChromiumLaunchError("pipe_acquisition", !cleanup.confirmed, cleanup.retry);
  }

  const supervisedChild = supervisedBrowserProcess(child, Number(pid));
  const supervisor = new ProcessSupervisor({
    child: supervisedChild,
    ...(options.platform === undefined ? {} : { platform: options.platform }),
    gracefulClose: () => transport.send("Browser.close").then(() => undefined),
    ...(options.killTree === undefined ? {} : { killTree: options.killTree }),
  });
  try {
    const rootTargetId = await protocolReadyWhileRunning(transport, child, boundedReadyDeadline(options.readyDeadlineMs));
    return new ChromiumProcess({ transport, supervisor, pid: Number(pid), args, diagnostics, rootTargetId, exitState, guardianManagedProfileCleanup: options.spawn === undefined });
  } catch {
    let uncertain = false;
    try { await supervisor.terminate(); } catch { uncertain = true; }
    transport.close();
    throw new ChromiumLaunchError(
      uncertain ? "launch_cleanup" : "protocol_readiness",
      uncertain,
      uncertain ? () => supervisor.terminate() : undefined,
    );
  }

}

function monitorProcessExit(child: ChildProcess): ProcessExitState {
  let resolveExit: () => void = () => {};
  const state: ProcessExitState = {
    confirmed: child.exitCode !== null || child.signalCode !== null,
    promise: new Promise<void>((resolve) => { resolveExit = resolve; }),
  };
  if (state.confirmed) {
    resolveExit();
    return state;
  }
  child.once("exit", () => {
    state.confirmed = true;
    resolveExit();
  });
  return state;
}

export function chromiumLaunchArgs(options: Pick<ChromiumLaunchOptions, "userDataDir" | "headless">): readonly string[] {
  const directory = path.resolve(options.userDataDir);
  const args = [
    ...SAFE_CHROMIUM_ARGS,
    `--user-data-dir=${directory}`,
    ...(options.headless === false ? [] : ["--headless=new"]),
  ];
  return Object.freeze(args);
}

export function verifyBlankUserDataDir(directory: string): void {
  if (inspectUserDataDir(directory) !== "empty") throw new ChromiumLaunchError("profile_validation");
}

export function inspectUserDataDir(directory: string): "empty" | "nonempty" {
  if (!path.isAbsolute(directory)) throw new ChromiumLaunchError("profile_validation");
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ChromiumLaunchError("profile_validation");
  return fs.readdirSync(directory).length === 0 ? "empty" : "nonempty";
}

function validateUserDataDir(options: ChromiumLaunchOptions): void {
  if (!path.isAbsolute(options.userDataDir)) throw new ChromiumLaunchError("profile_validation");
  const state = inspectUserDataDir(options.userDataDir);
  if (state === "empty") return;
  if (state !== "nonempty" || options.profileLease === undefined || !options.validateOwnedProfileLease) {
    throw new ChromiumLaunchError("profile_validation");
  }
  if (options.validateOwnedProfileLease(options.userDataDir, options.profileLease) !== true) {
    throw new ChromiumLaunchError("profile_validation");
  }
}

function validateExecutablePath(value: string, platform: NodeJS.Platform): void {
  try {
    if (!path.isAbsolute(value) || value.includes("\0")) throw new Error();
    const stat = fs.lstatSync(value);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error();
    const resolved = fs.realpathSync.native(value);
    const parentReal = fs.realpathSync.native(path.dirname(value));
    if (path.relative(resolved, path.join(parentReal, path.basename(path.resolve(value)))) !== "") throw new Error();
    if (platform === "win32") {
      if (path.extname(value).toLowerCase() !== ".exe") throw new Error();
    } else if (platform === "linux" || platform === "darwin") {
      if ((stat.mode & 0o111) === 0) throw new Error();
    } else {
      throw new Error();
    }
  } catch {
    throw new ChromiumLaunchError("process_spawn");
  }
}

function readableStream(value: unknown): value is Readable {
  return typeof value === "object" && value !== null && typeof (value as Readable).on === "function" && typeof (value as Readable).read === "function";
}

function writableStream(value: unknown): value is Writable {
  return typeof value === "object" && value !== null && typeof (value as Writable).write === "function";
}

function boundedReadyDeadline(value: number | undefined): number {
  return Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 60_000 ? Number(value) : DEFAULT_READY_DEADLINE_MS;
}

function boundedDiagnosticBytes(value: number | undefined): number {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 64 * 1024 ? Number(value) : DEFAULT_STDERR_DIAGNOSTIC_BYTES;
}

function captureBoundedStderr(stderr: Readable | null, cap: number): MutableDiagnostics {
  const state: MutableDiagnostics = { observed: 0, retained: 0, truncated: false };
  stderr?.on("data", (chunk: Buffer | string) => {
    const bytes = Buffer.byteLength(chunk);
    const observedCap = Math.min(Number.MAX_SAFE_INTEGER, cap + 1);
    state.observed = Math.min(observedCap, state.observed + Math.min(bytes, observedCap));
    const available = Math.max(0, cap - state.retained);
    state.retained += Math.min(available, bytes);
    if (bytes > available) state.truncated = true;
  });
  return state;
}

function protocolReadyWhileRunning(transport: PrivateCdpTransport, child: ChildProcess, timeoutMs: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const failed = () => finish(null);
    const timer = setTimeout(failed, timeoutMs);
    timer.unref();
    const cleanup = () => {
      clearTimeout(timer);
      child.off("error", failed);
      child.off("exit", failed);
    };
    const finish = (targetId: string | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (targetId) resolve(targetId);
      else reject(new ChromiumLaunchError("protocol_readiness"));
    };
    child.once("error", failed);
    child.once("exit", failed);
    transport.send("Browser.getVersion").then(async (response) => {
      if (typeof response.protocolVersion !== "string" || response.protocolVersion.length === 0) {
        finish(null);
        return;
      }
      try {
        const created = await transport.send("Target.createTarget", { url: "about:blank" });
        const keys = Object.keys(created);
        const targetId = created.targetId;
        finish(keys.length === 1 && typeof targetId === "string" && /^[A-Za-z0-9._:-]{1,256}$/u.test(targetId) ? targetId : null);
      } catch { finish(null); }
    }, failed);
  });
}

async function cleanupFailedLaunch(
  child: ChildProcess,
  options: ChromiumLaunchOptions,
  browserPid = child.pid,
): Promise<Readonly<{ confirmed: boolean; retry?: () => Promise<void> }>> {
  const supervisor = new ProcessSupervisor({
    child: supervisedBrowserProcess(child, Number(browserPid)),
    ...(options.platform === undefined ? {} : { platform: options.platform }),
    ...(options.killTree === undefined ? {} : { killTree: options.killTree }),
    gracefulDeadlineMs: 1,
    killDeadlineMs: 5_000,
  });
  try { await supervisor.terminate(); return { confirmed: true }; } catch (error) {
    if (error instanceof ProcessCleanupError) return { confirmed: false, retry: () => supervisor.terminate() };
    return { confirmed: false, retry: () => supervisor.terminate() };
  }
}

async function spawnGuardedChromium(
  executablePath: string,
  args: readonly string[],
  cleanupPlan: GuardianProfileCleanupPlan,
  timeoutMs: number,
): Promise<Readonly<{ child: ChildProcess; browserPid: number }>> {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const guardianPath = [
    path.join(moduleDirectory, "browser-guardian.js"),
    path.resolve(moduleDirectory, "..", "..", "dist", "browser-guardian.js"),
  ].find((candidate) => fs.existsSync(candidate));
  if (!guardianPath) throw new ChromiumLaunchError("process_spawn");
  const child = nodeSpawn(process.execPath, [guardianPath], {
    detached: true,
    stdio: ["ignore", "ignore", "pipe", "pipe", "pipe", "ipc"],
    windowsHide: true,
  });
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(null), timeoutMs);
    timer.unref();
    const failed = () => finish(null);
    const onMessage = (message: unknown) => {
      if (!message || typeof message !== "object") return;
      const record = message as Record<string, unknown>;
      if (record.type === "ready" && Number.isSafeInteger(record.pid) && Number(record.pid) > 0) {
        finish(Number(record.pid));
      } else if (record.type === "guardian_error") finish(null);
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.off("error", failed);
      child.off("exit", failed);
      child.off("message", onMessage);
    };
    const finish = (pid: number | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (pid !== null) resolve({ child, browserPid: pid });
      else {
        void stopGuardian(child).then(
          () => reject(new ChromiumLaunchError("process_spawn")),
          () => reject(new ChromiumLaunchError("process_spawn", true, () => stopGuardian(child))),
        );
      }
    };
    child.once("error", failed);
    child.once("exit", failed);
    child.on("message", onMessage);
    child.send?.({ type: "launch", executablePath, args: [...args], cleanup: cleanupPlan }, (error) => { if (error) finish(null); });
  });
}

function stopGuardian(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(false), 10_000);
    timer.unref();
    const onExit = () => finish(true);
    const onError = () => finish(false);
    const finish = (confirmed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      child.off("error", onError);
      if (confirmed || child.exitCode !== null || child.signalCode !== null) resolve();
      else reject(new Error("guardian_cleanup_unconfirmed"));
    };
    child.once("exit", onExit);
    child.once("error", onError);
    if (!child.kill("SIGTERM") && child.exitCode === null && child.signalCode === null) finish(false);
  });
}

function supervisedBrowserProcess(child: ChildProcess, browserPid: number): SupervisedChild {
  return {
    pid: browserPid,
    get exitCode() { return child.exitCode; },
    get signalCode() { return child.signalCode; },
    once(event, listener) { child.once(event, listener); return this; },
    off(event, listener) { child.off(event, listener); return this; },
    kill(signal) { return child.kill(signal); },
  };
}
