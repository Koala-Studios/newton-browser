import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import http from "node:http";

import type { BridgeCommand, BridgeResultEvent, BridgeSessionInfo, BridgeSessionInit } from "@browser-bridge/core";
import { WebSocket, WebSocketServer } from "ws";

import { loadOrCreatePairingConfig } from "./config.ts";

const DEFAULT_LIMITS = {
  firstPort: 17321,
  lastPort: 17340,
  maxQueuedPerSession: 32,
  maxPending: 128,
  maxSessions: 32,
  maxMessageBytes: 24 * 1024 * 1024,
  maxResultBytes: 16 * 1024 * 1024,
  maxCommandTimeoutMs: 120_000,
  authTimeoutMs: 3_000,
  readinessTimeoutMs: 40_000,
  orphanSessionTtlMs: 30 * 60_000,
};

type HostClient = {
  id: string;
  socket: WebSocket;
  authenticated: boolean;
  nonce: string;
  authTimer: NodeJS.Timeout;
  subscriptions: Set<string>;
};

type PendingCommand = {
  sessionId: string;
  resolve: (event: BridgeResultEvent) => void;
  timer: NodeJS.Timeout;
};

export type BrowserBridgeHost = ReturnType<typeof createBrowserBridgeHost>;

export function createBrowserBridgeHost(options: {
  pairingSecret?: string;
  hostInstanceId?: string;
  limits?: Partial<typeof DEFAULT_LIMITS>;
} = {}) {
  const limits = { ...DEFAULT_LIMITS, ...(options.limits ?? {}) };
  const pairingSecret = options.pairingSecret ?? loadOrCreatePairingConfig().secret;
  const hostInstanceId = options.hostInstanceId ?? randomUUID();
  const sessions = new Map<string, BridgeSessionInfo>();
  const clients = new Map<string, HostClient>();
  const pending = new Map<string, PendingCommand>();
  const queuedCommands = new Map<string, BridgeCommand[]>();
  const readinessWaiters = new Map<string, Set<() => void>>();
  const sessionActivity = new Map<string, number>();
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
      });
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
        port: boundPort,
        extensionConnected: authenticatedClients().length > 0,
        authenticatedClientCount: authenticatedClients().length,
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

    async waitForSessionReady(sessionId: string, timeoutMs = limits.readinessTimeoutMs): Promise<BridgeSessionInfo> {
      const ready = readySession(sessionId);
      if (ready) return ready;
      if (!sessions.has(sessionId)) throw new Error("unknown_session");
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
          const error = authenticatedClients().length === 0 ? "extension_disconnected" : "session_setup_timeout";
          api.stopSession(sessionId);
          reject(new Error(error));
        }, Math.max(50, Math.min(timeoutMs, limits.maxCommandTimeoutMs)));
        const waiters = readinessWaiters.get(sessionId) ?? new Set();
        waiters.add(finish);
        readinessWaiters.set(sessionId, waiters);
      });
    },

    stopSession(sessionId: string): void {
      sessions.delete(sessionId);
      sessionActivity.delete(sessionId);
      queuedCommands.delete(sessionId);
      for (const client of clients.values()) client.subscriptions.delete(sessionId);
      for (const [commandId, waiter] of pending) {
        if (waiter.sessionId !== sessionId) continue;
        clearTimeout(waiter.timer);
        pending.delete(commandId);
        waiter.resolve({ commandId, ok: false, errorCode: "session_stopped" });
      }
      notifyReadiness(sessionId);
      broadcastSessionsChanged();
    },

    stopAll(): void {
      for (const sessionId of [...sessions.keys()]) api.stopSession(sessionId);
      broadcast({ type: "stop_all", hostInstanceId });
    },

    async dispatch(sessionId: string, action: BridgeCommand["action"], timeoutMs = 60_000): Promise<BridgeResultEvent> {
      if (!sessions.has(sessionId)) return { commandId: "", ok: false, errorCode: "unknown_session" };
      sessionActivity.set(sessionId, Date.now());
      if (authenticatedClients().length === 0) return { commandId: "", ok: false, errorCode: "extension_disconnected" };
      if (pending.size >= limits.maxPending) return { commandId: "", ok: false, errorCode: "queue_full" };
      const queued = queuedCommands.get(sessionId) ?? [];
      if (!hasSubscriber(sessionId) && queued.length >= limits.maxQueuedPerSession) {
        return { commandId: "", ok: false, errorCode: "queue_full" };
      }
      const commandId = `bbc_${Date.now().toString(36)}_${randomUUID().slice(0, 12)}`;
      const result = new Promise<BridgeResultEvent>((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(commandId);
          resolve({ commandId, ok: false, errorCode: "command_timeout" });
        }, Math.max(100, Math.min(timeoutMs, limits.maxCommandTimeoutMs)));
        pending.set(commandId, { sessionId, resolve, timer });
      });
      const command: BridgeCommand = { commandId, sessionId, actionKind: action.kind, action };
      if (hasSubscriber(sessionId)) broadcast({ type: "bridge_command", command }, (client) => client.subscriptions.has(sessionId));
      else queueCommand(command);
      return result;
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
      for (const client of clients.values()) {
        clearTimeout(client.authTimer);
        client.socket.close(1001, "host closing");
      }
      clients.clear();
      for (const [commandId, waiter] of pending) {
        clearTimeout(waiter.timer);
        waiter.resolve({ commandId, ok: false, errorCode: "session_stopped" });
      }
      pending.clear();
      await new Promise<void>((resolve) => webSockets?.close(() => resolve()) ?? resolve());
      webSockets = null;
      if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
      server = null;
      boundPort = null;
    },
  };

  return api;

  async function startHttpServer(port: number, host: string) {
    const candidateServer = http.createServer((request, response) => {
      if (request.url === "/health") {
        response.writeHead(204, { "Cache-Control": "no-store" }).end();
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
    const nonce = randomBytes(24).toString("base64url");
    const client = {
      id: randomUUID(),
      socket,
      authenticated: false,
      nonce,
      authTimer: setTimeout(() => socket.close(4001, "pairing required"), limits.authTimeoutMs),
      subscriptions: new Set<string>(),
    } satisfies HostClient;
    clients.set(client.id, client);
    socket.on("message", (data, isBinary) => {
      if (isBinary) return socket.close(1003, "text frames only");
      handleClientMessage(client, data.toString()).catch(() => socket.close(1011, "bridge error"));
    });
    socket.on("close", () => removeClient(client));
    socket.on("error", () => removeClient(client));
    send(client, { type: "auth_challenge", protocol: "browser-bridge-auth-v1", hostInstanceId, nonce });
  }

  async function handleClientMessage(client: HostClient, text: string): Promise<void> {
    if (Buffer.byteLength(text, "utf8") > limits.maxMessageBytes) return client.socket.close(1009, "message too large");
    let message: any;
    try {
      message = JSON.parse(text);
    } catch {
      return client.socket.close(1007, "invalid json");
    }
    if (!client.authenticated) {
      if (message?.type !== "auth_response" || message.hostInstanceId !== hostInstanceId || !validProof(client.nonce, message.proof)) {
        return client.socket.close(4003, "authentication failed");
      }
      client.authenticated = true;
      clearTimeout(client.authTimer);
      send(client, { type: "ready", hostInstanceId, sessions: api.listSessions() });
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
    if (message.method === "createSession") return api.createSession(params);
    if (message.method === "attachTab") return attachTab(params);
    if (message.method === "listSessions") return api.listSessions();
    if (message.method === "subscribeSession") return subscribeSession(client, params.sessionId);
    if (message.method === "unsubscribeSession") return client.subscriptions.delete(String(params.sessionId ?? ""));
    if (message.method === "postEvent") return {};
    if (message.method === "postResult") return postBridgeResult(params.event);
    if (message.method === "stopSession") return api.stopSession(String(params.sessionId ?? ""));
    if (message.method === "stopAll") return api.stopAll();
    throw new Error("unknown_bridge_method");
  }

  function attachTab(params: any): void {
    const sessionId = String(params.sessionId ?? "");
    const session = sessions.get(sessionId);
    if (!session) throw new Error("unknown_session");
    session.ownedTabId = Number.isInteger(params.tab?.ownedTabId) ? params.tab.ownedTabId : session.ownedTabId ?? null;
    session.tabGroupId = Number.isInteger(params.tab?.tabGroupId) ? params.tab.tabGroupId : session.tabGroupId ?? null;
    session.attached = params.tab?.attached === true;
    session.liveOrigin = typeof params.tab?.liveOrigin === "string" ? params.tab.liveOrigin : session.liveOrigin ?? null;
    notifyReadiness(sessionId);
    broadcastSessionsChanged();
  }

  function postBridgeResult(event: BridgeResultEvent): void {
    const commandId = String(event?.commandId ?? "");
    const waiting = pending.get(commandId);
    if (!waiting) return;
    clearTimeout(waiting.timer);
    pending.delete(commandId);
    if (Buffer.byteLength(JSON.stringify(event), "utf8") > limits.maxMessageBytes) {
      waiting.resolve({ commandId, ok: false, errorCode: "result_too_large" });
      return;
    }
    if (Buffer.byteLength(JSON.stringify(event), "utf8") > limits.maxResultBytes) {
      waiting.resolve({ commandId, ok: false, errorCode: "result_too_large" });
      return;
    }
    sessionActivity.set(waiting.sessionId, Date.now());
    waiting.resolve(event);
  }

  function subscribeSession(client: HostClient, sessionId: unknown): void {
    const normalized = String(sessionId ?? "");
    if (!sessions.has(normalized)) throw new Error("unknown_session");
    client.subscriptions.add(normalized);
    flushQueuedCommands(client, normalized);
  }

  function queueCommand(command: BridgeCommand): void {
    const queued = queuedCommands.get(command.sessionId) ?? [];
    queued.push(command);
    queuedCommands.set(command.sessionId, queued);
  }

  function flushQueuedCommands(client: HostClient, sessionId: string): void {
    const queued = queuedCommands.get(sessionId);
    if (!queued?.length) return;
    queuedCommands.delete(sessionId);
    for (const command of queued) send(client, { type: "bridge_command", command });
  }

  function hasSubscriber(sessionId: string): boolean {
    return authenticatedClients().some((client) => client.subscriptions.has(sessionId));
  }

  function authenticatedClients(): HostClient[] {
    return [...clients.values()].filter((client) => client.authenticated && client.socket.readyState === WebSocket.OPEN);
  }

  function removeClient(client: HostClient): void {
    if (!clients.delete(client.id)) return;
    clearTimeout(client.authTimer);
    if (authenticatedClients().length === 0) {
      for (const [commandId, waiter] of pending) {
        clearTimeout(waiter.timer);
        pending.delete(commandId);
        waiter.resolve({ commandId, ok: false, errorCode: "extension_disconnected" });
      }
    }
  }

  function broadcast(message: unknown, filter: (client: HostClient) => boolean = () => true): void {
    for (const client of authenticatedClients()) if (filter(client)) send(client, message);
  }

  function broadcastSessionsChanged(): void {
    broadcast({ type: "sessions_changed", hostInstanceId, sessions: api.listSessions() });
  }

  function send(client: HostClient, message: unknown): void {
    if (client.socket.readyState !== WebSocket.OPEN) return;
    const text = JSON.stringify(message);
    if (Buffer.byteLength(text, "utf8") > limits.maxMessageBytes) return client.socket.close(1009, "message too large");
    client.socket.send(text);
  }

  function validProof(nonce: string, proof: unknown): boolean {
    if (typeof proof !== "string") return false;
    const expected = createHmac("sha256", pairingSecret)
      .update(`browser-bridge-auth-v1:${hostInstanceId}:${nonce}`)
      .digest();
    let actual: Buffer;
    try {
      actual = Buffer.from(proof, "base64url");
    } catch {
      return false;
    }
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  function readySession(sessionId: string): BridgeSessionInfo | null {
    const session = sessions.get(sessionId);
    return session?.attached && Number.isInteger(session.ownedTabId) && typeof session.liveOrigin === "string" ? { ...session } : null;
  }

  function notifyReadiness(sessionId: string): void {
    for (const callback of readinessWaiters.get(sessionId) ?? []) callback();
  }

  function removeReadinessWaiter(sessionId: string, callback: () => void): void {
    const waiters = readinessWaiters.get(sessionId);
    waiters?.delete(callback);
    if (waiters?.size === 0) readinessWaiters.delete(sessionId);
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
