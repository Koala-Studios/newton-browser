import { createHash, randomUUID } from "node:crypto";

import type {
  BridgeDispatchOptions,
  BridgeResultEvent,
  BrowserSessionCleanupDisposition,
  BridgeSessionInfo,
  BridgeSessionInit,
  BrowserAction,
} from "@newton-browser/core";
import {
  startDirectDriverSession,
  type DirectDriverSessionSnapshot,
  type StartDirectDriverSessionOptions,
} from "@newton-browser/driver/direct-session-runtime";

import type { OwnedBrowserFamily, OwnedDriverBootstrap } from "./owned-browser-runtime.ts";

const DEFAULT_MAX_SESSIONS = 8;
const DEFAULT_MAX_QUEUE_ITEMS = 32;
const DEFAULT_MAX_QUEUE_BYTES = 1024 * 1024;
const MAX_IDEMPOTENCY_ENTRIES = 256;
const IDEMPOTENCY_TTL_MS = 10 * 60 * 1_000;
const CONTAINMENT_REASONS = new Set([
  "ungranted_navigation",
  "ungranted_mutation",
  "ungranted_connection",
  "unsupported_ungranted_request",
  "ungranted_target",
]);

export type DirectOwnedRuntime = Readonly<{
  receipt: Readonly<{ identityId: string; browserFamily: OwnedBrowserFamily; pid: number; status: "ready" }>;
  claimDriverBootstrap(allowedOrigins: readonly string[]): OwnedDriverBootstrap;
  cleanupState(): "ready" | "closing" | "cleanup_uncertain" | "closed";
  unavailable: Promise<void>;
  close(): Promise<void>;
}>;

export type DirectHostSession = Readonly<{
  initialObservation?: unknown;
  execute(action: BrowserAction, context?: { commandId?: string }, timeoutMs?: number): Promise<Record<string, unknown>>;
  stop(): Promise<void>;
  snapshot(): DirectDriverSessionSnapshot;
}>;

export type DirectOwnedRuntimeFactory = (input: Readonly<{
  sessionId: string;
  init: BridgeSessionInit;
}>) => Promise<DirectOwnedRuntime>;

export type DirectDriverSessionFactory = (
  options: StartDirectDriverSessionOptions,
) => Promise<DirectHostSession>;

export type DirectBrowserHostOptions = Readonly<{
  launchOwnedRuntime: DirectOwnedRuntimeFactory;
  startDriverSession?: DirectDriverSessionFactory;
  hostInstanceId?: string;
  maxSessions?: number;
  maxQueueItems?: number;
  maxQueueBytes?: number;
}>;

export type DirectBrowserHost = ReturnType<typeof createDirectBrowserHost>;

type DirectControlAction =
  | { kind: "__stop" }
  | { kind: "__finalize"; disposition?: BrowserSessionCleanupDisposition };
type DirectHostAction = BrowserAction | DirectControlAction;

type IdempotencyEntry = Readonly<{
  hash: string;
  promise: Promise<BridgeResultEvent>;
  createdAt: number;
}>;

type SessionRecord = {
  info: BridgeSessionInfo;
  epoch: number;
  sequence: number;
  runtime: DirectOwnedRuntime | null;
  driver: DirectHostSession | null;
  provisioning: Promise<void>;
  setupError: string | null;
  cleanupRetained: boolean;
  startupCleanupRetry: (() => Promise<void>) | null;
  stopOperation: Promise<void> | null;
  driverStopOperation: Promise<void> | null;
  driverStopped: boolean;
  idempotency: Map<string, IdempotencyEntry>;
};

