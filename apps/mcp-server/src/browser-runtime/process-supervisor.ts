import { once } from "node:events";
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";

export type ProcessSupervisorState = "running" | "terminating" | "terminated" | "uncertain";
export type ProcessCleanupPhase = "graceful_close" | "tree_kill" | "exit_confirmation";

export class ProcessCleanupError extends Error {
  readonly code = "browser_cleanup_uncertain";
  readonly phase: ProcessCleanupPhase;

  constructor(phase: ProcessCleanupPhase) {
    super("Browser process cleanup could not be confirmed.");
    this.name = "ProcessCleanupError";
    this.phase = phase;
  }
}

export interface SupervisedChild {
  readonly pid?: number;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  off(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export type ProcessSupervisorOptions = Readonly<{
  child: SupervisedChild;
  platform?: NodeJS.Platform;
  gracefulClose?: () => Promise<void>;
  killTree?: (pid: number, platform: NodeJS.Platform) => Promise<void>;
  gracefulDeadlineMs?: number;
  killDeadlineMs?: number;
}>;

export class ProcessSupervisor {
  private readonly child: SupervisedChild;
  private readonly platform: NodeJS.Platform;
  private readonly gracefulClose: (() => Promise<void>) | null;
  private readonly killTree: (pid: number, platform: NodeJS.Platform) => Promise<void>;
  private readonly gracefulDeadlineMs: number;
  private readonly killDeadlineMs: number;
  private currentState: ProcessSupervisorState;
  private termination: Promise<void> | null = null;

  constructor(options: ProcessSupervisorOptions) {
    this.child = options.child;
    this.platform = options.platform ?? process.platform;
    this.gracefulClose = options.gracefulClose ?? null;
    this.killTree = options.killTree ?? defaultKillTree;
    this.gracefulDeadlineMs = boundedDeadline(options.gracefulDeadlineMs, 5_000);
    this.killDeadlineMs = boundedDeadline(options.killDeadlineMs, 5_000);
    this.currentState = alreadyExited(this.child) ? "terminated" : "running";
  }

  get state(): ProcessSupervisorState { return this.currentState; }

  terminate(): Promise<void> {
    if (this.currentState === "terminated") return Promise.resolve();
    if (this.termination) return this.termination;
    this.currentState = "terminating";
    const operation = this.performTermination();
    this.termination = operation.finally(() => { this.termination = null; });
    return this.termination;
  }

  private async performTermination(): Promise<void> {
    if (alreadyExited(this.child)) {
      this.currentState = "terminated";
      return;
    }

    if (this.gracefulClose) {
      try {
        await withinDeadline(this.gracefulClose(), this.gracefulDeadlineMs);
        await waitForExitWithin(this.child, this.gracefulDeadlineMs);
        this.currentState = "terminated";
        return;
      } catch {
        // A failed or unacknowledged graceful close falls through to exact tree cleanup.
      }
    }

    const pid = this.child.pid;
    if (!Number.isSafeInteger(pid) || Number(pid) <= 0) {
      this.currentState = "uncertain";
      throw new ProcessCleanupError("tree_kill");
    }
    try {
      await withinDeadline(this.killTree(Number(pid), this.platform), this.killDeadlineMs);
    } catch {
      this.currentState = "uncertain";
      throw new ProcessCleanupError("tree_kill");
    }
    try {
      await waitForExitWithin(this.child, this.killDeadlineMs);
    } catch {
      this.currentState = "uncertain";
      throw new ProcessCleanupError("exit_confirmation");
    }
    this.currentState = "terminated";
  }
}

export async function defaultKillTree(pid: number, platform: NodeJS.Platform): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new ProcessCleanupError("tree_kill");
  if (platform === "win32") {
    const child = nodeSpawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    const [code] = await once(child, "exit") as [number | null, NodeJS.Signals | null];
    if (code !== 0 && code !== 128) throw new ProcessCleanupError("tree_kill");
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ESRCH") throw new ProcessCleanupError("tree_kill");
  }
}

function alreadyExited(child: SupervisedChild): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForExitWithin(child: SupervisedChild, timeoutMs: number): Promise<void> {
  if (alreadyExited(child)) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const exited = () => { cleanup(); resolve(); };
    const timer = setTimeout(() => { cleanup(); reject(new ProcessCleanupError("exit_confirmation")); }, timeoutMs);
    timer.unref();
    const cleanup = () => {
      clearTimeout(timer);
      child.off("exit", exited);
    };
    child.once("exit", exited);
  });
}

function boundedDeadline(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 60_000 ? Number(value) : fallback;
}

function withinDeadline<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ProcessCleanupError("exit_confirmation")), timeoutMs);
    timer.unref();
    operation.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error); },
    );
  });
}

export type SpawnedChildProcess = ChildProcess;
