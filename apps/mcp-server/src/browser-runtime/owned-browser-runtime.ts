import type { ChildProcess, SpawnOptions } from "node:child_process";

import {
  ChromiumLaunchError,
  ChromiumProcess,
  launchChromium,
  type ChromiumLaunchOptions,
} from "./chromium-process.ts";
import {
  acquireNewtonIdentityLease,
  acknowledgeGuardianProfileCleanup,
  guardianProfileCleanupPlan,
  releaseNewtonIdentityLease,
  validateNewtonIdentityLease,
  type NewtonIdentityLease,
  type ProfileStore,
} from "./profile-store.ts";
import {
  startPolicyProxy,
  type PolicyProxy,
} from "./policy-proxy.ts";

export type OwnedBrowserFamily = "chrome" | "edge";
export type OwnedBrowserRuntimePhase =
  | "proxy_start"
  | "identity_lease"
  | "browser_start"
  | "browser_cleanup"
  | "proxy_cleanup"
  | "lease_release";

export class OwnedBrowserRuntimeError extends Error {
  readonly code = "owned_browser_runtime_failed";
  readonly phase: OwnedBrowserRuntimePhase;
  readonly cleanupUncertain: boolean;
  private readonly cleanupRetry: (() => Promise<void>) | undefined;

  constructor(phase: OwnedBrowserRuntimePhase, cleanupUncertain = false, cleanupRetry?: () => Promise<void>) {
    super("Owned browser runtime operation failed.");
    this.name = "OwnedBrowserRuntimeError";
    this.phase = phase;
    this.cleanupUncertain = cleanupUncertain;
    this.cleanupRetry = cleanupRetry;
  }

  retryCleanup(): Promise<void> {
    if (this.cleanupRetry) return this.cleanupRetry();
    return this.cleanupUncertain
      ? Promise.reject(new OwnedBrowserRuntimeError(this.phase, true))
      : Promise.resolve();
  }
}

export type OwnedBrowserRuntimeReceipt = Readonly<{
  status: "ready";
  identityId: string;
  browserFamily: OwnedBrowserFamily;
  pid: number;
}>;

export type OwnedDriverBootstrap = Readonly<{
  transport: ChromiumProcess["transport"];
  rootTargetId: string;
}>;

const OWNED_RUNTIME_CAPABILITY = Object.freeze({ kind: "owned_browser_runtime" });

type SpawnLike = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export type LaunchOwnedBrowserRuntimeOptions = Readonly<{
  executablePath: string;
  browserFamily: OwnedBrowserFamily;
  profileStore: ProfileStore;
  identityId: string;
  allowedOrigins: readonly string[];
  headless?: boolean;
  readyDeadlineMs?: number;
  stderrDiagnosticBytes?: number;
  spawn?: SpawnLike;
  transportFactory?: ChromiumLaunchOptions["transportFactory"];
  killTree?: ChromiumLaunchOptions["killTree"];
  platform?: NodeJS.Platform;
  ephemeralIdentity?: boolean;
  startProxy?: typeof startPolicyProxy;
}>;

export class OwnedBrowserRuntime {
  readonly receipt: OwnedBrowserRuntimeReceipt;
  readonly unavailable: Promise<void>;
  private readonly process: ChromiumProcess;
  private readonly proxy: PolicyProxy;
  private readonly lease: NewtonIdentityLease;
  private processClosed = false;
  private proxyClosed = false;
  private leaseReleased = false;
  private state: "ready" | "closing" | "cleanup_uncertain" | "closed" = "ready";
  private closeOperation: Promise<void> | undefined;
  private readonly bootstrap: OwnedDriverBootstrap;
  private readonly allowedOriginFingerprint: string;
  private bootstrapClaimed = false;