export function createDirectBrowserHost(options: DirectBrowserHostOptions) {
  if (!options || typeof options.launchOwnedRuntime !== "function") throw hostError("direct_host_invalid_configuration");
  const maxSessions = bounded(options.maxSessions, DEFAULT_MAX_SESSIONS, 64);
  const maxQueueItems = bounded(options.maxQueueItems, DEFAULT_MAX_QUEUE_ITEMS, 256);
  const maxQueueBytes = bounded(options.maxQueueBytes, DEFAULT_MAX_QUEUE_BYTES, 16 * 1024 * 1024);
  const hostInstanceId = validLabel(options.hostInstanceId) ?? `direct_${randomUUID()}`;
  const sessionFactory = options.startDriverSession ?? startDirectDriverSession;
  const sessions = new Map<string, SessionRecord>();
  let closed = false;
  let closeOperation: Promise<void> | null = null;

  const api = {
    hostInstanceId,

    listen(): Readonly<{ mode: "direct"; port: null }> {
      return Object.freeze({ mode: "direct", port: null });
    },

    createSession(init: BridgeSessionInit): { sessionId: string } {
      if (closed) throw hostError("direct_host_closed");
      if (sessions.size >= maxSessions) throw hostError("session_limit");
      const configuration = validateSessionInit(init);
      const sessionId = `direct_session_${randomUUID()}`;
      const record: SessionRecord = {
        info: {
          sessionId,
          hostInstanceId,
          origin: configuration.origin,
          allowedOrigins: configuration.allowedOrigins,
          attached: false,
          liveOrigin: null,
          lifecycleState: "creating_host",
          goal: configuration.goal,
          instanceLabel: configuration.instanceLabel,
        },
        epoch: 1,
        sequence: 0,
        runtime: null,
        driver: null,
        provisioning: Promise.resolve(),
        setupError: null,
        cleanupRetained: false,
        startupCleanupRetry: null,
        stopOperation: null,
        driverStopOperation: null,
        driverStopped: false,
        idempotency: new Map(),
      };
      sessions.set(sessionId, record);
      record.provisioning = provision(record, configuration.init);
      return { sessionId };
    },

    async waitForSessionReady(sessionId: string, timeoutMs?: number): Promise<BridgeSessionInfo> {
      const record = sessions.get(sessionId);
      if (!record) throw hostError("unknown_session");
      await withOptionalDeadline(record.provisioning, timeoutMs, "session_setup_timeout");
      if (record.setupError) {
        const code = record.setupError;
        if (!record.cleanupRetained) sessions.delete(sessionId);
        throw hostError(code);
      }
      if (record.info.lifecycleState !== "active") throw hostError("session_finalizing");
      return cloneInfo(record.info);
    },

    listSessions(): BridgeSessionInfo[] {
      return [...sessions.values()].map((record) => cloneInfo(record.info));
    },

    getStatus() {
      const records = [...sessions.values()];
      const active = records.filter((record) => record.info.lifecycleState === "active" && record.runtime?.cleanupState() === "ready");
      return {
        hostInstanceId,
        mode: "direct" as const,
        configured: !closed,
        runtimeReady: !closed && active.length > 0 && records.every((record) =>
          record.info.lifecycleState === "active"
          && record.runtime?.cleanupState() === "ready"
          && record.setupError === null
          && !record.cleanupRetained),
        browserFamilies: [...new Set(active.map((record) => record.runtime?.receipt.browserFamily).filter(isFamily))].sort(),
        identityCount: new Set(active.map((record) => record.runtime?.receipt.identityId).filter(isString)).size,
        sessionCount: records.length,
        activeSessionCount: active.length,
        cleanupUncertainCount: records.filter((record) => record.cleanupRetained).length,
        limits: { maxSessions, maxQueueItems, maxQueueBytes },
        sessionDiagnostics: records.map((record) => ({
          lifecycleState: record.info.lifecycleState,
          sequence: record.sequence,
          ...(record.driver ? record.driver.snapshot() : {}),
        })),
      };
    },

    beginSessionFinalization(sessionId: string, disposition: BrowserSessionCleanupDisposition): void {
      const record = sessions.get(sessionId);
      if (!record) throw hostError("unknown_session");
      if (!validDisposition(disposition)) throw hostError("invalid_cleanup_disposition");
      if (record.info.lifecycleState === "finalizing") {
        if (record.info.cleanupDisposition !== disposition) throw hostError("finalization_conflict");
        return;
      }
      if (record.info.lifecycleState !== "active") throw hostError("session_not_ready");
      record.info = { ...record.info, lifecycleState: "finalizing", cleanupDisposition: disposition };
      if (record.driver && !record.driverStopOperation) {
        const stopping = startDriverStop(record);
        record.driverStopOperation = stopping;
      }
    },

    dispatch(
      sessionId: string,
      action: DirectHostAction,
      dispatchOptions?: number | BridgeDispatchOptions,
    ): Promise<BridgeResultEvent> {
      const record = sessions.get(sessionId);
      if (!record) {
        if (action?.kind === "__stop") {
          return Promise.resolve(success(`direct_stop_${randomUUID()}`, 0, 0, { stopped: true }));
        }
        return Promise.resolve(failure("direct_unknown_0", 0, 0, "prevented", "unknown_session"));
      }
      const parsed = parseDispatchOptions(dispatchOptions);
      if (!parsed.valid) return Promise.resolve(nextFailure(record, "prevented", parsed.errorCode));
      const normalized = action ?? ({ kind: "observe" } as BrowserAction);
      if (parsed.idempotencyKey) {
        const now = Date.now();
        for (const [key, entry] of record.idempotency) {
          if (now - entry.createdAt >= IDEMPOTENCY_TTL_MS) record.idempotency.delete(key);
        }
        const hash = commandHash(normalized);
        if (!hash) return Promise.resolve(nextFailure(record, "prevented", "invalid_command"));
        const prior = record.idempotency.get(parsed.idempotencyKey);
        if (prior) return prior.hash === hash
          ? prior.promise
          : Promise.resolve(nextFailure(record, "prevented", "idempotency_conflict"));
        if (record.idempotency.size >= MAX_IDEMPOTENCY_ENTRIES) {
          return Promise.resolve(nextFailure(record, "prevented", "idempotency_limit"));
        }
        const promise = executeDispatch(record, normalized, parsed.timeoutMs);
        record.idempotency.set(parsed.idempotencyKey, { hash, promise, createdAt: now });
        return promise;
      }
      return executeDispatch(record, normalized, parsed.timeoutMs);
    },

    stopSession(sessionId: string): Promise<void> {
      const record = sessions.get(sessionId);
      if (!record) return Promise.resolve();
      if (record.stopOperation) return record.stopOperation;
      record.info = { ...record.info, lifecycleState: "finalizing", cleanupDisposition: record.info.cleanupDisposition ?? "close" };
      const operation = stopRecord(record);
      record.stopOperation = operation;
      void operation.finally(() => {
        if (record.stopOperation === operation) record.stopOperation = null;
      }).catch(() => {});
      return operation;
    },

    async stopAll(): Promise<void> {
      const results = await Promise.allSettled([...sessions.keys()].map((sessionId) => api.stopSession(sessionId)));
      if (results.some((result) => result.status === "rejected")) throw hostError("direct_cleanup_uncertain");
    },

    close(): Promise<void> {
      if (closeOperation) return closeOperation;
      closed = true;
      const operation = api.stopAll();
      closeOperation = operation;
      void operation.catch(() => {
        if (closeOperation === operation) closeOperation = null;
      });
      return operation;
    },
  };

  async function provision(record: SessionRecord, init: BridgeSessionInit): Promise<void> {
    try {
      record.info = { ...record.info, lifecycleState: "creating_tab" };
      const runtime = await options.launchOwnedRuntime({ sessionId: record.info.sessionId, init: cloneInit(init) });
      record.runtime = runtime;
      const bootstrap = runtime.claimDriverBootstrap(record.info.allowedOrigins ?? []);
      record.info = { ...record.info, lifecycleState: "attaching_debugger" };
      const driver = await sessionFactory({
        bootstrap,
        primaryOrigin: record.info.origin,
        allowedOrigins: (record.info.allowedOrigins ?? []).filter((origin) => origin !== record.info.origin),
        initialUrl: `${record.info.origin}/`,
        pump: { maxItems: maxQueueItems, maxBytes: maxQueueBytes },
      });
      record.driver = driver;
      if (record.info.lifecycleState === "finalizing") return;
      record.info = {
        ...record.info,
        attached: true,
        liveOrigin: record.info.origin,
        lifecycleState: "active",
      };
    } catch (error) {
      record.setupError = boundedErrorCode(error, "session_setup_failed");
      const retry = cleanupRetry(error);
      if (retry) {
        record.startupCleanupRetry = retry;
        record.cleanupRetained = true;
        record.info = { ...record.info, lifecycleState: "degraded" };
        return;
      }
      if (record.runtime) {
        try { await record.runtime.close(); } catch {
          record.cleanupRetained = true;
          record.info = { ...record.info, lifecycleState: "degraded" };
          return;
        }
      }
      record.info = { ...record.info, lifecycleState: "stopped" };
    }
  }

  async function executeDispatch(record: SessionRecord, action: DirectHostAction, timeoutMs?: number): Promise<BridgeResultEvent> {
    const sequence = ++record.sequence;
    const commandId = `direct_command_${record.epoch}_${sequence}_${randomUUID()}`;
    if (record.info.lifecycleState === "finalizing") {
      if (action.kind === "__stop") return stopCommand(record, commandId, sequence, false);
      if (action.kind === "__finalize") return finalizeCommand(record, action, commandId, sequence);
      return failure(commandId, record.epoch, sequence, "not_started", "session_finalizing");
    }
    await record.provisioning;
    // Cleanup must remain callable after setup, driver, or runtime degradation. It
    // is the recovery path for retained ownership and therefore cannot depend on
    // the ordinary action-readiness gate it is meant to dismantle.
    if (action.kind === "__stop") return stopCommand(record, commandId, sequence, false);
    if (record.setupError || !record.driver || record.info.lifecycleState !== "active") {
      return failure(commandId, record.epoch, sequence, "prevented", record.setupError ?? "session_not_ready");
    }
    if (!record.runtime || record.runtime.cleanupState() !== "ready") {
      record.cleanupRetained = true;
      record.info = { ...record.info, attached: false, lifecycleState: "degraded" };
      return failure(commandId, record.epoch, sequence, "prevented", "direct_runtime_unavailable");
    }
    if (action.kind === "__finalize") return finalizeCommand(record, action, commandId, sequence);
    try {
      const delta = await record.driver.execute(action, { commandId }, timeoutMs);
      const prevention = containmentPrevention(delta);
      if (prevention) return failure(commandId, record.epoch, sequence, "prevented", prevention);
      const incomplete = incompleteAction(delta, action.kind);
      if (incomplete) return failure(commandId, record.epoch, sequence, incomplete.outcome, incomplete.errorCode);
      return success(commandId, record.epoch, sequence, deltaToResult(delta));
    } catch (error) {
      const code = boundedErrorCode(error, "driver_error");
      const notStarted = code === "session_queue_full" || code === "session_finalizing" || code === "direct_session_invalid_command" || code === "command_timeout_not_started";
      const normalizedCode = code === "command_timeout_not_started" || code === "command_timeout_outcome_unknown" ? "command_timeout" : code;
      return failure(commandId, record.epoch, sequence, notStarted ? "not_started" : "outcome_unknown", normalizedCode);
    }
  }

  async function stopCommand(record: SessionRecord, commandId: string, sequence: number, finalized: boolean): Promise<BridgeResultEvent> {
    try {
      await api.stopSession(record.info.sessionId);
      return success(commandId, record.epoch, sequence, finalized ? { finalized: true } : { stopped: true });
    } catch {
      return failure(commandId, record.epoch, sequence, "outcome_unknown", "direct_cleanup_uncertain");
    }
  }

  function finalizeCommand(record: SessionRecord, action: DirectControlAction, commandId: string, sequence: number): Promise<BridgeResultEvent> {
    const disposition = "disposition" in action ? action.disposition : undefined;
    if (!validDisposition(disposition)) return Promise.resolve(failure(commandId, record.epoch, sequence, "prevented", "invalid_finalize_disposition"));
    try { api.beginSessionFinalization(record.info.sessionId, disposition); } catch (error) {
      return Promise.resolve(failure(commandId, record.epoch, sequence, "prevented", boundedErrorCode(error, "finalization_failed")));
    }
    return stopCommand(record, commandId, sequence, true);
  }

  async function stopRecord(record: SessionRecord): Promise<void> {
    await record.provisioning;
    let driverStopFailed = false;
    if (record.driver && !record.driverStopped) {
      const stopping = record.driverStopOperation ?? startDriverStop(record);
      record.driverStopOperation = stopping;
      try { await stopping; } catch {
        driverStopFailed = true;
      }
    }
    let ownedRuntimeClosed = false;
    if (record.runtime) {
      try { await record.runtime.close(); } catch {
        record.cleanupRetained = true;
        record.info = { ...record.info, lifecycleState: "degraded" };
        throw hostError("direct_cleanup_uncertain");
      }
      ownedRuntimeClosed = true;
    } else if (record.startupCleanupRetry) {
      try { await record.startupCleanupRetry(); } catch {
        record.cleanupRetained = true;
        record.info = { ...record.info, lifecycleState: "degraded" };
        throw hostError("direct_cleanup_uncertain");
      }
    }
    if (driverStopFailed && !ownedRuntimeClosed) {
      record.cleanupRetained = true;
      record.info = { ...record.info, lifecycleState: "degraded" };
      throw hostError("direct_cleanup_uncertain");
    }
    if (ownedRuntimeClosed) record.driverStopped = true;
    record.cleanupRetained = false;
    record.info = { ...record.info, attached: false, lifecycleState: "stopped" };
    sessions.delete(record.info.sessionId);
  }

  function startDriverStop(record: SessionRecord): Promise<void> {
    if (!record.driver) return Promise.resolve();
    if (record.driverStopOperation) return record.driverStopOperation;
    const operation = record.driver.stop().then(() => { record.driverStopped = true; });
    record.driverStopOperation = operation;
    void operation.finally(() => {
      if (record.driverStopOperation === operation) record.driverStopOperation = null;
    }).catch(() => {});
    return operation;
  }

  return api;
}

