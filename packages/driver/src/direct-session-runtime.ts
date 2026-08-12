import { createDirectDebuggerPort } from "./direct-debugger-port.js";
import type { BrowserLevelTransport } from "./direct-debugger-port.js";
import { createDirectPageEffectsPort } from "./direct-page-effects-port.js";
import { createNewtonBrowserDriver } from "./driver.js";
import { SessionCommandPump } from "./session-command-pump.js";
import type { SessionCommandPumpOptions } from "./session-command-pump.js";
import type {
  BrowserDriverOptions,
  DriverAction,
  DriverContext,
  DriverObservation,
  DriverRecord,
  ObserveOptions,
} from "./types.js";

type DirectSessionState = "active" | "stopping" | "detach_uncertain" | "stopped";

export type DirectDriverBootstrap = Readonly<{
  transport: BrowserLevelTransport;
  rootTargetId: string;
  syntheticTabId: number;
}>;

export type DirectSessionDriver = {
  attach(tabId: number): Promise<void>;
  detach(): Promise<void>;
  navigateInitialGranted(url: string): Promise<unknown>;
  observe(options?: ObserveOptions): Promise<DriverObservation>;
  preflightAction?(action: DriverAction): Promise<void> | void;
  executeAction(action: DriverAction, context?: DriverContext): Promise<DriverRecord>;
};

export type DirectSessionDriverFactory = (options: BrowserDriverOptions) => DirectSessionDriver;

export type StartDirectDriverSessionOptions = Readonly<{
  bootstrap: DirectDriverBootstrap;
  primaryOrigin: string;
  allowedOrigins: readonly string[];
  initialUrl: string;
  initialObservation?: true | ObserveOptions;
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

type QueuedCommand = Readonly<{ action: DriverAction; context: DriverContext }>;

export type DirectDriverSession = Readonly<{
  initialObservation: DriverObservation | undefined;
  execute(action: DriverAction, context?: DriverContext, timeoutMs?: number): Promise<DriverRecord>;
  stop(): Promise<void>;
  snapshot(): DirectDriverSessionSnapshot;
}>;

class DirectDriverSessionRuntime implements DirectDriverSession {
  readonly initialObservation: DriverObservation | undefined;
  readonly #driver: DirectSessionDriver;
  readonly #pump: SessionCommandPump;
  #state: DirectSessionState = "active";
  #stopAttempt: Promise<void> | null = null;

  constructor(
    driver: DirectSessionDriver,
    pump: SessionCommandPump,
    initialObservation: DriverObservation | undefined,
  ) {
    this.#driver = driver;
    this.#pump = pump;
    this.initialObservation = initialObservation;
  }

  execute(action: DriverAction, context: DriverContext = {}, timeoutMs?: number): Promise<DriverRecord> {
    const serialized = serializeCommand(action, context);
    const command = JSON.parse(serialized) as QueuedCommand;
    const bytes = new TextEncoder().encode(serialized).byteLength;
    return this.#pump.enqueue(command, bytes, async (item) => {
      await this.#driver.preflightAction?.(item.action);
      return this.#driver.executeAction(item.action, item.context);
    }, timeoutMs);
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
    tabId: configuration.bootstrap.syntheticTabId,
  });
  const pageEffectsPort = createDirectPageEffectsPort({
    syntheticTabId: configuration.bootstrap.syntheticTabId,
    sendRootCommand: (method, params) => debuggerPort.sendCommand(
      { tabId: configuration.bootstrap.syntheticTabId },
      method,
      params,
    ),
  });
  const driverFactory = options.driverFactory ?? createNewtonBrowserDriver;
  const driver = driverFactory({
    ownsTab: true,
    ownsBrowser: true,
    allowedOrigins: [configuration.primaryOrigin, ...configuration.allowedOrigins],
    debuggerPort,
    pageEffectsPort,
  });

  try {
    await driver.attach(configuration.bootstrap.syntheticTabId);
    await driver.navigateInitialGranted(configuration.initialUrl);
    const initialObservation = configuration.initialObservation === undefined
      ? undefined
      : await driver.observe(configuration.initialObservation === true ? {} : configuration.initialObservation);
    return new DirectDriverSessionRuntime(driver, new SessionCommandPump(options.pump), initialObservation);
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
  primaryOrigin: string;
  allowedOrigins: string[];
  initialUrl: string;
  initialObservation: true | ObserveOptions | undefined;
} {
  if (!options || typeof options !== "object") throw directSessionError("direct_session_invalid_configuration");
  const bootstrap = options.bootstrap;
  if (!bootstrap || typeof bootstrap !== "object"
    || !hasExactKeys(bootstrap, ["rootTargetId", "syntheticTabId", "transport"])) {
    throw directSessionError("direct_session_invalid_bootstrap");
  }
  if (!bootstrap.transport || typeof bootstrap.transport.send !== "function" || typeof bootstrap.transport.onEvent !== "function"
    || typeof bootstrap.rootTargetId !== "string" || bootstrap.rootTargetId.length === 0
    || !Number.isSafeInteger(bootstrap.syntheticTabId) || bootstrap.syntheticTabId < 0) {
    throw directSessionError("direct_session_invalid_bootstrap");
  }
  const primaryOrigin = exactHttpOrigin(options.primaryOrigin);
  if (!primaryOrigin || !Array.isArray(options.allowedOrigins)) {
    throw directSessionError("direct_session_invalid_origin_grant");
  }
  const allowedOrigins: string[] = [];
  const seen = new Set([primaryOrigin]);
  for (const candidate of options.allowedOrigins) {
    const origin = exactHttpOrigin(candidate);
    if (!origin || seen.has(origin)) throw directSessionError("direct_session_invalid_origin_grant");
    seen.add(origin);
    allowedOrigins.push(origin);
  }
  let initial: URL;
  try {
    initial = new URL(options.initialUrl);
  } catch {
    throw directSessionError("direct_session_invalid_initial_url");
  }
  if ((initial.protocol !== "http:" && initial.protocol !== "https:") || initial.origin !== primaryOrigin) {
    throw directSessionError("direct_session_invalid_initial_url");
  }
  if (options.initialObservation !== undefined && options.initialObservation !== true
    && (!options.initialObservation || typeof options.initialObservation !== "object" || Array.isArray(options.initialObservation))) {
    throw directSessionError("direct_session_invalid_configuration");
  }
  return {
    bootstrap,
    primaryOrigin,
    allowedOrigins,
    initialUrl: initial.href,
    initialObservation: options.initialObservation,
  };
}

function exactHttpOrigin(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) return null;
  try {
    const parsed = new URL(value);
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.origin !== value) return null;
    return value;
  } catch {
    return null;
  }
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
