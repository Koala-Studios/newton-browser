import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

import type { BridgeCommand, BrowserCommandOutcome, BrowserFloorDecision, BridgeResultEvent, BridgeSessionInfo, BridgeSessionInit } from "@newton-browser/core";
import { validateIdempotencyKey } from "../../../packages/core/src/action-schema.ts";
import { WebSocket, WebSocketServer } from "ws";

import { loadBrowserTarget, loadOrCreatePairingConfig, loadTransportAuthMode, type BrowserTarget, type TransportAuthMode, validDoctorToken } from "./config.ts";
import { NEWTON_BROWSER_VERSION } from "./cli.ts";

const DEFAULT_LIMITS = {
  firstPort: 17321,
  lastPort: 17340,
  maxQueuedPerSession: 32,
  maxQueuedBytesPerSession: 32 * 1024,
  maxPending: 128,
  maxSessions: 32,
  maxMessageBytes: 24 * 1024 * 1024,
  maxResultBytes: 16 * 1024 * 1024,
  maxCommandTimeoutMs: 120_000,
  authTimeoutMs: 3_000,
  readinessTimeoutMs: 40_000,
  orphanSessionTtlMs: 30 * 60_000,
  lateResultTtlMs: 10 * 60_000,
  lateResultCap: 256,
  maxIdempotencyEntriesPerSession: 256,
  idempotencyTtlMs: 10 * 60_000,
};

type HostClient = {
  id: string;
  socket: WebSocket;
  authenticated: boolean;
  identity: null | { clientId: string; browserFamily: "chrome" | "edge" | "chromium"; version?: string };
  nonce: string;
  authTimer: NodeJS.Timeout | null;
  subscriptions: Set<string>;
};

type SessionState = {
  epoch: number;
  sequence: number;
  ownerId: string | null;
  ownerIdentity: string | null;
  inFlightCommandId: string | null;
  queuedCommandIds: string[];
  queuedBytes: number;
  isStopping: boolean;
};

type PendingCommandPhase = "queued" | "sent";

type PendingCommand = {
  sessionId: string;
  commandId: string;
  sessionEpoch: number;
  sequence: number;
  actionKind: string;
  action: BridgeCommand["action"];
  timeoutMs: number;
  resolve: (event: BridgeResultEvent) => void;
  timer: NodeJS.Timeout | null;
  targetClientId: string | null;
  targetClientIdentity: string | null;
  bytes: number;
  idempotencyKey: string | null;
  idempotencyHash: string | null;
  phase: PendingCommandPhase;
  settled: boolean;
  createdAt: number;
};

type IdempotencyEntry = {
  hash: string;
  state: "inflight" | "completed";
  sessionEpoch: number;
  sequence: number;
  promise: Promise<BridgeResultEvent>;
  resolve: ((event: BridgeResultEvent) => void) | null;
  result: BridgeResultEvent | null;
  commandId: string;
  createdAt: number;
  lastAccessed: number;
};

type LateResultRecord = {
  sessionId: string;
  commandId: string;
  sessionEpoch: number;
  sequence: number;
  identityClientId: string;
  idempotencyKey: string | null;
  idempotencyHash: string | null;
  createdAt: number;
  timer: NodeJS.Timeout | null;
};

type HostOptions = {
  authMode?: TransportAuthMode;
  browserTarget?: BrowserTarget;
  pairingSecret?: string;
  hostInstanceId?: string;
  observerRegistryDirectory?: string;
  observerToken?: string;
  limits?: Partial<typeof DEFAULT_LIMITS>;
};

type DispatchOptions = {
  timeoutMs: number;
  idempotencyKey?: string;
};

export type NewtonBrowserHost = ReturnType<typeof createNewtonBrowserHost>;

const STALE_OUTCOME = "outcome_unknown";
const STOPPED_ERROR = "session_stopped";
const QUEUE_ERROR = "queue_full";
const TIMEOUT_ERROR = "command_timeout";
const UNKNOWN_SESSION_ERROR = "unknown_session";
const CODE_BOUND = 128;
const REASON_BOUND = 8;
const DECISION_STRING_BOUND = 128;
const NORMALIZED_CLASS_VALUES = new Set(["read_only", "agentic", "approval_required", "blocked"]);
const NORMALIZED_COMMIT_BOUNDARIES = new Set(["none", "draft", "commit", "external_effect"]);
const ERROR_CODE_PATTERN = /^[a-z][a-z0-9_]{0,127}$/;