  constructor(capability: object, input: {
    process: ChromiumProcess;
    proxy: PolicyProxy;
    lease: NewtonIdentityLease;
    allowedOriginFingerprint: string;
  }) {
    if (capability !== OWNED_RUNTIME_CAPABILITY) throw new OwnedBrowserRuntimeError("browser_start");
    this.process = input.process;
    this.proxy = input.proxy;
    this.lease = input.lease;
    this.allowedOriginFingerprint = input.allowedOriginFingerprint;
    this.receipt = Object.freeze({
      status: "ready",
      identityId: input.lease.id,
      browserFamily: input.lease.browserFamily,
      pid: input.process.pid,
    });
    this.bootstrap = Object.freeze({
      transport: input.process.transport,
      rootTargetId: input.process.rootTargetId,
    });
    this.unavailable = Promise.race([input.process.exited, input.proxy.closed]).then(() => undefined);
    void input.proxy.closed.then(() => this.handleUnexpectedProxyLoss());
    void input.process.exited.then(() => this.handleUnexpectedProcessExit());
  }

  cleanupState(): "ready" | "closing" | "cleanup_uncertain" | "closed" {
    return this.state;
  }

  claimDriverBootstrap(allowedOrigins: readonly string[]): OwnedDriverBootstrap {
    if (this.process.exitedConfirmed()) this.handleUnexpectedProcessExit();
    if (this.state !== "ready") throw new OwnedBrowserRuntimeError("browser_cleanup", this.state === "cleanup_uncertain");
    let fingerprint: string;
    try { fingerprint = normalizedOriginFingerprint(allowedOrigins); } catch { throw new OwnedBrowserRuntimeError("browser_start"); }
    if (this.bootstrapClaimed || fingerprint !== this.allowedOriginFingerprint) {
      throw new OwnedBrowserRuntimeError("browser_start");
    }
    this.bootstrapClaimed = true;
    return this.bootstrap;
  }

  close(): Promise<void> {
    if (this.state === "closed") return Promise.resolve();
    if (this.closeOperation) return this.closeOperation;
    this.state = "closing";
    const operation = this.closeAttempt();
    this.closeOperation = operation;
    void operation.finally(() => {
      if (this.closeOperation === operation) this.closeOperation = undefined;
    }).catch(() => {});
    return operation;
  }

  private async closeAttempt(): Promise<void> {
    if (!this.processClosed) {
      try { await this.process.close(); } catch {
        this.state = "cleanup_uncertain";
        throw new OwnedBrowserRuntimeError("browser_cleanup", true);
      }
      this.processClosed = true;
    }
    if (!this.proxyClosed) {
      try { await this.proxy.close(); } catch {
        this.state = "cleanup_uncertain";
        throw new OwnedBrowserRuntimeError("proxy_cleanup", true);
      }
      this.proxyClosed = true;
    }
    if (!this.leaseReleased) {
      try {
        if (this.process.guardianManagedProfileCleanup) acknowledgeGuardianProfileCleanup(this.lease);
        else releaseNewtonIdentityLease(this.lease);
      } catch {
        this.state = "cleanup_uncertain";
        throw new OwnedBrowserRuntimeError("lease_release", true);
      }
      this.leaseReleased = true;
    }
    this.state = "closed";
  }

  private handleUnexpectedProxyLoss(): void {
    if (this.state !== "ready") return;
    this.proxyClosed = true;
    this.state = "closing";
    const operation = this.closeAttempt();
    this.closeOperation = operation;
    void operation.finally(() => {
      if (this.closeOperation === operation) this.closeOperation = undefined;
    }).catch(() => {});
  }

  private handleUnexpectedProcessExit(): void {
    if (this.state !== "ready") return;
    this.state = "closing";
    const operation = this.closeAttempt();
    this.closeOperation = operation;
    void operation.finally(() => {
      if (this.closeOperation === operation) this.closeOperation = undefined;
    }).catch(() => {});
  }
}

