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
export type OwnedBrowserFamily = "chrome" | "edge";
export type OwnedBrowserRuntimePhase =
  | "identity_lease"
  | "browser_start"
  | "browser_cleanup"
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
  headless?: boolean;
  readyDeadlineMs?: number;
  stderrDiagnosticBytes?: number;
  spawn?: SpawnLike;
  transportFactory?: ChromiumLaunchOptions["transportFactory"];
  killTree?: ChromiumLaunchOptions["killTree"];
  platform?: NodeJS.Platform;
  ephemeralIdentity?: boolean;
}>;

export class OwnedBrowserRuntime {
  readonly receipt: OwnedBrowserRuntimeReceipt;
  readonly unavailable: Promise<void>;
  private readonly process: ChromiumProcess;
  private readonly lease: NewtonIdentityLease;
  private processClosed = false;
  private leaseReleased = false;
  private state: "ready" | "closing" | "cleanup_uncertain" | "closed" = "ready";
  private closeOperation: Promise<void> | undefined;
  private readonly bootstrap: OwnedDriverBootstrap;
  private bootstrapClaimed = false;

  constructor(capability: object, input: {
    process: ChromiumProcess;
    lease: NewtonIdentityLease;
  }) {
    if (capability !== OWNED_RUNTIME_CAPABILITY) throw new OwnedBrowserRuntimeError("browser_start");
    this.process = input.process;
    this.lease = input.lease;
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
    this.unavailable = input.process.exited;
    void input.process.exited.then(() => this.handleUnexpectedProcessExit());
  }

  cleanupState(): "ready" | "closing" | "cleanup_uncertain" | "closed" {
    return this.state;
  }

  claimDriverBootstrap(): OwnedDriverBootstrap {
    if (this.process.exitedConfirmed()) this.handleUnexpectedProcessExit();
    if (this.state !== "ready") throw new OwnedBrowserRuntimeError("browser_cleanup", this.state === "cleanup_uncertain");
    if (this.bootstrapClaimed) throw new OwnedBrowserRuntimeError("browser_start");
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
  let lease: NewtonIdentityLease;
  try { lease = acquireNewtonIdentityLease(options.profileStore, options.identityId); } catch {
    throw new OwnedBrowserRuntimeError("identity_lease");
  }

  if (lease.browserFamily !== options.browserFamily) {
    await rollbackLease(lease);
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
      guardianProfileCleanup: guardianProfileCleanupPlan(lease, options.ephemeralIdentity === true),
    });
  } catch (error) {
    if (error instanceof ChromiumLaunchError && error.cleanupUncertain) {
      const retry = async () => {
        await error.retryCleanup();
        await rollbackLease(lease, options.spawn === undefined);
      };
      throw new OwnedBrowserRuntimeError("browser_start", true, retry);
    }
    await rollbackLease(lease, options.spawn === undefined);
    throw new OwnedBrowserRuntimeError("browser_start");
  }

  return new OwnedBrowserRuntime(OWNED_RUNTIME_CAPABILITY, { process, lease });
}

async function rollbackLease(
  lease: NewtonIdentityLease,
  guardianManaged = false,
): Promise<void> {
  let leaseReleased = false;
  const retry = async (): Promise<void> => {
    let failedPhase: OwnedBrowserRuntimePhase | null = null;
    if (!leaseReleased) {
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