export function createNewtonBrowserHost(options: HostOptions = {}) {
  const limits = { ...DEFAULT_LIMITS, ...(options.limits ?? {}) };
  const authMode = options.authMode ?? (options.pairingSecret ? "paired" : loadTransportAuthMode());
  const browserTarget = options.browserTarget ?? loadBrowserTarget();
  const pairingSecret = options.pairingSecret ?? loadOrCreatePairingConfig().secret;
  const hostInstanceId = options.hostInstanceId ?? randomUUID();
  const observerRegistryDirectory = options.observerRegistryDirectory?.trim() ? path.resolve(options.observerRegistryDirectory) : null;
  const observerToken = options.observerToken?.trim() || null;
  if ((observerRegistryDirectory && !observerToken) || (!observerRegistryDirectory && observerToken)) throw new Error("observer_configuration_incomplete");
  if (observerToken && observerToken.length < 32) throw new Error("observer_token_too_short");

  const sessions = new Map<string, BridgeSessionInfo>();
  const sessionStates = new Map<string, SessionState>();
  const clients = new Map<string, HostClient>();
  const pendingByCommandId = new Map<string, PendingCommand>();
  const queuedWaiters = new Map<string, Set<() => void>>();
  const sessionActivity = new Map<string, number>();
  const pendingCommandCountBySession = new Map<string, number>();
  const idempotencyLedger = new Map<string, Map<string, IdempotencyEntry>>();
  const lateResults = new Map<string, LateResultRecord>();
  const lateResultOrder: string[] = [];

  let activeCommandCount = 0;
  let server: http.Server | null = null;
  let webSockets: WebSocketServer | null = null;
  let boundPort: number | null = null;
  const orphanReaper = setInterval(() => api.reapExpiredSessions(), Math.max(1000, Math.min(60_000, Math.floor(limits.orphanSessionTtlMs / 2))));
  orphanReaper.unref();

  const api = {
    hostInstanceId,
    limits,

    createSession(init: BridgeSessionInit): { sessionId: string } {
      if (sessions.size >= limits.maxSessions) throw new Error("session_limit");
      const sessionId = `bbs_local_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
      sessions.set(sessionId, {
        sessionId,
        hostInstanceId,
        origin: init.origin,
        allowedOrigins: Array.isArray(init.allowedOrigins) ? init.allowedOrigins : [init.origin],
        tabMode: init.tabMode,
        ownedTabId: init.ownedTabId ?? null,
        tabGroupId: init.tabGroupId ?? null,
        attached: false,
        liveOrigin: null,
        goal: init.goal ?? "",
        instanceLabel: init.instanceLabel ?? "",
        ...(init.incognito ? { incognito: true } : {}),
      });
      sessionStates.set(sessionId, { epoch: 1, sequence: 0, ownerId: null, ownerIdentity: null, inFlightCommandId: null, queuedCommandIds: [], queuedBytes: 0, isStopping: false });
      pendingCommandCountBySession.set(sessionId, 0);
      sessionActivity.set(sessionId, Date.now());
      broadcastSessionsChanged();
      return { sessionId };
    },

    listSessions(): BridgeSessionInfo[] {
      return [...sessions.values()].map((session) => ({ ...session, allowedOrigins: [...(session.allowedOrigins ?? [])] }));
    },

    getStatus() {
      return {
        hostInstanceId,
        authMode,
        browserTarget,
        port: boundPort,
        extensionConnected: eligibleClients().length > 0,
        authenticatedClientCount: authenticatedClients().length,
        eligibleClientCount: eligibleClients().length,
        connectedBrowsers: [...new Set(authenticatedClients().flatMap((client) => client.identity ? [client.identity.browserFamily] : []))].sort(),
        extensionVersion: eligibleClients().map((client) => client.identity?.version).find((version): version is string => typeof version === "string") ?? null,
        claimedSessionsByBrowser: claimedSessionCounts(),
        sessionCount: sessions.size,
        limits,
      };
    },

    reapExpiredSessions(now = Date.now()): number {
      let reaped = 0;
      for (const [sessionId, lastActivity] of sessionActivity) {
        if (now - lastActivity < limits.orphanSessionTtlMs) continue;
        api.stopSession(sessionId);
        reaped += 1;
      }
      return reaped;
    },

    reapExpiredIdempotencyEntries(now = Date.now()): number {
      let reaped = 0;
      for (const sessionId of [...idempotencyLedger.keys()]) {
        reaped += trimIdempotencyEntries(sessionId, now);
      }
      return reaped;
    },

    reapLateResultRecords(now = Date.now()): number {
      let reaped = 0;
      for (const [commandId, record] of [...lateResults]) {
        if (now - record.createdAt < limits.lateResultTtlMs) continue;
        removeLateResult(commandId);
        reaped += 1;
      }
      return reaped;
    },

    async waitForSessionReady(sessionId: string, timeoutMs = limits.readinessTimeoutMs): Promise<BridgeSessionInfo> {
      const ready = readySession(sessionId);
      if (ready) return ready;
      if (!sessions.has(sessionId)) throw new Error(UNKNOWN_SESSION_ERROR);
      return new Promise<BridgeSessionInfo>((resolve, reject) => {
        const finish = () => {
          const current = readySession(sessionId);
          if (!current) return;
          clearTimeout(timer);
          removeReadinessWaiter(sessionId, finish);
          resolve(current);
        };
        const timer = setTimeout(() => {
          removeReadinessWaiter(sessionId, finish);
          const error = eligibleClients().length === 0 ? "extension_disconnected" : "session_setup_timeout";
          api.stopSession(sessionId);
          reject(new Error(error));
        }, Math.max(50, Math.min(timeoutMs, limits.maxCommandTimeoutMs)));
        const waiters = queuedWaiters.get(sessionId) ?? new Set();
        waiters.add(finish);
        queuedWaiters.set(sessionId, waiters);
      });
    },

    stopSession(sessionId: string): void {
      const state = sessionStates.get(sessionId);
      if (!sessions.delete(sessionId) || !state) return;
      state.isStopping = true;
      removeSessionLateResults(sessionId);

      const queued = [...state.queuedCommandIds];
      const inFlightId = state.inFlightCommandId;
      const ownerId = state.ownerId;
      state.ownerId = null;
      state.inFlightCommandId = null;
      state.queuedCommandIds = [];
      state.queuedBytes = 0;

      if (inFlightId) {
        const command = pendingByCommandId.get(inFlightId);
        if (command) {
          const event = makeFailureResult(command, STALE_OUTCOME, STOPPED_ERROR);
          completePendingCommand(command, event);
        }
      }

      for (const commandId of queued) {
        const command = pendingByCommandId.get(commandId);
        if (!command) continue;
        const event = makeFailureResult(command, "not_started", STOPPED_ERROR);
        completePendingCommand(command, event);
      }

      sessionStates.delete(sessionId);
      if (ownerId) {
        clients.get(ownerId)?.subscriptions.delete(sessionId);
      }
      for (const client of clients.values()) client.subscriptions.delete(sessionId);
      sessionActivity.delete(sessionId);
      pendingCommandCountBySession.delete(sessionId);
      idempotencyLedger.delete(sessionId);
      notifyReadiness(sessionId);
      broadcastSessionsChanged();
    },

    stopAll(): void {
      for (const sessionId of [...sessions.keys()]) api.stopSession(sessionId);
      broadcast({ type: "stop_all", hostInstanceId });
    },

    async dispatch(sessionId: string, action: BridgeCommand["action"], timeoutOrOptions?: number | { timeoutMs?: number; idempotencyKey?: string }): Promise<BridgeResultEvent> {
      const state = sessionStates.get(sessionId);
      const parsed = parseDispatchOptions(timeoutOrOptions);
      if (!sessions.has(sessionId) || !state) {
        return makeFailureResultForUnknown(0, 0, "prevented", UNKNOWN_SESSION_ERROR);
      }
      sessionActivity.set(sessionId, Date.now());

      const sessionEpoch = state.epoch;
      const normalizedAction = action ?? { kind: "observe" };
      const actionKind = normalizedAction.kind ?? "observe";
      const owner = ownerClient(sessionId);

      let idempotencyKey: string | null = null;
      let idempotencyHash: string | null = null;
      if (parsed.idempotencyKey !== undefined) {
        idempotencyKey = normalizeAndValidateIdempotencyKey(parsed.idempotencyKey);
        if (!idempotencyKey) {
          return makeFailureResultForUnknown(sessionEpoch, 0, "prevented", "invalid_idempotency_key");
        }
        idempotencyHash = computeActionHash(sessionId, normalizedAction);
        const existing = lookupIdempotencyEntry(sessionId, idempotencyKey);
        if (existing) {
          if (existing.hash !== idempotencyHash) return makeConflictResult(existing.sessionEpoch, existing.sequence);
          if (existing.state === "completed" && existing.result) return cloneResult(existing.result);
          return existing.promise;
        }
        if (!canAddIdempotencyEntry(sessionId)) {
          const immediate = makeFailureResultForUnknown(sessionEpoch, 0, "prevented", "idempotency_ledger_full");
          return immediate;
        }
      }

      if (activeCommandCount >= limits.maxPending) {
        const immediate = makeFailureResultForUnknown(sessionEpoch, 0, "not_started", QUEUE_ERROR);
        if (idempotencyKey && idempotencyHash) upsertIdempotencyEntry(sessionId, idempotencyKey, idempotencyHash, immediate.commandId, immediate, 0);
        return immediate;
      }
      const sequence = state.sequence + 1;
      let settle!: (event: BridgeResultEvent) => void;
      const promise = new Promise<BridgeResultEvent>((resolve) => {
        settle = resolve;
      });
      const command = createPendingCommand({
        sessionId,
        commandId: `bbc_${Date.now().toString(36)}_${randomUUID().slice(0, 12)}`,
        sessionEpoch,
        sequence,
        actionKind,
        action: normalizedAction,
        timeoutMs: parsed.timeoutMs,
        resolve: settle,
        targetClientId: null,
        targetClientIdentity: null,
        idempotencyKey,
        idempotencyHash,
        createdAt: Date.now(),
      });

      if (!canEnqueueCommand(state, command)) {
        const rejected = makeFailureResultForUnknown(sessionEpoch, sequence, "not_started", QUEUE_ERROR);
        if (idempotencyKey && idempotencyHash) upsertIdempotencyEntry(sessionId, idempotencyKey, idempotencyHash, rejected.commandId, rejected, sequence);
        return rejected;
      }

      state.sequence = sequence;
      pendingByCommandId.set(command.commandId, command);
      activeCommandCount += 1;
      pendingCommandCountBySession.set(sessionId, (pendingCommandCountBySession.get(sessionId) ?? 0) + 1);
      command.timer = setTimeout(() => onCommandTimeout(command), Math.max(100, Math.min(command.timeoutMs, limits.maxCommandTimeoutMs)));

      if (idempotencyKey && idempotencyHash) upsertIdempotencyEntry(sessionId, idempotencyKey, idempotencyHash, command.commandId, null, sequence);

      if (!state.inFlightCommandId && owner && owner.subscriptions.has(sessionId)) {
        if (sendCommandToOwner(sessionId, command)) {
          return promise;
        }
      }

      enqueueCommand(sessionId, command);
      return promise;
    },

    async listen(port?: number, host = "127.0.0.1"): Promise<{ port: number; host: string; hostInstanceId: string }> {
      if (server && boundPort !== null) return { port: boundPort, host, hostInstanceId };
      const candidates = port === 0
        ? [0]
        : Number.isInteger(port)
          ? [Number(port)]
          : range(limits.firstPort, limits.lastPort);
      let lastError: unknown = null;
      for (const candidate of candidates) {
        try {
          const started = await startHttpServer(candidate, host);
          server = started.server;
          webSockets = started.webSockets;
          boundPort = started.port;
          persistObserverState();
          return { port: started.port, host, hostInstanceId };
        } catch (error) {
          lastError = error;
          if ((error as NodeJS.ErrnoException)?.code !== "EADDRINUSE") throw error;
        }
      }
      const detail = lastError instanceof Error ? lastError.message : String(lastError ?? "port range exhausted");
      throw new Error(`host_collision: ${detail}`);
    },

    async close(): Promise<void> {
      clearInterval(orphanReaper);
      const closingClients = [...clients.values()];
      const closedClients = closingClients.map((client) => new Promise<void>((resolve) => {
        if (client.authTimer) clearTimeout(client.authTimer);
        if (client.socket.readyState === WebSocket.CLOSED) {
          resolve();
          return;
        }
        client.socket.once("close", () => resolve());
        client.socket.terminate();
      }));
      await Promise.all(closedClients);
      clients.clear();
      for (const [commandId, command] of pendingByCommandId) {
        const state = sessionStates.get(command.sessionId);
        if (state) {
          state.queuedCommandIds = state.queuedCommandIds.filter((candidate) => candidate !== command.commandId);
          if (state.inFlightCommandId === command.commandId) state.inFlightCommandId = null;
        }
        const failed = makeFailureResult(command, STALE_OUTCOME, STOPPED_ERROR);
        completePendingCommand(command, failed);
      }
      pendingByCommandId.clear();
      activeCommandCount = 0;
      clearTimeoutsForSessions();
      for (const record of lateResults.values()) {
        if (record.timer) clearTimeout(record.timer);
      }
      lateResults.clear();
      lateResultOrder.length = 0;
      idempotencyLedger.clear();
      sessions.clear();
      sessionStates.clear();
      sessionActivity.clear();
      pendingCommandCountBySession.clear();
      await new Promise<void>((resolve) => webSockets?.close(() => resolve()) ?? resolve());
      webSockets = null;
      if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
      server = null;
      boundPort = null;
      removeObserverState();
    },
  };

  return api;

  function clearTimeoutsForSessions() {
    for (const state of sessionStates.values()) {
      if (state.inFlightCommandId) state.inFlightCommandId = null;
      state.queuedCommandIds = [];
      state.queuedBytes = 0;
    }
  }

  async function startHttpServer(port: number, host: string) {
    const candidateServer = http.createServer((request, response) => {
      if (request.url === "/health") {
        response.writeHead(204, { "Cache-Control": "no-store" }).end();
        return;
      }
      if (request.url === "/doctor-status") {
        if (!validDoctorToken(pairingSecret, request.headers["x-newton-browser-doctor"])) {
          response.writeHead(403, { "Cache-Control": "no-store", "Content-Type": "application/json" }).end('{"ok":false,"errorCode":"authentication_failed"}');
          return;
        }
        response.writeHead(200, { "Cache-Control": "no-store", "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, ...api.getStatus() }));
        return;
      }
      const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
      if (["/observer-status", "/observer-focus", "/observer-trusted-fill"].includes(requestUrl.pathname)) {
        if (!validObserverRequest(request.headers.authorization)) {
          response.writeHead(403, { "Cache-Control": "no-store", "Content-Type": "application/json" }).end('{"ok":false,"errorCode":"authentication_failed"}');
          return;
        }
        if (requestUrl.pathname === "/observer-status" && request.method === "GET") {
          response.writeHead(200, { "Cache-Control": "no-store", "Content-Type": "application/json" }).end(JSON.stringify(observerSnapshot()));
          return;
        }
        if (requestUrl.pathname === "/observer-focus" && request.method === "POST") {
          const sessionId = requestUrl.searchParams.get("sessionId") ?? "";
          void api.dispatch(sessionId, { kind: "__focus" } as never).then((event) => {
            const status = event.ok ? 200 : 409;
            response.writeHead(status, { "Cache-Control": "no-store", "Content-Type": "application/json" }).end(JSON.stringify(event.ok ? { ok: true, result: event.result } : { ok: false, errorCode: event.errorCode }));
          });
          return;
        }
        if (requestUrl.pathname === "/observer-trusted-fill" && request.method === "POST") {
          void readObserverBody(request).then((body) => {
            const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
            const ref = typeof body.ref === "string" ? body.ref : "";
            const value = typeof body.value === "string" ? body.value : "";
            if (!sessionId || !/^ref_[A-Za-z0-9_-]{1,180}$/u.test(ref) || !value || value.length > 512) {
              response.writeHead(400, { "Cache-Control": "no-store", "Content-Type": "application/json" }).end('{"ok":false,"errorCode":"trusted_fill_invalid"}');
              return;
            }
            return api.dispatch(sessionId, { kind: "__trusted_fill", target: { ref }, value } as never).then((event) => {
              const status = event.ok ? 200 : 409;
              response.writeHead(status, { "Cache-Control": "no-store", "Content-Type": "application/json" }).end(JSON.stringify(event.ok ? { ok: true, result: { filled: true } } : { ok: false, errorCode: event.errorCode }));
            });
          }).catch(() => response.writeHead(400, { "Cache-Control": "no-store" }).end());
          return;
        }
        response.writeHead(405, { "Cache-Control": "no-store" }).end();
        return;
      }
      response.writeHead(404).end();
    });
    const candidateSockets = new WebSocketServer({ noServer: true, maxPayload: limits.maxMessageBytes });
    candidateServer.on("upgrade", (request, socket, head) => {
      if (!isAllowedWebSocketOrigin(request.headers.origin)) {
        socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      candidateSockets.handleUpgrade(request, socket, head, (webSocket) => {
        candidateSockets.emit("connection", webSocket, request);
      });
    });
    candidateSockets.on("connection", (socket) => addClient(socket));
    const actualPort = await new Promise<number>((resolve, reject) => {
      const onError = (error: Error) => {
        candidateServer.off("listening", onListening);
        candidateSockets.close();
        reject(error);
      };
      const onListening = () => {
        candidateServer.off("error", onError);
        const address = candidateServer.address();
        resolve(address && typeof address === "object" ? address.port : port);
      };
      candidateServer.once("error", onError);
      candidateServer.once("listening", onListening);
      candidateServer.listen(port, host);
    });
    return { server: candidateServer, webSockets: candidateSockets, port: actualPort };
  }

  function addClient(socket: WebSocket): void {
    const pairingRequired = authMode === "paired";
    const nonce = randomBytes(24).toString("base64url");
    const client = {
      id: randomUUID(),
      socket,
      authenticated: !pairingRequired,
      identity: null,
      nonce,
      authTimer: pairingRequired ? setTimeout(() => socket.close(4001, "pairing required"), limits.authTimeoutMs) : null,
      subscriptions: new Set<string>(),
    } satisfies HostClient;
    clients.set(client.id, client);
    socket.on("message", (data, isBinary) => {
      if (isBinary) return socket.close(1003, "text frames only");
      handleClientMessage(client, data.toString()).catch(() => socket.close(1011, "bridge error"));
    });
    socket.on("close", () => removeClient(client));
    socket.on("error", () => removeClient(client));
    if (pairingRequired) send(client, { type: "auth_challenge", protocol: "newton-browser-auth-v1", hostInstanceId, nonce });
    else send(client, { type: "ready", hostInstanceId, authMode, browserTarget, version: NEWTON_BROWSER_VERSION, sessions: api.listSessions() });
  }

  async function handleClientMessage(client: HostClient, text: string): Promise<void> {
    if (Buffer.byteLength(text, "utf8") > limits.maxMessageBytes) return client.socket.close(1009, "message too large");
    let message: any;
    try {
      message = JSON.parse(text);
    } catch {
      return client.socket.close(1007, "invalid json");
    }
    if (message?.type === "client_hello") {
      registerClientIdentity(client, message);
      return;
    }
    if (!client.authenticated) {
      if (message?.type !== "auth_response" || message.hostInstanceId !== hostInstanceId || !validProof(client.nonce, message.proof)) {
        return client.socket.close(4003, "authentication failed");
      }
      client.authenticated = true;
      if (client.authTimer) clearTimeout(client.authTimer);
      client.authTimer = null;
      send(client, { type: "ready", hostInstanceId, authMode, browserTarget, version: NEWTON_BROWSER_VERSION, sessions: api.listSessions() });
      return;
    }
    if (message?.type !== "bridge_request") return;
    try {
      const result = await handleBridgeRequest(client, message);
      send(client, { type: "bridge_response", requestId: message.requestId, ok: true, result });
    } catch (error) {
      send(client, { type: "bridge_response", requestId: message.requestId, ok: false, error: errorCode(error) });
    }
  }

  async function handleBridgeRequest(client: HostClient, message: any): Promise<unknown> {
    const params = message.params && typeof message.params === "object" ? message.params : {};
    requireIdentity(client);
    if (message.method === "createSession") {
      requireEligible(client);
      const created = api.createSession(params);
      setSessionOwner(created.sessionId, client.id, false);
      return created;
    }
    if (message.method === "attachTab") return attachTab(client, params);
    if (message.method === "listSessions") return claimSessions(client);
    if (message.method === "subscribeSession") return subscribeSession(client, params.sessionId);
    if (message.method === "unsubscribeSession") return unsubscribeSession(client, params.sessionId);
    if (message.method === "postEvent") return requireSessionOwner(client, String(params.commandId ?? ""));
    if (message.method === "postResult") return postBridgeResult(client, params.event);
    if (message.method === "stopSession") return stopOwnedSession(client, params.sessionId);
    if (message.method === "stopAll") return stopOwnedSessions(client);
    throw new Error("unknown_bridge_method");
  }

  function attachTab(client: HostClient, params: any): void {
    const sessionId = String(params.sessionId ?? "");
    requireSessionOwner(client, sessionId);
    const session = sessions.get(sessionId);
    if (!session) throw new Error(UNKNOWN_SESSION_ERROR);
    if (session) {
      const state = ensureSessionState(sessionId);
      session.ownedTabId = Number.isInteger(params.tab?.ownedTabId) ? params.tab.ownedTabId : session.ownedTabId ?? null;
      session.tabGroupId = Number.isInteger(params.tab?.tabGroupId) ? params.tab.tabGroupId : session.tabGroupId ?? null;
      session.attached = params.tab?.attached === true;
      session.liveOrigin = typeof params.tab?.liveOrigin === "string" ? params.tab.liveOrigin : session.liveOrigin ?? null;
      notifyReadiness(sessionId);
      broadcastSessionsChanged();
      if (!state.inFlightCommandId) dispatchNext(sessionId);
    }
  }

  function postBridgeResult(client: HostClient, event: BridgeResultEvent): void {
    const commandId = String(event?.commandId ?? "");
    const sessionEpoch = normalizePositiveInteger(event?.sessionEpoch);
    const sequence = normalizePositiveInteger(event?.sequence);
    if (!Number.isSafeInteger(sessionEpoch) || !Number.isSafeInteger(sequence)) return;
    const command = pendingByCommandId.get(commandId);
    if (command) {
      if (command.settled) return;
      const owner = ownerClient(command.sessionId);
      if (!owner || owner.id !== client.id) return;
      const state = sessionStates.get(command.sessionId);
      if (!state || state.inFlightCommandId !== command.commandId) return;
      if (command.targetClientId !== client.id || command.phase !== "sent") return;
      if (command.sessionEpoch !== sessionEpoch || command.sequence !== sequence) return;
      const payloadSize = Buffer.byteLength(JSON.stringify(event), "utf8");
      if (payloadSize > limits.maxMessageBytes || payloadSize > limits.maxResultBytes) {
        completePendingCommand(
          command,
          normalizeBridgeResult(
            { ok: false, errorCode: "result_too_large" },
            command.sessionEpoch,
            command.sequence,
            command.commandId,
            false,
            "outcome_unknown",
            true,
          ),
        );
        return;
      }
      const normalized = normalizeBridgeResult(
        event,
        command.sessionEpoch,
        command.sequence,
        command.commandId,
        false,
        "outcome_unknown",
        true,
      );
      completePendingCommand(command, normalized);
      return;
    }
    const record = lateResults.get(commandId);
    if (record) {
      const clientIdentity = client.identity?.clientId;
      if (!clientIdentity || clientIdentity !== record.identityClientId) return;
      if (record.sessionEpoch !== sessionEpoch || record.sequence !== sequence) return;
      if (!record.idempotencyKey || !record.idempotencyHash) return;
      const entry = lookupIdempotencyEntry(record.sessionId, record.idempotencyKey);
      if (!entry || entry.hash !== record.idempotencyHash) return;
      const owner = ownerClient(record.sessionId);
      if (!owner || !owner.identity || owner.identity.clientId !== record.identityClientId) return;
      const payloadSize = Buffer.byteLength(JSON.stringify(event), "utf8");
      if (payloadSize > limits.maxMessageBytes || payloadSize > limits.maxResultBytes) {
        finalizeIdempotency(record.sessionId, record.idempotencyKey, record.idempotencyHash, normalizeBridgeResult(
          { ok: false, errorCode: "result_too_large" },
          record.sessionEpoch,
          record.sequence,
          record.commandId,
          true,
          "outcome_unknown",
          true,
        ));
      } else {
        const normalized = normalizeBridgeResult(
          event,
          record.sessionEpoch,
          record.sequence,
          record.commandId,
          true,
          "outcome_unknown",
          true,
        );
        finalizeIdempotency(record.sessionId, record.idempotencyKey, record.idempotencyHash, normalized);
      }
      removeLateResult(commandId);
      return;
    }
  }

  function subscribeSession(client: HostClient, sessionId: unknown): void {
    const normalized = String(sessionId ?? "");
    requireSessionOwner(client, normalized);
    client.subscriptions.add(normalized);
    dispatchNext(normalized);
  }

  function enqueueCommand(sessionId: string, command: PendingCommand): void {
    const state = ensureSessionState(sessionId);
    state.queuedCommandIds.push(command.commandId);
    state.queuedBytes += command.bytes;
  }

  function canEnqueueCommand(state: SessionState, command: PendingCommand): boolean {
    const inFlight = state.inFlightCommandId ? pendingByCommandId.get(state.inFlightCommandId) : null;
    const activeCount = state.queuedCommandIds.length + (inFlight ? 1 : 0);
    const currentBytes = state.queuedBytes + (inFlight?.bytes ?? 0) + command.bytes;
    const hasQueuedCapacity = activeCount < limits.maxQueuedPerSession;
    const hasByteCapacity = currentBytes <= limits.maxQueuedBytesPerSession;
    return hasQueuedCapacity && hasByteCapacity;
  }

  function sendCommandToOwner(sessionId: string, command: PendingCommand): boolean {
    const state = ensureSessionState(sessionId);
    const owner = ownerClient(sessionId);
    if (!owner || !owner.subscriptions.has(sessionId) || state.inFlightCommandId) return false;
    state.inFlightCommandId = command.commandId;
    command.phase = "sent";
    command.targetClientId = owner.id;
    command.targetClientIdentity = owner.identity?.clientId ?? "";
    pendingByCommandId.set(command.commandId, command);
    const dispatched = send(owner, { type: "bridge_command", command: commandMessage(command) });
    if (!dispatched) {
      command.phase = "queued";
      command.targetClientId = null;
      command.targetClientIdentity = null;
      state.inFlightCommandId = null;
      return false;
    }
    return true;
  }

  function commandMessage(command: PendingCommand): BridgeCommand {
    return {
      commandId: command.commandId,
      sessionId: command.sessionId,
      sessionEpoch: command.sessionEpoch,
      sequence: command.sequence,
      actionKind: command.actionKind,
      action: command.action,
    };
  }

  function onCommandTimeout(command: PendingCommand): void {
    const active = pendingByCommandId.get(command.commandId);
    if (!active || command.settled || (command.phase !== "sent" && command.phase !== "queued")) return;
    const state = sessionStates.get(command.sessionId);
    if (!state) return;
    if (command.phase === "sent" && state.inFlightCommandId !== command.commandId) return;
    const event = makeFailureResult(
      command,
      command.phase === "sent" ? STALE_OUTCOME : "not_started",
      TIMEOUT_ERROR,
    );
    if (command.idempotencyKey && command.phase === "sent") {
      createLateResultRecord(command, command.idempotencyKey, command.idempotencyHash);
      finalizeIdempotency(command.sessionId, command.idempotencyKey, command.idempotencyHash, event);
      completePendingCommand(command, event);
      return;
    }
    completePendingCommand(command, event);
  }

  function createLateResultRecord(command: PendingCommand, idempotencyKey: string | null, idempotencyHash: string | null): void {
    const existing = lateResults.get(command.commandId);
    if (existing) {
      removeLateResult(existing.commandId);
    }
    lateResultOrder.push(command.commandId);
    while (lateResultOrder.length > limits.lateResultCap) {
      const removed = lateResultOrder.shift();
      if (!removed) continue;
      removeLateResult(removed);
    }
    lateResults.set(command.commandId, {
      sessionId: command.sessionId,
      commandId: command.commandId,
      sessionEpoch: command.sessionEpoch,
      sequence: command.sequence,
      identityClientId: command.targetClientIdentity ?? "",
      idempotencyKey,
      idempotencyHash,
      createdAt: Date.now(),
      timer: setTimeout(() => removeLateResult(command.commandId), limits.lateResultTtlMs),
    });
  }

  function dispatchNext(sessionId: string): void {
    const state = sessionStates.get(sessionId);
    if (!state || state.isStopping) return;
    if (state.inFlightCommandId) return;
    const owner = ownerClient(sessionId);
    if (!owner || !owner.subscriptions.has(sessionId)) return;
    while (state.queuedCommandIds.length > 0) {
      const commandId = state.queuedCommandIds.shift();
      if (!commandId) return;
      const command = pendingByCommandId.get(commandId);
      if (!command || command.settled) {
        if (command) state.queuedBytes = Math.max(0, state.queuedBytes - command.bytes);
        continue;
      }
      state.queuedBytes = Math.max(0, state.queuedBytes - command.bytes);
      if (Date.now() >= command.createdAt + command.timeoutMs) {
        completePendingCommand(command, makeFailureResult(command, "not_started", TIMEOUT_ERROR));
        return;
      }
      if (!sendCommandToOwner(sessionId, command)) {
        state.queuedCommandIds.unshift(commandId);
        state.queuedBytes += command.bytes;
        return;
      }
      return;
    }
  }

  function completePendingCommand(command: PendingCommand, event: BridgeResultEvent): void {
    if (command.settled) return;
    const state = sessionStates.get(command.sessionId);
    command.settled = true;
    const timer = command.timer;
    if (timer) clearTimeout(timer);
    command.timer = null;
    if (state && state.inFlightCommandId === command.commandId) {
      state.inFlightCommandId = null;
    }
    if (state && state.queuedCommandIds.includes(command.commandId)) {
      state.queuedBytes = Math.max(0, state.queuedBytes - command.bytes);
      state.queuedCommandIds = state.queuedCommandIds.filter((candidate) => candidate !== command.commandId);
    }
    if (pendingByCommandId.delete(command.commandId)) {
      pendingCommandCountBySession.set(command.sessionId, Math.max(0, (pendingCommandCountBySession.get(command.sessionId) ?? 0) - 1));
      activeCommandCount = Math.max(0, activeCommandCount - 1);
      if (command.idempotencyKey && command.idempotencyHash) finalizeIdempotency(command.sessionId, command.idempotencyKey, command.idempotencyHash, event);
      command.resolve(event);
      if (state && !state.isStopping) dispatchNext(command.sessionId);
    }
  }

  function finalizeIdempotency(sessionId: string, key: string, hash: string | null, event: BridgeResultEvent): void {
    if (!key || !hash) return;
    const entry = lookupIdempotencyEntry(sessionId, key);
    if (!entry || entry.hash !== hash) return;
    if (entry.commandId !== event.commandId || entry.sessionEpoch !== event.sessionEpoch || entry.sequence !== event.sequence) return;
    if (entry.state === "completed") {
      if (!canReplaceCompletedIdempotencyResult(entry.result, event)) return;
      entry.lastAccessed = Date.now();
      entry.result = event;
      entry.commandId = event.commandId;
      return;
    }
    entry.lastAccessed = Date.now();
    entry.result = event;
    entry.state = "completed";
    if (entry.resolve) {
      entry.resolve(event);
      entry.resolve = null;
    }
  }

  function canReplaceCompletedIdempotencyResult(previous: BridgeResultEvent | null, next: BridgeResultEvent): boolean {
    if (!previous) return false;
    if (previous.outcome !== STALE_OUTCOME) return false;
    if (previous.errorCode !== TIMEOUT_ERROR) return false;
    if (next.ok) return next.outcome === "completed";
    return next.outcome === "completed" || next.outcome === "prevented";
  }

  function upsertIdempotencyEntry(sessionId: string, key: string, hash: string, commandId: string, completed: BridgeResultEvent | null, sequence?: number): void {
    const sessionEntries = idempotencyLedger.get(sessionId) ?? new Map<string, IdempotencyEntry>();
    const state = sessionStates.get(sessionId);
    let resolve: ((event: BridgeResultEvent) => void) | null = null;
    const promise = completed
      ? Promise.resolve(completed)
      : new Promise<BridgeResultEvent>((promiseResolve) => {
        resolve = promiseResolve;
      });
    const now = Date.now();
    sessionEntries.set(key, {
      hash,
      state: completed ? "completed" : "inflight",
      sessionEpoch: state?.epoch ?? 0,
      sequence: sequence ?? (state?.sequence ?? 0),
      promise,
      resolve,
      result: completed,
      commandId,
      createdAt: now,
      lastAccessed: now,
    });
    idempotencyLedger.set(sessionId, sessionEntries);
    trimIdempotencyEntries(sessionId);
  }

  function lookupIdempotencyEntry(sessionId: string, key: string): IdempotencyEntry | null {
    const now = Date.now();
    const sessionEntries = idempotencyLedger.get(sessionId);
    if (!sessionEntries) return null;
    const entry = sessionEntries.get(key) ?? null;
    if (!entry) return null;
    if (entry.state === "completed" && now - entry.lastAccessed > limits.idempotencyTtlMs) {
      sessionEntries.delete(key);
      if (sessionEntries.size === 0) idempotencyLedger.delete(sessionId);
      return null;
    }
    entry.lastAccessed = now;
    return entry;
  }

  function trimIdempotencyEntries(sessionId: string, now = Date.now()): number {
    const sessionEntries = idempotencyLedger.get(sessionId);
    if (!sessionEntries) return 0;
    let removed = 0;
    for (const [key, entry] of [...sessionEntries.entries()]) {
      if (entry.state !== "completed") continue;
      if (now - entry.lastAccessed > limits.idempotencyTtlMs) {
        sessionEntries.delete(key);
        removed += 1;
      }
    }
    if (sessionEntries.size <= limits.maxIdempotencyEntriesPerSession) return removed;
    const ordered = [...sessionEntries.entries()]
      .filter(([, entry]) => entry.state === "completed")
      .sort((a, b) => a[1].lastAccessed - b[1].lastAccessed);
    while (sessionEntries.size > limits.maxIdempotencyEntriesPerSession && ordered.length > 0) {
      const oldest = ordered.shift();
      if (!oldest) break;
      sessionEntries.delete(oldest[0]);
      removed += 1;
    }
    if (sessionEntries.size === 0) idempotencyLedger.delete(sessionId);
    else idempotencyLedger.set(sessionId, sessionEntries);
    return removed;
  }

  function canAddIdempotencyEntry(sessionId: string): boolean {
    trimIdempotencyEntries(sessionId);
    const entries = idempotencyLedger.get(sessionId);
    if (!entries) return true;
    if (entries.size < limits.maxIdempotencyEntriesPerSession) return true;
    const completed = [...entries.values()].filter((entry) => entry.state === "completed");
    return completed.length > 0;
  }

  function unregisterFromOwner(sessionId: string): void {
    const state = ensureSessionState(sessionId);
    if (!state.ownerId) return;
    state.ownerId = null;
    state.epoch += 1;
    state.sequence = 0;
    if (state.inFlightCommandId) {
      const command = pendingByCommandId.get(state.inFlightCommandId);
      if (command) {
        const event = makeFailureResult(command, STALE_OUTCOME, "owner_disconnected");
        createLateResultRecord(command, command.idempotencyKey, command.idempotencyHash);
        completePendingCommand(command, event);
      }
    }
    const queued = [...state.queuedCommandIds];
    state.queuedCommandIds = [];
    state.queuedBytes = 0;
    for (const commandId of queued) {
      const command = pendingByCommandId.get(commandId);
      if (!command) continue;
      const notStarted = makeFailureResult(command, "not_started", "owner_disconnected");
      completePendingCommand(command, notStarted);
    }
    broadcastReadiness(sessionId);
  }

  function removeSessionLateResults(sessionId: string): void {
    for (const [commandId, record] of [...lateResults.entries()]) {
      if (record.sessionId === sessionId) {
        removeLateResult(commandId);
      }
    }
  }

  function removeLateResult(commandId: string): void {
    const record = lateResults.get(commandId);
    if (!record) return;
    if (record.timer) clearTimeout(record.timer);
    lateResults.delete(commandId);
    const index = lateResultOrder.indexOf(commandId);
    if (index >= 0) lateResultOrder.splice(index, 1);
  }

  function registerClientIdentity(client: HostClient, message: any): void {
    const clientId = String(message.clientId ?? "");
    const browserFamily = String(message.browserFamily ?? "");
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(clientId) || !["chrome", "edge", "chromium"].includes(browserFamily)) {
      throw new Error("invalid_client_identity");
    }
    for (const other of clients.values()) {
      if (other.id === client.id || other.identity?.clientId !== clientId) continue;
      removeClient(other);
      other.socket.close(4004, "client replaced");
    }
    client.identity = {
      clientId,
      browserFamily: browserFamily as "chrome" | "edge" | "chromium",
      ...(typeof message.version === "string" ? { version: message.version.slice(0, 32) } : {}),
    };
    send(client, { type: "client_ready", hostInstanceId, browserTarget, eligible: isEligible(client) });
    send(client, { type: "sessions_changed", hostInstanceId, sessions: api.listSessions() });
  }

  function claimSessions(client: HostClient): BridgeSessionInfo[] {
    requireEligible(client);
    const claimed: BridgeSessionInfo[] = [];
    for (const session of sessions.values()) {
      const state = ensureSessionState(session.sessionId);
      if (state.ownerId === null) setSessionOwner(session.sessionId, client.id, false);
      if (state.ownerId === client.id) claimed.push({ ...session, allowedOrigins: [...(session.allowedOrigins ?? [])] });
    }
    return claimed;
  }

  function unsubscribeSession(client: HostClient, sessionId: unknown): boolean {
    const normalized = String(sessionId ?? "");
    requireSessionOwner(client, normalized);
    return client.subscriptions.delete(normalized);
  }

  function stopOwnedSession(client: HostClient, sessionId: unknown): void {
    const normalized = String(sessionId ?? "");
    requireSessionOwner(client, normalized);
    api.stopSession(normalized);
  }

  function stopOwnedSessions(client: HostClient): void {
    for (const [sessionId, state] of sessionStates) {
      if (state.ownerId !== client.id) continue;
      api.stopSession(sessionId);
    }
  }

  function requireIdentity(client: HostClient): void {
    if (!client.identity) throw new Error("client_identity_required");
  }

  function requireEligible(client: HostClient): void {
    requireIdentity(client);
    if (!isEligible(client)) throw new Error("browser_not_selected");
  }

  function requireSessionOwner(client: HostClient, sessionId: unknown): void {
    const normalized = String(sessionId ?? "");
    if (!sessions.has(normalized)) throw new Error(UNKNOWN_SESSION_ERROR);
    const state = ensureSessionState(normalized);
    if (state.ownerId === null) setSessionOwner(normalized, client.id, false);
    if (!state.ownerId || state.ownerId !== client.id) throw new Error("session_not_owned");
    const sessionOwner = clients.get(state.ownerId);
    if (!sessionOwner || !isEligible(sessionOwner)) throw new Error("session_not_owned");
  }

  function setSessionOwner(sessionId: string, clientId: string, replacement: boolean): void {
    const state = ensureSessionState(sessionId);
    if (state.ownerId === clientId) return;
    const nextIdentity = clients.get(clientId)?.identity?.clientId ?? null;
    if (!replacement) {
      if (state.ownerId === null) {
        if (state.ownerIdentity && nextIdentity && state.ownerIdentity !== nextIdentity) clearSessionBinding(sessionId);
        state.ownerId = clientId;
        state.ownerIdentity = nextIdentity;
      }
      return;
    }
    if (state.ownerId) unregisterFromOwner(sessionId);
    if (state.ownerIdentity && nextIdentity && state.ownerIdentity !== nextIdentity) clearSessionBinding(sessionId);
    state.ownerId = clientId;
    state.ownerIdentity = nextIdentity;
  }

  function clearSessionBinding(sessionId: string): void {
    const session = sessions.get(sessionId);
    if (!session) return;
    session.attached = false;
    session.ownedTabId = null;
    session.tabGroupId = null;
    session.liveOrigin = null;
  }

  function ownerClient(sessionId: string): HostClient | null {
    const state = sessionStates.get(sessionId);
    const ownerId = state?.ownerId;
    const owner = ownerId ? clients.get(ownerId) : null;
    return owner && isEligible(owner) ? owner : null;
  }

  function authenticatedClients(): HostClient[] {
    return [...clients.values()].filter((client) => client.authenticated && client.socket.readyState === WebSocket.OPEN);
  }

  function eligibleClients(): HostClient[] {
    return authenticatedClients().filter((client) => isEligible(client));
  }

  function isEligible(client: HostClient): boolean {
    return client.authenticated && client.socket.readyState === WebSocket.OPEN && client.identity !== null
      && (browserTarget === "auto" || client.identity.browserFamily === browserTarget);
  }

  function ensureSessionState(sessionId: string): SessionState {
    const state = sessionStates.get(sessionId);
    if (!state) {
      const next = { epoch: 1, sequence: 0, ownerId: null, ownerIdentity: null, inFlightCommandId: null, queuedCommandIds: [], queuedBytes: 0, isStopping: false };
      sessionStates.set(sessionId, next);
      pendingCommandCountBySession.set(sessionId, 0);
      return next;
    }
    return state;
  }

  function createPendingCommand(params: Omit<PendingCommand, "phase" | "settled" | "bytes" | "timer"> & { timer?: PendingCommand["timer"] }): PendingCommand {
    const command = {
      ...params,
      phase: "queued" as const,
      settled: false,
      createdAt: Date.now(),
      timer: params.timer ?? null,
      bytes: 0,
    };
    command.bytes = commandBytes(commandMessage({
      ...command,
      phase: "sent",
      settled: false,
      bytes: 0,
      timer: null,
      targetClientId: null,
      resolve: command.resolve,
    }));
    return command;
  }

  function makeFailureResultForUnknown(sessionEpoch: number, sequence: number, outcome: "prevented" | "not_started", errorCode: string): BridgeResultEvent {
    return {
      commandId: `bbc_unknown_${sessionEpoch}_${sequence}`,
      ok: false,
      ...makeMetadata(sessionEpoch, sequence, outcome, true),
      errorCode,
      outcome,
    };
  }

  function makeConflictResult(sessionEpoch: number, sequence: number): BridgeResultEvent {
    return normalizeBridgeResult({
      ok: false,
      errorCode: "idempotency_conflict",
    }, sessionEpoch, sequence, `bbc_conflict_${sessionEpoch}_${sequence}`, true, "prevented");
  }

  function makeFailureResult(
    command: PendingCommand,
    outcome: "prevented" | "not_started" | "outcome_unknown",
    errorCode: string,
  ): BridgeResultEvent {
    return normalizeBridgeResult({
      ok: false,
      errorCode,
    }, command.sessionEpoch, command.sequence, command.commandId, false, outcome);
  }

  function normalizeBridgeResult(
    raw: Partial<BridgeResultEvent> & { ok: boolean; errorCode?: string },
    sessionEpoch: number,
    sequence: number,
    commandId: string,
    lateResultDiscarded: boolean,
    outcome?: "prevented" | "not_started" | "outcome_unknown" | "completed",
    enforceDispatchedContract = false,
  ): BridgeResultEvent {
    const rawOutcome = typeof raw.outcome === "string" ? raw.outcome : undefined;
    const hasRawOutcome = Object.prototype.hasOwnProperty.call(raw, "outcome");
    if (typeof raw.ok !== "boolean") {
      return normalizeProtocolViolation(sessionEpoch, sequence, commandId, lateResultDiscarded, enforceDispatchedContract);
    }

    const normalizedRawOutcome = normalizeBridgeOutcome(rawOutcome);
    const requestedOutcome = normalizeBridgeOutcome(outcome);
    const ok = raw.ok;
    const finalOutcome = resolveOutcome(ok, requestedOutcome, normalizedRawOutcome, hasRawOutcome, enforceDispatchedContract);
    if (!finalOutcome) {
      return normalizeProtocolViolation(sessionEpoch, sequence, commandId, lateResultDiscarded, enforceDispatchedContract);
    }

    if (ok && finalOutcome !== "completed") {
      return {
        commandId,
        ok: false,
        sessionEpoch,
        sequence,
        outcome: "prevented",
        retrySafe: deriveRetrySafe("prevented"),
        ...(lateResultDiscarded ? { lateResultDiscarded: true } : {}),
        errorCode: normalizeErrorCode("protocol_violation"),
      };
    }
    if (ok) {
      return {
        commandId,
        ok: true,
        sessionEpoch,
        sequence,
        outcome: "completed",
        retrySafe: false,
        ...(lateResultDiscarded ? { lateResultDiscarded: true } : {}),
        result: raw.result,
        decision: normalizeDecision(raw.decision),
      };
    }
    return {
      commandId,
      ok: false,
      sessionEpoch,
      sequence,
      outcome: finalOutcome,
      retrySafe: deriveRetrySafe(finalOutcome),
      ...(lateResultDiscarded ? { lateResultDiscarded: true } : {}),
      errorCode: normalizeErrorCode(raw.errorCode),
      decision: normalizeDecision(raw.decision),
    };
  }

  function resolveOutcome(
    ok: boolean,
    requested: BrowserCommandOutcome | undefined,
    raw: BrowserCommandOutcome | undefined,
    hasRawOutcome: boolean,
    enforceDispatchedContract: boolean,
  ): BrowserCommandOutcome | null {
    if (ok) {
      if (hasRawOutcome) return raw === "completed" ? "completed" : null;
      return "completed";
    }
    if (hasRawOutcome) {
      if (raw === undefined) return null;
      if (enforceDispatchedContract && raw === "not_started") return null;
      return raw;
    }
    if (enforceDispatchedContract) return requested ?? "outcome_unknown";
    const candidate = requested ?? "prevented";
    if (
      candidate === "completed"
      || candidate === "prevented"
      || candidate === "outcome_unknown"
      || candidate === "not_started"
    ) {
      return candidate;
    }
    return null;
  }

  function deriveRetrySafe(outcome: "completed" | "not_started" | "prevented" | "outcome_unknown"): boolean {
    return outcome === "not_started" || outcome === "prevented";
  }

  function normalizeProtocolViolation(
    sessionEpoch: number,
    sequence: number,
    commandId: string,
    lateResultDiscarded: boolean,
    enforceDispatchedContract: boolean,
  ): BridgeResultEvent {
    const outcome = enforceDispatchedContract ? "outcome_unknown" : "prevented";
    return {
      commandId,
      ok: false,
      sessionEpoch,
      sequence,
      outcome,
      retrySafe: deriveRetrySafe(outcome),
      ...(lateResultDiscarded ? { lateResultDiscarded: true } : {}),
      errorCode: normalizeErrorCode("protocol_violation"),
    };
  }

  function normalizeBridgeOutcome(value: unknown): BrowserCommandOutcome | undefined {
    if (!isNormalizedOutcome(value)) return undefined;
    return value;
  }

  function isNormalizedOutcome(value: unknown): value is BrowserCommandOutcome {
    return value === "completed"
      || value === "prevented"
      || value === "outcome_unknown"
      || value === "not_started";
  }

  function makeMetadata(sessionEpoch: number, sequence: number, outcome: string, retrySafe: boolean, lateResultDiscarded = false) {
    return { sessionEpoch, sequence, outcome, retrySafe, ...(lateResultDiscarded ? { lateResultDiscarded } : {}) };
  }

  function parseDispatchOptions(timeoutOrOptions?: number | { timeoutMs?: number; idempotencyKey?: string }): DispatchOptions {
    if (typeof timeoutOrOptions === "number") {
      return { timeoutMs: Number.isFinite(timeoutOrOptions) ? Math.max(100, Math.min(timeoutOrOptions, limits.maxCommandTimeoutMs)) : 60_000 };
    }
    const timeoutMs = typeof timeoutOrOptions?.timeoutMs === "number"
      ? Math.max(100, Math.min(timeoutOrOptions.timeoutMs, limits.maxCommandTimeoutMs))
      : 60_000;
    return { timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : 60_000, idempotencyKey: timeoutOrOptions?.idempotencyKey };
  }

  function computeActionHash(sessionId: string, action: unknown): string {
    const hashInput = stableJson({ sessionId, action });
    return createHash("sha256").update(hashInput).digest("hex");
  }

  function stableJson(value: unknown): string {
    if (value === null || value === undefined) return "null";
    if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
    if (typeof value === "object") {
      const object = value as Record<string, unknown>;
      const keys = Object.keys(object).sort();
      return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
    }
    return JSON.stringify(value);
  }

  function commandBytes(command: BridgeCommand): number {
    return Buffer.byteLength(JSON.stringify(command), "utf8");
  }

  function cloneResult(event: BridgeResultEvent): BridgeResultEvent {
    return JSON.parse(JSON.stringify(event));
  }

  function normalizePositiveInteger(value: unknown): number {
    const parsed = typeof value === "number" ? value : Number.NaN;
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : Number.NaN;
  }

  function normalizeErrorCode(value: unknown): string {
    const raw = typeof value === "string" ? value.slice(0, 128) : "";
    if (!ERROR_CODE_PATTERN.test(raw)) return "command_failed";
    return raw;
  }

  function normalizeDecision(value: unknown): BrowserFloorDecision | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const input = value as Record<string, unknown>;
    const riskClass = typeof input.class === "string" && NORMALIZED_CLASS_VALUES.has(input.class) ? input.class : null;
    const permissionRequired = typeof input.permissionRequired === "string"
      && ["newton_browser.observe", "newton_browser.act", "newton_browser.agentic_session"].includes(input.permissionRequired)
      ? input.permissionRequired
      : null;
    if (!riskClass || !permissionRequired || typeof input.approvalRequired !== "boolean" || typeof input.blocked !== "boolean") return undefined;
    const parsedReasons = Array.isArray(input.reasons)
      ? input.reasons
        .filter((reason): reason is string => typeof reason === "string")
        .map((reason) => reason.slice(0, DECISION_STRING_BOUND))
        .filter((reason) => reason.length > 0)
        .slice(0, REASON_BOUND)
      : [];
    const commitBoundary = typeof input.commitBoundary === "string" && NORMALIZED_COMMIT_BOUNDARIES.has(input.commitBoundary)
      ? input.commitBoundary
      : null;
    return {
      class: riskClass as BrowserFloorDecision["class"],
      permissionRequired: permissionRequired as BrowserFloorDecision["permissionRequired"],
      approvalRequired: input.approvalRequired,
      blocked: input.blocked,
      reasons: parsedReasons,
      ...(commitBoundary ? { commitBoundary: commitBoundary as BrowserFloorDecision["commitBoundary"] } : {}),
    };
  }

  function toBoundedString(value: unknown, cap = 128): string {
    try {
      if (value === null || value === undefined) return "";
      const type = typeof value;
      if (type !== "string" && type !== "number" && type !== "boolean" && type !== "bigint") return "";
      const text = String(value);
      if (text.length === 0) return "";
      return text.slice(0, cap);
    } catch {
      return "";
    }
  }

  function normalizeAndValidateIdempotencyKey(value: unknown): string | null {
    try {
      return validateIdempotencyKey(value);
    } catch {
      return null;
    }
  }

  function removeClient(client: HostClient): void {
    if (!clients.delete(client.id)) return;
    if (client.authTimer) clearTimeout(client.authTimer);
    let hadOwnership = false;
    for (const [sessionId, state] of sessionStates) {
      if (state.ownerId !== client.id) continue;
      unregisterFromOwner(sessionId);
      hadOwnership = true;
    }
    if (hadOwnership) broadcastSessionsChanged();
    const commands = [...pendingByCommandId.entries()].filter(([, command]) => command.targetClientId === client.id);
    for (const [, command] of commands) {
      if (command.timer) clearTimeout(command.timer);
      const timedOut = makeFailureResult(command, STALE_OUTCOME, "owner_disconnected");
      completePendingCommand(command, timedOut);
    }
  }

  function broadcast(message: unknown, filter: (client: HostClient) => boolean = () => true): void {
    for (const client of authenticatedClients()) if (filter(client)) send(client, message);
  }

  function broadcastSessionsChanged(): void {
    broadcast({ type: "sessions_changed", hostInstanceId, sessions: api.listSessions() });
    persistObserverState();
  }

  function observerSnapshot() {
    return {
      ok: true,
      hostInstanceId,
      port: boundPort,
      processId: process.pid,
      updatedAt: new Date().toISOString(),
      sessions: api.listSessions().map((session) => ({
        sessionId: session.sessionId,
        instanceLabel: session.instanceLabel ?? "",
        origin: session.origin,
        liveOrigin: session.liveOrigin ?? null,
        attached: session.attached === true,
        incognito: session.incognito === true,
      })),
    };
  }

  function validObserverRequest(header: unknown): boolean {
    if (!observerToken || typeof header !== "string" || !header.startsWith("Bearer ")) return false;
    const actual = Buffer.from(header.slice(7));
    const expected = Buffer.from(observerToken);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  function persistObserverState(): void {
    if (!observerRegistryDirectory || !observerToken || boundPort === null) return;
    fs.mkdirSync(observerRegistryDirectory, { recursive: true, mode: 0o700 });
    const target = path.join(observerRegistryDirectory, `${hostInstanceId}.json`);
    const temporary = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(observerSnapshot())}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, target);
  }

  function removeObserverState(): void {
    if (!observerRegistryDirectory) return;
    fs.rmSync(path.join(observerRegistryDirectory, `${hostInstanceId}.json`), { force: true });
  }

  function send(client: HostClient, message: unknown): boolean {
    if (client.socket.readyState !== WebSocket.OPEN) return false;
    const text = JSON.stringify(message);
    if (Buffer.byteLength(text, "utf8") > limits.maxMessageBytes) return false;
    try {
      client.socket.send(text);
      return true;
    } catch {
      return false;
    }
  }

  function validProof(nonce: string, proof: unknown): boolean {
    if (typeof proof !== "string") return false;
    const expected = createHmac("sha256", pairingSecret)
      .update(`newton-browser-auth-v1:${hostInstanceId}:${nonce}`)
      .digest();
    let actual: Buffer;
    try {
      actual = Buffer.from(proof, "base64url");
    } catch {
      return false;
    }
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  async function readObserverBody(request: http.IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > 8 * 1024) throw new Error("observer_body_too_large");
      chunks.push(buffer);
    }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("observer_body_invalid");
    return value as Record<string, unknown>;
  }

  function readySession(sessionId: string): BridgeSessionInfo | null {
    const session = sessions.get(sessionId);
    return ownerClient(sessionId) && session?.attached && Number.isInteger(session.ownedTabId) && typeof session.liveOrigin === "string" ? { ...session } : null;
  }

  function notifyReadiness(sessionId: string): void {
    for (const callback of queuedWaiters.get(sessionId) ?? []) callback();
  }

  function removeReadinessWaiter(sessionId: string, callback: () => void): void {
    const waiters = queuedWaiters.get(sessionId);
    waiters?.delete(callback);
    if (waiters?.size === 0) queuedWaiters.delete(sessionId);
  }

  function broadcastReadiness(sessionId: string): void {
    const waiters = queuedWaiters.get(sessionId);
    if (!waiters) return;
    for (const callback of [...waiters]) {
      callback();
      waiters.delete(callback);
    }
    queuedWaiters.delete(sessionId);
  }

  function claimedSessionCounts(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const [sessionId, state] of sessionStates) {
      const ownerId = state.ownerId;
      const family = clients.get(ownerId ?? "")?.identity?.browserFamily ?? "unknown";
      counts[family] = (counts[family] ?? 0) + 1;
    }
    return counts;
  }

  function errorCode(error: unknown): string {
    return String((error as Error)?.message ?? error ?? "host_error").replace(/[^a-z0-9_]+/gi, "_").toLowerCase();
  }
}

function isAllowedWebSocketOrigin(origin: string | undefined): boolean {
  return typeof origin === "string" && (origin.startsWith("chrome-extension://") || origin.startsWith("edge-extension://"));
}

function range(first: number, last: number): number[] {
  return Array.from({ length: last - first + 1 }, (_, index) => first + index);
}