export async function launchOwnedBrowserRuntime(options: LaunchOwnedBrowserRuntimeOptions): Promise<OwnedBrowserRuntime> {
  let allowedOriginFingerprint: string;
  try { allowedOriginFingerprint = normalizedOriginFingerprint(options.allowedOrigins); } catch {
    throw new OwnedBrowserRuntimeError("proxy_start");
  }
  let proxy: PolicyProxy;
  try { proxy = await (options.startProxy ?? startPolicyProxy)({ allowedOrigins: options.allowedOrigins }); } catch {
    throw new OwnedBrowserRuntimeError("proxy_start");
  }

  let lease: NewtonIdentityLease;
  try { lease = acquireNewtonIdentityLease(options.profileStore, options.identityId); } catch {
    await closeProxyAfterStartupFailure(proxy);
    throw new OwnedBrowserRuntimeError("identity_lease");
  }

  if (lease.browserFamily !== options.browserFamily) {
    await rollbackLeaseAndProxy(lease, proxy);
    throw new OwnedBrowserRuntimeError("identity_lease");
  }

  let process: ChromiumProcess;
  try {
    process = await launchChromium({
      executablePath: options.executablePath,
      userDataDir: lease.path,
      ...(options.headless === undefined ? {} : { headless: options.headless }),
      ...(options.readyDeadlineMs === undefined ? {} : { readyDeadlineMs: options.readyDeadlineMs }),
      ...(options.stderrDiagnosticBytes === undefined ? {} : { stderrDiagnosticBytes: options.stderrDiagnosticBytes }),
      ...(options.spawn === undefined ? {} : { spawn: options.spawn }),
      ...(options.transportFactory === undefined ? {} : { transportFactory: options.transportFactory }),
      profileLease: lease,
      validateOwnedProfileLease: (directory, candidate) => candidate === lease && validateNewtonIdentityLease(lease, directory),
      ...(options.killTree === undefined ? {} : { killTree: options.killTree }),
      ...(options.platform === undefined ? {} : { platform: options.platform }),
      policyProxy: proxy,
      guardianProfileCleanup: guardianProfileCleanupPlan(lease, options.ephemeralIdentity === true),
    });
  } catch (error) {
    if (error instanceof ChromiumLaunchError && error.cleanupUncertain) {
      const retry = async () => {
        await error.retryCleanup();
        await rollbackLeaseAndProxy(lease, proxy, options.spawn === undefined);
      };
      throw new OwnedBrowserRuntimeError("browser_start", true, retry);
    }
    await rollbackLeaseAndProxy(lease, proxy, options.spawn === undefined);
    throw new OwnedBrowserRuntimeError("browser_start");
  }

  return new OwnedBrowserRuntime(OWNED_RUNTIME_CAPABILITY, { process, proxy, lease, allowedOriginFingerprint });
}

function normalizedOriginFingerprint(origins: readonly string[]): string {
  if (!Array.isArray(origins) || origins.length < 1 || origins.length > 32) throw new Error("invalid_origin_grant");
  const normalized = new Set<string>();
  for (const value of origins) {
    if (typeof value !== "string" || value.length < 1 || value.length > 512) throw new Error("invalid_origin_grant");
    let parsed: URL;
    try { parsed = new URL(value); } catch { throw new Error("invalid_origin_grant"); }
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password
      || parsed.pathname !== "/" || parsed.search || parsed.hash) throw new Error("invalid_origin_grant");
    normalized.add(parsed.origin);
  }
  return [...normalized].sort().join("\n");
}

async function rollbackLeaseAndProxy(
  lease: NewtonIdentityLease,
  proxy: PolicyProxy,
  guardianManaged = false,
): Promise<void> {
  let leaseReleased = false;
  let proxyClosed = false;
  const retry = async (): Promise<void> => {
    let failedPhase: OwnedBrowserRuntimePhase | null = null;
    if (!proxyClosed) {
      try { await proxy.close(); proxyClosed = true; }
      catch { failedPhase ??= "proxy_cleanup"; }
    }
    if (proxyClosed && !leaseReleased) {
      try {
        if (guardianManaged) acknowledgeGuardianProfileCleanup(lease);
        else releaseNewtonIdentityLease(lease);
        leaseReleased = true;
      }
      catch { failedPhase ??= "lease_release"; }
    }
    if (failedPhase) throw new OwnedBrowserRuntimeError(failedPhase, true, retry);
  };
  await retry();
}

async function closeProxyAfterStartupFailure(proxy: PolicyProxy): Promise<void> {
  const retry = async (): Promise<void> => {
    try { await proxy.close(); }
    catch { throw new OwnedBrowserRuntimeError("proxy_cleanup", true, retry); }
  };
  await retry();
}
