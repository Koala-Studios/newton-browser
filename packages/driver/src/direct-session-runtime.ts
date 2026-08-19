import { createDirectDebuggerPort } from "./direct-debugger-port.js";
import type { BrowserLevelTransport } from "./direct-debugger-port.js";
import { createNewtonBrowserDriver } from "./driver.js";
import { SessionCommandPump } from "./session-command-pump.js";
import type { SessionCommandPumpOptions } from "./session-command-pump.js";
import type {
  BrowserDriverOptions,
  DriverAction,
  DriverContext,
  DriverRecord,
} from "./types.js";

export type { DriverAction } from "./types.js";

type DirectSessionState = "active" | "stopping" | "detach_uncertain" | "stopped";

export type DirectDriverBootstrap = Readonly<{
  transport: BrowserLevelTransport;
  rootTargetId: string;
}>;

export type DirectSessionDriver = {
  attach(): Promise<void>;
  detach(): Promise<void>;
  navigateInitial(url: string): Promise<unknown>;
  preflightAction?(action: DriverAction): Promise<void> | void;
  resolveEvidence?(action: DriverAction): Promise<DriverRecord>;
  executeAction(action: DriverAction, context?: DriverContext): Promise<DriverRecord>;
};

export type DirectSessionDriverFactory = (options: BrowserDriverOptions) => DirectSessionDriver;

export type StartDirectDriverSessionOptions = Readonly<{
  bootstrap: DirectDriverBootstrap;
  initialUrl: string;
  signal?: AbortSignal;
  pump?: SessionCommandPumpOptions;
  driverFactory?: DirectSessionDriverFactory;
}>;

export type DirectDriverSessionSnapshot = Readonly<{
  state: DirectSessionState;
  runningCommands: number;
  queuedCommands: number;
  runningBytes: number;
  queuedBytes: number;
  queueClosed: boolean;
}>;

export type DirectPreDispatchGuard = (evidence: DriverRecord) => Promise<void> | void;

type QueuedCommand = Readonly<{
  action: DriverAction;
  context: DriverContext;
  guard?: DirectPreDispatchGuard;
}>;

export type DirectDriverSession = Readonly<{
  execute(
    action: DriverAction,
    context?: DriverContext,
    timeoutMs?: number,
    signal?: AbortSignal,
    guard?: DirectPreDispatchGuard,
  ): Promise<DriverRecord>;
  stop(): Promise<void>;
  snapshot(): DirectDriverSessionSnapshot;
}>;

class DirectDriverSessionRuntime implements DirectDriverSession {
  readonly #driver: DirectSessionDriver;
  readonly #pump: SessionCommandPump;
  #state: DirectSessionState = "active";
  #stopAttempt: Promise<void> | null = null;

  constructor(
    driver: DirectSessionDriver,
    pump: SessionCommandPump,
  ) {
    this.#driver = driver;
    this.#pump = pump;
  }

  execute(
    action: DriverAction,
    context: DriverContext = {},
    timeoutMs?: number,
    signal?: AbortSignal,
    guard?: DirectPreDispatchGuard,
  ): Promise<DriverRecord> {
    const serialized = serializeCommand(action, context);
    const parsed = JSON.parse(serialized) as Omit<QueuedCommand, "guard">;
    const command: QueuedCommand = { ...parsed, ...(guard ? { guard } : {}) };
    const bytes = new TextEncoder().encode(serialized).byteLength;
    return this.#pump.enqueue(command, bytes, async (item) => {
      await this.#driver.preflightAction?.(item.action);
      if (item.guard) {
        if (!this.#driver.resolveEvidence) throw directSessionError("direct_session_evidence_unavailable");
        const evidence = await this.#driver.resolveEvidence(item.action);
        await item.guard(evidence);
      }
      return this.#driver.executeAction(item.action, item.context);
    }, timeoutMs, signal);
  }

  stop(): Promise<void> {
    if (this.#state === "stopped") return Promise.resolve();
    if (this.#stopAttempt) return this.#stopAttempt;
    this.#stopAttempt = this.completeStop().finally(() => {
      this.#stopAttempt = null;
    });
    return this.#stopAttempt;
  }

  snapshot(): DirectDriverSessionSnapshot {
    const queue = this.#pump.snapshot();
    return {
      state: this.#state,
      runningCommands: queue.runningCount,
      queuedCommands: queue.queueLength,
      runningBytes: queue.runningBytes,
      queuedBytes: queue.queuedBytes,
      queueClosed: queue.closed,
    };
  }

  private async completeStop(): Promise<void> {
    if (this.#state === "active") {
      this.#state = "stopping";
      await this.#pump.closeAfterCurrent();
    }
    try {
      await this.#driver.detach();
    } catch (error) {
      this.#state = "detach_uncertain";
      throw error;
    }
    this.#state = "stopped";
  }
}

export async function startDirectDriverSession(
  options: StartDirectDriverSessionOptions,
): Promise<DirectDriverSession> {
  const configuration = validateConfiguration(options);
  const debuggerPort = createDirectDebuggerPort({
    transport: configuration.bootstrap.transport,
    rootTargetId: configuration.bootstrap.rootTargetId,
  });
  const driverFactory = options.driverFactory ?? createNewtonBrowserDriver;
  const driver = driverFactory({ debuggerPort });

  try {
    configuration.signal?.throwIfAborted();
    await driver.attach();
    configuration.signal?.throwIfAborted();
    await driver.navigateInitial(configuration.initialUrl);
    configuration.signal?.throwIfAborted();
    return new DirectDriverSessionRuntime(driver, new SessionCommandPump(options.pump));
  } catch (error) {
    try {
      await driver.detach();
    } catch (cleanupError) {
      throw cleanupError;
    }
    throw error;
  }
}

function validateConfiguration(options: StartDirectDriverSessionOptions): {
  bootstrap: DirectDriverBootstrap;
  initialUrl: string;
  signal?: AbortSignal;
} {
  if (!options || typeof options !== "object") throw directSessionError("direct_session_invalid_configuration");
  const bootstrap = options.bootstrap;
  if (!bootstrap || typeof bootstrap !== "object"
    || !hasExactKeys(bootstrap, ["rootTargetId", "transport"])) {
    throw directSessionError("direct_session_invalid_bootstrap");
  }
  if (!bootstrap.transport || typeof bootstrap.transport.send !== "function" || typeof bootstrap.transport.onEvent !== "function"
    || typeof bootstrap.rootTargetId !== "string" || bootstrap.rootTargetId.length === 0) {
    throw directSessionError("direct_session_invalid_bootstrap");
  }
  let initial: URL;
  try {
    initial = new URL(options.initialUrl);
  } catch {
    throw directSessionError("direct_session_invalid_initial_url");
  }
  if (initial.protocol !== "http:" && initial.protocol !== "https:") {
    throw directSessionError("direct_session_invalid_initial_url");
  }
  if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) {
    throw directSessionError("direct_session_invalid_abort_signal");
  }
  return {
    bootstrap,
    initialUrl: initial.href,
    ...(options.signal ? { signal: options.signal } : {}),
  };
}

function hasExactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function serializeCommand(action: DriverAction, context: DriverContext): string {
  try {
    const serialized = JSON.stringify({ action, context });
    if (typeof serialized !== "string") throw new Error("invalid");
    return serialized;
  } catch {
    throw directSessionError("direct_session_invalid_command");
  }
}

function directSessionError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
