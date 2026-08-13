import { createHash, randomUUID } from "node:crypto";

import type {
  BrowserDispatchOptions,
  BrowserCommandResult,
  BrowserSessionInfo,
  BrowserSessionInit,
  BrowserAction,
  BrowserFloorDecision,
  BrowserHostPolicyManifest,
  BrowserResolvedTarget,
  BrowserSignals,
} from "@newton-browser/core";
import { parseBrowserAction } from "@newton-browser/core";
import {
  startDirectDriverSession,
  type DriverAction,
  type DirectDriverSessionSnapshot,
  type StartDirectDriverSessionOptions,
} from "@newton-browser/driver/direct-session-runtime";

import type { OwnedBrowserFamily, OwnedDriverBootstrap } from "./owned-browser-runtime.ts";
import { evaluateHostFloor } from "../floor-gate.ts";

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
  execute(
    action: DriverAction,
    context?: { commandId?: string },
    timeoutMs?: number,
    signal?: AbortSignal,
    guard?: (evidence: Record<string, unknown>) => Promise<void> | void,
  ): Promise<Record<string, unknown>>;
  stop(): Promise<void>;
  snapshot(): DirectDriverSessionSnapshot;
}>;

export type DirectOwnedRuntimeFactory = (input: Readonly<{
  sessionId: string;
  init: BrowserSessionInit;
}>) => Promise<DirectOwnedRuntime>;

export type DirectDriverSessionFactory = (
  options: StartDirectDriverSessionOptions,
) => Promise<DirectHostSession>;

export type DirectBrowserHostOptions = Readonly<{
  launchOwnedRuntime: DirectOwnedRuntimeFactory;
  startDriverSession?: DirectDriverSessionFactory;
  maxSessions?: number;
  maxQueueItems?: number;
  maxQueueBytes?: number;
  hostPolicies?: readonly BrowserHostPolicyManifest[];
}>;

export type DirectBrowserHost = ReturnType<typeof createDirectBrowserHost>;

type IdempotencyEntry = Readonly<{
  hash: string;
  promise: Promise<BrowserCommandResult>;
  createdAt: number;
}>;

type SessionRecord = {
  info: BrowserSessionInfo;
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
  provisioningAbort: AbortController;
};