function validateSessionInit(init: BridgeSessionInit): { origin: string; allowedOrigins: string[]; goal: string; instanceLabel: string; init: BridgeSessionInit } {
  if (!init || typeof init !== "object") throw hostError("direct_session_invalid_configuration");
  const origin = exactOrigin(init.origin);
  if (!origin || !Array.isArray(init.allowedOrigins) || init.allowedOrigins.length > 31) throw hostError("invalid_origin");
  const allowedOrigins = [...new Set([origin, ...init.allowedOrigins.map(exactOrigin)])];
  if (allowedOrigins.some((value) => !value) || allowedOrigins.length > 32) throw hostError("invalid_origin");
  if (init.identityId !== undefined && !/^nbi_[a-f0-9]{32}$/u.test(init.identityId)) throw hostError("invalid_identity_id");
  if (init.browserFamily !== undefined && init.browserFamily !== "chrome" && init.browserFamily !== "edge") {
    throw hostError("invalid_browser_family");
  }
  return {
    origin,
    allowedOrigins,
    goal: boundedText(init.goal, 240),
    instanceLabel: boundedText(init.instanceLabel, 120),
    init: { ...init, origin, allowedOrigins: [...allowedOrigins] },
  };
}

function exactOrigin(value: unknown): string {
  if (typeof value !== "string" || value !== value.trim()) return "";
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.origin === value ? value : "";
  } catch { return ""; }
}

function cloneInit(init: BridgeSessionInit): BridgeSessionInit {
  return { ...init, allowedOrigins: [...init.allowedOrigins] };
}

function cloneInfo(info: BridgeSessionInfo): BridgeSessionInfo {
  return { ...info, ...(info.allowedOrigins ? { allowedOrigins: [...info.allowedOrigins] } : {}) };
}

function parseDispatchOptions(value: number | BridgeDispatchOptions | undefined):
  { valid: true; idempotencyKey: string | null; timeoutMs?: number } | { valid: false; idempotencyKey: null; errorCode: string } {
  if (value === undefined) return { valid: true, idempotencyKey: null, timeoutMs: 60_000 };
  if (typeof value === "number") return validTimeout(value) ? { valid: true, idempotencyKey: null, timeoutMs: value } : { valid: false, idempotencyKey: null, errorCode: "invalid_timeout" };
  if (!value || typeof value !== "object") return { valid: false, idempotencyKey: null, errorCode: "invalid_dispatch_options" };
  if (Object.keys(value).some((key) => key !== "timeoutMs" && key !== "idempotencyKey")) {
    return { valid: false, idempotencyKey: null, errorCode: "invalid_dispatch_options" };
  }
  if (value.timeoutMs !== undefined && !validTimeout(value.timeoutMs)) return { valid: false, idempotencyKey: null, errorCode: "invalid_timeout" };
  if (value.idempotencyKey === undefined) return { valid: true, idempotencyKey: null, timeoutMs: value.timeoutMs ?? 60_000 };
  return /^[A-Za-z0-9._:-]{1,128}$/u.test(value.idempotencyKey)
    ? { valid: true, idempotencyKey: value.idempotencyKey, timeoutMs: value.timeoutMs ?? 60_000 }
    : { valid: false, idempotencyKey: null, errorCode: "invalid_idempotency_key" };
}