export function createDirectBrowserHost(options: DirectBrowserHostOptions) {
  if (!options || typeof options.launchOwnedRuntime !== "function") throw hostError("direct_host_invalid_configuration");
  const maxSessions = bounded(options.maxSessions, DEFAULT_MAX_SESSIONS, 64);
  const maxQueueItems = bounded(options.maxQueueItems, DEFAULT_MAX_QUEUE_ITEMS, 256);
  const maxQueueBytes = bounded(options.maxQueueBytes, DEFAULT_MAX_QUEUE_BYTES, 16 * 1024 * 1024);
  const sessionFactory = options.startDriverSession ?? startDirectDriverSession;
  const hostPolicies = immutableHostPolicies(options.hostPolicies ?? []);
  const sessions = new Map<string, SessionRecord>();
  let closed = false;
  let closeOperation: Promise<void> | null = null;

  const api = {
    createSession(init: BrowserSessionInit): { sessionId: string } {
      if (closed) throw hostError("direct_host_closed");
      if (sessions.size >= maxSessions) throw hostError("session_limit");
      const configuration = validateSessionInit(init);
      const sessionId = `direct_session_${randomUUID()}`;
      const record: SessionRecord = {
        info: {
          sessionId,
          origin: configuration.origin,
          allowedOrigins: configuration.allowedOrigins,
          lifecycleState: "starting_runtime",
        },
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
        provisioningAbort: new AbortController(),
      };
      sessions.set(sessionId, record);
      record.provisioning = provision(record, configuration.init);
      return { sessionId };
    },

    async waitForSessionReady(sessionId: string, timeoutMs?: number): Promise<BrowserSessionInfo> {
      const record = sessions.get(sessionId);
      if (!record) throw hostError("unknown_session");
      await withOptionalDeadline(record.provisioning, timeoutMs, "session_setup_timeout");
      if (record.setupError) {
        const code = record.setupError;
        if (!record.cleanupRetained) sessions.delete(sessionId);
        throw hostError(code);
      }
      if (record.info.lifecycleState !== "active") throw hostError("session_stopping");
      return cloneInfo(record.info);
    },

    listSessions(): BrowserSessionInfo[] {
      return [...sessions.values()].map((record) => cloneInfo(record.info));
    },

    getStatus() {
      const records = [...sessions.values()];
      const active = records.filter((record) => record.info.lifecycleState === "active" && record.runtime?.cleanupState() === "ready");
      return {
        mode: "direct" as const,
        configured: !closed,
        runtimeReady: !closed && active.length > 0 && records.every((record) =>
          record.info.lifecycleState === "active"
          && record.runtime?.cleanupState() === "ready"
          && record.setupError === null
          && !record.cleanupRetained),
        sessionCount: records.length,
        activeSessionCount: active.length,
        cleanupUncertainCount: records.filter((record) => record.cleanupRetained).length,
        limits: { maxSessions, maxQueueItems, maxQueueBytes },
        sessionDiagnostics: records.map((record) => ({
          sessionId: record.info.sessionId,
          lifecycleState: record.info.lifecycleState,
          sequence: record.sequence,
          ...(record.driver ? record.driver.snapshot() : {}),
        })),
      };
    },

    dispatch(
      sessionId: string,
      action: BrowserAction,
      dispatchOptions?: BrowserDispatchOptions,
    ): Promise<BrowserCommandResult> {
      const record = sessions.get(sessionId);
      if (!record) return Promise.resolve(failure("direct_unknown_0", 0, "prevented", "unknown_session"));
      const parsed = parseDispatchOptions(dispatchOptions);
      if (!parsed.valid) return Promise.resolve(nextFailure(record, "prevented", parsed.errorCode));
      let normalized: DriverAction;
      try {
        normalized = normalizeHostAction(action);
      } catch {
        return Promise.resolve(nextFailure(record, "prevented", "invalid_command"));
      }
      let idempotencyHash: string | null = null;
      if (parsed.idempotencyKey) {
        const now = Date.now();
        for (const [key, entry] of record.idempotency) {
          if (now - entry.createdAt >= IDEMPOTENCY_TTL_MS) record.idempotency.delete(key);
        }
        idempotencyHash = commandHash(normalized);
        if (!idempotencyHash) return Promise.resolve(nextFailure(record, "prevented", "invalid_command"));
        const prior = record.idempotency.get(parsed.idempotencyKey);
        if (prior) return prior.hash === idempotencyHash
          ? prior.promise
          : Promise.resolve(nextFailure(record, "prevented", "idempotency_conflict"));
        if (record.idempotency.size >= MAX_IDEMPOTENCY_ENTRIES) {
          return Promise.resolve(nextFailure(record, "prevented", "idempotency_limit"));
        }
      }
      let operation: Promise<BrowserCommandResult>;
      try {
        const initialVerdict = evaluateHostFloor({ session: record.info, action: normalized, manifests: hostPolicies });
        normalized = initialVerdict.action as DriverAction;
        operation = initialVerdict.dispatchAllowed
          ? executeDispatch(record, normalized, initialVerdict.decision, parsed.timeoutMs, parsed.signal)
          : Promise.resolve(nextFailure(record, "prevented", initialVerdict.errorCode, initialVerdict.decision));
      } catch {
        const decision = blockedFloorDecision("floor_configuration_invalid");
        operation = Promise.resolve(nextFailure(record, "prevented", "floor_configuration_invalid", decision));
      }
      if (parsed.idempotencyKey && idempotencyHash) {
        record.idempotency.set(parsed.idempotencyKey, {
          hash: idempotencyHash,
          promise: operation,
          createdAt: Date.now(),
        });
      }
      return operation;
    },

    stopSession(sessionId: string): Promise<void> {
      const record = sessions.get(sessionId);
      if (!record) return Promise.resolve();
      if (record.stopOperation) return record.stopOperation;
      record.info = { ...record.info, lifecycleState: "stopping" };
      record.provisioningAbort.abort(hostError("session_stopping"));
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

  async function provision(record: SessionRecord, init: BrowserSessionInit): Promise<void> {
    try {
      record.info = { ...record.info, lifecycleState: "starting_browser" };
      const runtime = await options.launchOwnedRuntime({ sessionId: record.info.sessionId, init: cloneInit(init) });
      record.runtime = runtime;
      observeRuntimeAvailability(record, runtime);
      throwIfProvisioningStopped(record);
      const bootstrap = runtime.claimDriverBootstrap(record.info.allowedOrigins);
      record.info = { ...record.info, lifecycleState: "attaching_cdp" };
      const driver = await sessionFactory({
        bootstrap,
        primaryOrigin: record.info.origin,
        allowedOrigins: record.info.allowedOrigins.filter((origin) => origin !== record.info.origin),
        initialUrl: `${record.info.origin}/`,
        signal: record.provisioningAbort.signal,
        pump: { maxItems: maxQueueItems, maxBytes: maxQueueBytes },
      });
      record.driver = driver;
      if (record.info.lifecycleState === "stopping") return;
      record.info = {
        ...record.info,
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
        try {
          await record.runtime.close();
          record.runtime = null;
        } catch {
          record.cleanupRetained = true;
          record.info = { ...record.info, lifecycleState: "degraded" };
          return;
        }
      }
      record.info = { ...record.info, lifecycleState: "stopped" };
    }
  }

  function throwIfProvisioningStopped(record: SessionRecord): void {
    if (record.provisioningAbort.signal.aborted || record.info.lifecycleState === "stopping") {
      throw hostError("session_stopping");
    }
  }

  async function executeDispatch(
    record: SessionRecord,
    action: DriverAction,
    initialDecision: BrowserFloorDecision,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<BrowserCommandResult> {
    const sequence = ++record.sequence;
    const commandId = `direct_command_${sequence}_${randomUUID()}`;
    if (record.info.lifecycleState === "stopping") return failure(commandId, sequence, "not_started", "session_stopping", initialDecision);
    await record.provisioning;
    if (record.setupError || !record.driver || record.info.lifecycleState !== "active") {
      return failure(commandId, sequence, "prevented", record.setupError ?? "session_not_ready", initialDecision);
    }
    if (!record.runtime || record.runtime.cleanupState() !== "ready") {
      record.cleanupRetained = true;
      record.info = { ...record.info, lifecycleState: "degraded" };
      return failure(commandId, sequence, "prevented", "direct_runtime_unavailable", initialDecision);
    }
    let decision = initialDecision;
    try {
      const guard = requiresResolvedFloor(action)
        ? (evidence: Record<string, unknown>): void => {
            const resolvedEvidence = normalizeResolvedFloorEvidence(evidence);
            const verdict = evaluateHostFloor({
              session: record.info,
              action,
              manifests: hostPolicies,
              ...(resolvedEvidence.resolved ? { resolved: resolvedEvidence.resolved } : {}),
              ...(resolvedEvidence.signals ? { signals: resolvedEvidence.signals } : {}),
            });
            decision = strongestFloorDecision(decision, verdict.decision);
            if (!verdict.dispatchAllowed) throw new DirectFloorBlocked(verdict.errorCode, decision);
          }
        : undefined;
      const delta = await record.driver.execute(action, { commandId }, timeoutMs, signal, guard);
      const prevention = containmentPrevention(delta);
      if (prevention) return failure(commandId, sequence, "prevented", prevention, decision);
      if (!record.runtime || record.runtime.cleanupState() !== "ready" || record.info.lifecycleState !== "active") {
        record.cleanupRetained = true;
        record.info = { ...record.info, lifecycleState: "degraded" };
        return failure(commandId, sequence, "outcome_unknown", "direct_runtime_unavailable", decision);
      }
      const incomplete = incompleteAction(delta, action.kind);
      if (incomplete) return failure(commandId, sequence, incomplete.outcome, incomplete.errorCode, decision);
      const status = completedActionStatus(delta);
      if (!status) return failure(commandId, sequence, "outcome_unknown", "runner_contract_invalid", decision);
      return success(commandId, sequence, deltaToResult(delta), status, delta, decision);
    } catch (error) {
      if (error instanceof DirectFloorBlocked) {
        return failure(commandId, sequence, "prevented", error.code, error.decision);
      }
      const code = boundedErrorCode(error, "driver_error");
      const notStarted = code === "session_queue_full" || code === "session_stopping" || code === "command_cancelled_not_started" || code === "direct_session_invalid_command" || code === "command_timeout_not_started";
      const normalizedCode = code === "command_timeout_not_started" || code === "command_timeout_outcome_unknown"
        ? "command_timeout"
        : code === "command_cancelled_not_started" || code === "command_cancelled_outcome_unknown"
          ? "command_cancelled"
          : code;
      return failure(commandId, sequence, notStarted ? "not_started" : "outcome_unknown", normalizedCode, decision);
    }
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
    record.info = { ...record.info, lifecycleState: "stopped" };
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

  function observeRuntimeAvailability(record: SessionRecord, runtime: DirectOwnedRuntime): void {
    const unavailable = (): void => {
      if (sessions.get(record.info.sessionId) !== record || record.runtime !== runtime
        || record.info.lifecycleState === "stopping" || record.info.lifecycleState === "stopped") return;
      record.cleanupRetained = true;
      record.info = { ...record.info, lifecycleState: "degraded" };
    };
    void runtime.unavailable.then(unavailable, unavailable);
  }

  return api;
}

function validateSessionInit(init: BrowserSessionInit): { origin: string; allowedOrigins: string[]; init: BrowserSessionInit } {
  if (!init || typeof init !== "object" || Object.keys(init).some((key) =>
    !["origin", "allowedOrigins", "identityId", "browserFamily"].includes(key))) {
    throw hostError("direct_session_invalid_configuration");
  }
  const origin = exactOrigin(init.origin);
  if (!origin || !Array.isArray(init.allowedOrigins) || init.allowedOrigins.length === 0 || init.allowedOrigins.length > 32) {
    throw hostError("invalid_origin");
  }
  const allowedOrigins = init.allowedOrigins.map(exactOrigin);
  if (allowedOrigins.some((value) => !value) || allowedOrigins[0] !== origin
    || new Set(allowedOrigins).size !== allowedOrigins.length) throw hostError("invalid_origin");
  if (init.identityId !== undefined && !/^nbi_[a-f0-9]{32}$/u.test(init.identityId)) throw hostError("invalid_identity_id");
  if (init.browserFamily !== undefined && init.browserFamily !== "chrome" && init.browserFamily !== "edge") {
    throw hostError("invalid_browser_family");
  }
  return {
    origin,
    allowedOrigins,
    init: { ...init, origin, allowedOrigins: [...allowedOrigins] },
  };
}

function exactOrigin(value: unknown): string {
  if (typeof value !== "string" || value.length > 512 || value !== value.trim()) return "";
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.origin === value ? value : "";
  } catch { return ""; }
}

function cloneInit(init: BrowserSessionInit): BrowserSessionInit {
  return { ...init, allowedOrigins: [...init.allowedOrigins] };
}

function cloneInfo(info: BrowserSessionInfo): BrowserSessionInfo {
  return { ...info, allowedOrigins: [...info.allowedOrigins] };
}

function parseDispatchOptions(value: BrowserDispatchOptions | undefined):
  { valid: true; idempotencyKey: string | null; timeoutMs?: number; signal?: AbortSignal } | { valid: false; idempotencyKey: null; errorCode: string } {
  if (value === undefined) return { valid: true, idempotencyKey: null, timeoutMs: 60_000 };
  if (!value || typeof value !== "object") return { valid: false, idempotencyKey: null, errorCode: "invalid_dispatch_options" };
  if (Object.keys(value).some((key) => key !== "timeoutMs" && key !== "idempotencyKey" && key !== "signal")) {
    return { valid: false, idempotencyKey: null, errorCode: "invalid_dispatch_options" };
  }
  if (value.signal !== undefined && !(value.signal instanceof AbortSignal)) return { valid: false, idempotencyKey: null, errorCode: "invalid_abort_signal" };
  if (value.timeoutMs !== undefined && !validTimeout(value.timeoutMs)) return { valid: false, idempotencyKey: null, errorCode: "invalid_timeout" };
  if (value.idempotencyKey === undefined) return { valid: true, idempotencyKey: null, timeoutMs: value.timeoutMs ?? 60_000, ...(value.signal ? { signal: value.signal } : {}) };
  return /^[A-Za-z0-9_-]{8,128}$/u.test(value.idempotencyKey)
    ? { valid: true, idempotencyKey: value.idempotencyKey, timeoutMs: value.timeoutMs ?? 60_000, ...(value.signal ? { signal: value.signal } : {}) }
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

function commandHash(action: DriverAction): string | null {
  try {
    return createHash("sha256").update(stableJson(action)).digest("hex");
  } catch { return null; }
}

function normalizeHostAction(action: BrowserAction): DriverAction {
  return parseBrowserAction(action) as DriverAction;
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

function nextFailure(
  record: SessionRecord,
  outcome: "prevented" | "not_started",
  code: string,
  decision?: BrowserFloorDecision,
): BrowserCommandResult {
  const sequence = ++record.sequence;
  return failure(`direct_command_${sequence}_${randomUUID()}`, sequence, outcome, code, decision);
}

function success(
  commandId: string,
  sequence: number,
  result: unknown,
  status: Extract<BrowserCommandResult["status"], "verified" | "dispatched_unverified">,
  delta: Record<string, unknown>,
  decision: BrowserFloorDecision,
): BrowserCommandResult {
  const reason = typeof delta.reason === "string" && /^[a-z][a-z0-9_]{0,79}$/u.test(delta.reason)
    ? delta.reason
    : undefined;
  const changed = isRecord(delta.changed) ? changedCategories(delta.changed) : undefined;
  return {
    commandId,
    ok: true,
    status,
    sequence,
    outcome: "completed",
    retrySafe: false,
    result,
    decision,
    ...(reason ? { reason } : {}),
    ...(changed ? { changed } : {}),
  };
}

function failure(
  commandId: string,
  sequence: number,
  outcome: "prevented" | "not_started" | "outcome_unknown",
  errorCode: string,
  decision: BrowserFloorDecision = blockedFloorDecision(errorCode),
): BrowserCommandResult {
  const status: BrowserCommandResult["status"] = outcome === "prevented" ? "blocked" : outcome === "not_started" ? "failed" : "dispatched_unverified";
  return {
    commandId,
    ok: false,
    status,
    sequence,
    outcome,
    retrySafe: outcome !== "outcome_unknown",
    errorCode,
    decision,
  };
}

function containmentPrevention(delta: Record<string, unknown>): string | null {
  if (delta.status !== "blocked" || typeof delta.reason !== "string" || !CONTAINMENT_REASONS.has(delta.reason)) return null;
  const changed = isRecord(delta.changed) ? delta.changed : null;
  return changed?.containmentPrevention === delta.reason ? delta.reason : null;
}

function incompleteAction(delta: Record<string, unknown>, kind: string): { outcome: "prevented" | "not_started" | "outcome_unknown"; errorCode: string } | null {
  const status = typeof delta.status === "string" ? delta.status : "";
  if (status === "verified" || status === "dispatched_unverified") return null;
  const reason = typeof delta.reason === "string" && /^[a-z][a-z0-9_]{0,79}$/u.test(delta.reason) ? delta.reason : status;
  if (status === "not_found" || status === "ambiguous" || status === "stale_target") {
    return { outcome: "not_started", errorCode: status };
  }
  if (status === "blocked") {
    return { outcome: "prevented", errorCode: reason || status };
  }
  if (status === "timed_out") {
    return { outcome: kind === "wait_for" ? "not_started" : "outcome_unknown", errorCode: "timed_out" };
  }
  if (status === "failed") return { outcome: "outcome_unknown", errorCode: reason || "driver_error" };
  return { outcome: "outcome_unknown", errorCode: "runner_contract_invalid" };
}


function deltaToResult(delta: Record<string, unknown>): unknown {
  if (isRecord(delta.screenshot)) return delta.screenshot;
  if (isRecord(delta.observation)) return delta.observation;
  return { kind: "ack" };
}

function completedActionStatus(delta: Record<string, unknown>): "verified" | "dispatched_unverified" | null {
  const status = delta.status;
  return status === "verified" || status === "dispatched_unverified" ? status : null;
}

class DirectFloorBlocked extends Error {
  readonly code: string;
  readonly decision: BrowserFloorDecision;

  constructor(code: string, decision: BrowserFloorDecision) {
    super(code);
    this.name = "DirectFloorBlocked";
    this.code = code;
    this.decision = decision;
  }
}

function requiresResolvedFloor(action: DriverAction): boolean {
  if (!["click", "fill", "type", "select", "clear", "set_files", "press"].includes(action.kind)) return false;
  return typeof action.ref === "string" || typeof action.selector === "string" || typeof action.role === "string"
    || typeof action.name === "string" || typeof action.label === "string" || typeof action.placeholder === "string"
    || typeof action.testId === "string" || typeof action.text === "string"
    || (Number.isFinite(action.x) && Number.isFinite(action.y));
}

function normalizeResolvedFloorEvidence(evidence: Record<string, unknown>): {
  resolved?: BrowserResolvedTarget;
  signals?: BrowserSignals;
} {
  const rawResolved = isRecord(evidence.resolved) ? evidence.resolved : null;
  const rawSignals = isRecord(evidence.signals) ? evidence.signals : null;
  const boundedString = (value: unknown, cap = 240): string | undefined =>
    typeof value === "string" && value.length <= cap ? value : undefined;
  const resolved: BrowserResolvedTarget | undefined = rawResolved ? {} : undefined;
  if (rawResolved && resolved) {
    const role = boundedString(rawResolved.role, 80);
    const accessibleName = boundedString(rawResolved.accessibleName);
    const formOwner = boundedString(rawResolved.formOwner);
    const inputType = boundedString(rawResolved.inputType, 80);
    const autocomplete = boundedString(rawResolved.autocomplete, 120);
    const origin = boundedString(rawResolved.origin, 500);
    if (role !== undefined) resolved.role = role;
    if (accessibleName !== undefined) resolved.accessibleName = accessibleName;
    if (rawResolved.formOwner === null) resolved.formOwner = null;
    else if (formOwner !== undefined) resolved.formOwner = formOwner;
    if (inputType !== undefined) resolved.inputType = inputType;
    if (autocomplete !== undefined) resolved.autocomplete = autocomplete;
    if (origin !== undefined) resolved.origin = origin;
  }
  const booleanSignal = (key: keyof BrowserSignals): boolean => rawSignals?.[key] === true;
  const containmentPrevention = boundedString(rawSignals?.containmentPrevention, 80);
  const signals: BrowserSignals | undefined = rawSignals
    ? {
        ...(booleanSignal("formSubmit") ? { formSubmit: true } : {}),
        ...(booleanSignal("navigation") ? { navigation: true } : {}),
        ...(booleanSignal("networkWrite") ? { networkWrite: true } : {}),
        ...(booleanSignal("dialog") ? { dialog: true } : {}),
        ...(booleanSignal("download") ? { download: true } : {}),
        ...(booleanSignal("crossOrigin") ? { crossOrigin: true } : {}),
        ...(booleanSignal("newTarget") ? { newTarget: true } : {}),
        ...(booleanSignal("secretField") ? { secretField: true } : {}),
        ...(containmentPrevention ? { containmentPrevention } : {}),
      }
    : undefined;
  return {
    ...(resolved && Object.keys(resolved).length > 0 ? { resolved } : {}),
    ...(signals && Object.keys(signals).length > 0 ? { signals } : {}),
  };
}

function strongestFloorDecision(first: BrowserFloorDecision, second: BrowserFloorDecision): BrowserFloorDecision {
  const classes = ["read_only", "agentic", "blocked"];
  const boundaries = ["none", "draft", "commit", "external_effect"];
  const firstBoundary = first.commitBoundary;
  const secondBoundary = second.commitBoundary;
  const secondClassIsStronger = classes.indexOf(second.class) > classes.indexOf(first.class);
  const secondBoundaryIsStronger = boundaries.indexOf(secondBoundary) > boundaries.indexOf(firstBoundary);
  const reasonSource = secondClassIsStronger || (second.class === first.class && secondBoundaryIsStronger) ? second : first;
  const reason = reasonSource.reason ?? (reasonSource === first ? second.reason : first.reason);
  return {
    class: secondClassIsStronger ? second.class : first.class,
    commitBoundary: secondBoundaryIsStronger ? secondBoundary : firstBoundary,
    ...(reason ? { reason } : {}),
  };
}

function blockedFloorDecision(reason: string): BrowserFloorDecision {
  return {
    class: "blocked",
    reason,
    commitBoundary: "none",
  };
}

function changedCategories(value: Record<string, unknown>): Record<string, true> | undefined {
  const output: Record<string, true> = {};
  for (const key of Object.keys(value).slice(0, 12)) {
    if (/^[a-z][A-Za-z0-9_]{0,79}$/u.test(key)) output[key] = true;
  }
  return Object.keys(output).length > 0 ? output : undefined;
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

function bounded(value: number | undefined, fallback: number, maximum: number): number {
  return Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= maximum ? Number(value) : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hostError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

function immutableHostPolicies(input: readonly BrowserHostPolicyManifest[]): readonly BrowserHostPolicyManifest[] {
  return Object.freeze(input.map((policy) => Object.freeze({
    origins: Object.freeze([...policy.origins]),
    ...(policy.commitRules ? {
      commitRules: Object.freeze(policy.commitRules.map((rule) => Object.freeze({
        match: Object.freeze({ ...rule.match }),
        effect: rule.effect,
        ...(rule.reason === undefined ? {} : { reason: rule.reason }),
      }))),
    } : {}),
    ...(policy.sensitiveZones ? {
      sensitiveZones: Object.freeze(policy.sensitiveZones.map((zone) => Object.freeze({ ...zone }))),
    } : {}),
  })));
}