function validTimeout(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 300_000;
}

function withOptionalDeadline<T>(operation: Promise<T>, timeoutMs: number | undefined, code: string): Promise<T> {
  if (timeoutMs === undefined) return operation;
  if (!validTimeout(timeoutMs)) return Promise.reject(hostError("invalid_timeout"));
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(hostError(code)), timeoutMs);
    timer.unref();
    operation.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error); },
    );
  });
}

function commandHash(action: DirectHostAction): string | null {
  try {
    return createHash("sha256").update(stableJson(action)).digest("hex");
  } catch { return null; }
}

function stableJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  if (typeof serialized !== "string") throw new Error("invalid_command");
  return serialized;
}

function nextFailure(record: SessionRecord, outcome: "prevented" | "not_started", code: string): BridgeResultEvent {
  const sequence = ++record.sequence;
  return failure(`direct_command_${record.epoch}_${sequence}_${randomUUID()}`, record.epoch, sequence, outcome, code);
}

function success(commandId: string, sessionEpoch: number, sequence: number, result: unknown): BridgeResultEvent {
  return { commandId, ok: true, sessionEpoch, sequence, outcome: "completed", retrySafe: false, result };
}

function failure(commandId: string, sessionEpoch: number, sequence: number, outcome: "prevented" | "not_started" | "outcome_unknown", errorCode: string): BridgeResultEvent {
  return { commandId, ok: false, sessionEpoch, sequence, outcome, retrySafe: outcome !== "outcome_unknown", errorCode };
}

function containmentPrevention(delta: Record<string, unknown>): string | null {
  if (delta.status !== "blocked" || typeof delta.reason !== "string" || !CONTAINMENT_REASONS.has(delta.reason)) return null;
  const changed = isRecord(delta.changed) ? delta.changed : null;
  return changed?.containmentPrevention === delta.reason ? delta.reason : null;
}

function incompleteAction(delta: Record<string, unknown>, kind: string): { outcome: "prevented" | "not_started" | "outcome_unknown"; errorCode: string } | null {
  const status = typeof delta.status === "string" ? delta.status : "";
  const reason = typeof delta.reason === "string" && /^[a-z][a-z0-9_]{0,79}$/u.test(delta.reason) ? delta.reason : status;
  if (status === "not_found" || status === "ambiguous" || status === "stale_target") {
    return { outcome: "not_started", errorCode: status };
  }
  if (status === "needs_approval" || status === "blocked") {
    return { outcome: "prevented", errorCode: reason || status };
  }
  if (status === "timed_out") {
    return { outcome: kind === "wait_for" ? "not_started" : "outcome_unknown", errorCode: "timed_out" };
  }
  if (status === "failed") return { outcome: "outcome_unknown", errorCode: reason || "driver_error" };
  return null;
}


function deltaToResult(delta: Record<string, unknown>): unknown {
  if (isRecord(delta.screenshot)) return delta.screenshot;
  if (isRecord(delta.observation)) return {
    ...delta.observation,
    ...(typeof delta.status === "string" ? { actionStatus: delta.status } : {}),
    ...(typeof delta.verified === "boolean" ? { verified: delta.verified } : {}),
    ...(typeof delta.reason === "string" ? { reason: delta.reason } : {}),
    ...(isRecord(delta.changed) ? { changed: delta.changed } : {}),
  };
  return { kind: "ack", message: typeof delta.status === "string" ? delta.status : "ok", ...(typeof delta.status === "string" ? { actionStatus: delta.status } : {}) };
}

function cleanupRetry(error: unknown): (() => Promise<void>) | null {
  if (!isRecord(error) || error.cleanupUncertain !== true || typeof error.retryCleanup !== "function") return null;
  const retry = error.retryCleanup;
  return () => Promise.resolve(retry.call(error)).then(() => undefined);
}

function boundedErrorCode(error: unknown, fallback: string): string {
  const raw = isRecord(error) && typeof error.code === "string"
    ? error.code
    : error instanceof Error ? error.message : "";
  return /^[a-z][a-z0-9_]{0,79}$/u.test(raw) ? raw : fallback;
}

function validDisposition(value: unknown): value is BrowserSessionCleanupDisposition {
  return value === "close";
}

function bounded(value: number | undefined, fallback: number, maximum: number): number {
  return Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= maximum ? Number(value) : fallback;
}

function boundedText(value: unknown, cap: number): string {
  return typeof value === "string" ? value.slice(0, cap) : "";
}

function validLabel(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/u.test(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFamily(value: unknown): value is OwnedBrowserFamily {
  return value === "chrome" || value === "edge";
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function hostError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
