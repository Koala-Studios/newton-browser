import { DEFAULT_HOST_URLS } from "./config.js";

export function createLocalPanelTransport({
  notify,
  onHostSessionsChanged,
  hostUrls = DEFAULT_HOST_URLS,
  healthCheck = defaultHealthCheck,
  getPairingSecret = async () => null,
  getClientIdentity = async () => ({ clientId: "newton_browser_extension", browserFamily: "chromium" }),
  getExtensionVersion = () => globalThis.chrome?.runtime?.getManifest?.().version ?? null,
  signChallenge = defaultSignChallenge,
  hostCleanupDelayMs = 15_000,
} = {}) {
  const hosts = new Map();
  const subscribers = new Map();
  const sessionHosts = new Map();
  const commandHosts = new Map();
  let globalStopInFlight = false;

  return {
    async connectHost() {
      await Promise.all(hostUrls.map((url) => ensureHost(url)));
      return { connected: readyHosts().length > 0, hostCount: readyHosts().length, pairingRequired: pairingRequired() };
    },

    isHostConnected() {
      return readyHosts().length > 0;
    },

    connectedHostCount() {
      return readyHosts().length;
    },

    connectedHostVersion() {
      return readyHosts().map((host) => host.version).find((version) => typeof version === "string") ?? null;
    },

    pairingRequired,

    async createSession(init) {
      const host = await firstReadyHost();
      if (!host) throw new Error(pairingRequired() ? "pairing_required" : "host_unavailable");
      const result = await hostRequest(host, "createSession", init);
      if (result?.sessionId) sessionHosts.set(result.sessionId, host.id);
      return result;
    },

    async attachTab(sessionId, tab) {
      return requestForSession(sessionId, "attachTab", { sessionId, tab });
    },

    subscribe(sessionId, onCommand) {
      subscribers.set(sessionId, onCommand);
      void requestForSession(sessionId, "subscribeSession", { sessionId }).catch(() => {});
      return () => {
        if (subscribers.get(sessionId) !== onCommand) return;
        subscribers.delete(sessionId);
        void requestForSession(sessionId, "unsubscribeSession", { sessionId }).catch(() => {});
      };
    },

    async listSessions() {
      await Promise.all(hostUrls.map((url) => ensureHost(url)));
      const lists = await Promise.all(readyHosts().map(async (host) => {
        const sessions = await hostRequest(host, "listSessions", {}).catch(() => []);
        return Array.isArray(sessions) ? sessions.map((session) => {
          sessionHosts.set(session.sessionId, host.id);
          return { ...session, hostInstanceId: host.hostInstanceId };
        }) : [];
      }));
      return lists.flat();
    },

    async postEvent(commandId, eventType, detail) {
      const host = hostForCommand(commandId);
      if (host) await hostRequest(host, "postEvent", { commandId, eventType, detail }).catch(() => {});
      await emit({ type: "command_event", commandId, eventType, detail });
    },

    async postResult(event) {
      const host = hostForCommand(event.commandId);
      if (host) await hostRequest(host, "postResult", { event }).catch(() => {});
      commandHosts.delete(event.commandId);
      await emit({ type: "command_result", event });
    },

    async stopSession(sessionId) {
      await requestForSession(sessionId, "stopSession", { sessionId }).catch(() => {});
      subscribers.delete(sessionId);
      sessionHosts.delete(sessionId);
    },

    async stopAll() {
      await Promise.all(readyHosts().map((host) => hostRequest(host, "stopAll", {}).catch(() => {})));
      subscribers.clear();
      sessionHosts.clear();
      commandHosts.clear();
    },
  };

  async function emit(event) {
    if (typeof notify === "function") await Promise.resolve(notify(event)).catch(() => {});
  }

  async function firstReadyHost() {
    if (readyHosts().length === 0) await Promise.all(hostUrls.map((url) => ensureHost(url)));
    return readyHosts()[0] ?? null;
  }

  async function ensureHost(url) {
    const existing = hosts.get(url);
    if (existing?.ready) return existing;
    if (existing?.connecting) return existing.connecting;
    const host = existing ?? createHostRecord(url);
    hosts.set(url, host);
    host.connecting = connect(host).finally(() => { host.connecting = null; });
    return host.connecting;
  }

  async function connect(host) {
    if (!(await healthCheck(host.url).catch(() => false))) return host;
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => finish(), 3000);
      try {
        host.socket = new WebSocket(host.url);
        host.socket.addEventListener("message", (event) => { void handleHostMessage(host, event.data).catch(() => resetHost(host)); });
        host.socket.addEventListener("close", () => resetHost(host));
        host.socket.addEventListener("error", () => finish());
      } catch {
        finish();
      }

      function finish() {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(host);
      }
      host.finishConnect = finish;
    });
  }

  async function handleHostMessage(host, raw) {
    let message;
    try {
      message = JSON.parse(String(raw));
    } catch {
      throw new Error("invalid_host_message");
    }
    if (message?.type === "auth_challenge") {
      const secret = await getPairingSecret();
      if (!secret) {
        host.pairingRequired = true;
        host.finishConnect?.();
        host.socket?.close();
        return;
      }
      host.socket.send(JSON.stringify({
        type: "auth_response",
        hostInstanceId: message.hostInstanceId,
        proof: await signChallenge(secret, message.hostInstanceId, message.nonce),
      }));
      return;
    }
    if (message?.type === "ready") {
      const identity = normalizeClientIdentity(await getClientIdentity());
      const version = getExtensionVersion();
      host.socket?.send(JSON.stringify({ type: "client_hello", ...identity, ...(typeof version === "string" ? { version } : {}) }));
      host.ready = true;
      host.browserTarget = ["chrome", "edge"].includes(message.browserTarget) ? message.browserTarget : "auto";
      host.eligible = host.browserTarget === "auto" || host.browserTarget === identity.browserFamily;
      host.pairingRequired = false;
      host.hostInstanceId = message.hostInstanceId;
      host.version = typeof message.version === "string" ? message.version : null;
      if (host.eligible) {
        indexSessions(host, message.sessions);
        syncHostSubscriptions(host);
      }
      host.finishConnect?.();
      if (typeof onHostSessionsChanged === "function") void Promise.resolve(onHostSessionsChanged()).catch(() => {});
      return;
    }
    if (!host.ready || !host.eligible) return;
    if (message?.type === "stop_all") {
      if (globalStopInFlight) return;
      globalStopInFlight = true;
      await Promise.all(readyHosts().map((candidate) => hostRequest(candidate, "stopAll", {}).catch(() => {})));
      globalStopInFlight = false;
      return;
    }
    if (message?.type === "bridge_response") {
      const waiting = host.requests.get(message.requestId);
      if (!waiting) return;
      clearTimeout(waiting.timer);
      host.requests.delete(message.requestId);
      if (message.ok === false) waiting.reject(new Error(message.error ?? "host_error"));
      else waiting.resolve(message.result);
      return;
    }
    if (message?.type === "sessions_changed") {
      indexSessions(host, message.sessions);
      if (typeof onHostSessionsChanged === "function") void Promise.resolve(onHostSessionsChanged()).catch(() => {});
      return;
    }
    if (message?.type === "bridge_command" && message.command) {
      commandHosts.set(message.command.commandId, host.id);
      const handler = subscribers.get(message.command.sessionId);
      if (handler) await Promise.resolve(handler(message.command)).catch(() => {});
    }
  }

  function hostRequest(host, method, params) {
    if (!host.ready || !host.socket) return Promise.reject(new Error("extension_disconnected"));
    const requestId = `req_${Date.now().toString(36)}_${host.counter++}`;
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        host.requests.delete(requestId);
        reject(new Error("host_timeout"));
      }, 10_000);
      host.requests.set(requestId, { resolve, reject, timer });
    });
    host.socket.send(JSON.stringify({ type: "bridge_request", requestId, method, params }));
    return result;
  }

  async function requestForSession(sessionId, method, params) {
    const host = hostById(sessionHosts.get(sessionId));
    if (!host) throw new Error("unknown_session");
    return hostRequest(host, method, params);
  }

  function hostForCommand(commandId) {
    return hostById(commandHosts.get(commandId));
  }

  function hostById(id) {
    return [...hosts.values()].find((host) => host.id === id) ?? null;
  }

  function readyHosts() {
    return [...hosts.values()].filter((host) => host.ready && host.eligible);
  }

  function pairingRequired() {
    return [...hosts.values()].some((host) => host.pairingRequired);
  }

  function indexSessions(host, sessions) {
    const live = new Set();
    for (const session of Array.isArray(sessions) ? sessions : []) {
      if (!session?.sessionId) continue;
      live.add(session.sessionId);
      sessionHosts.set(session.sessionId, host.id);
    }
    for (const [sessionId, hostId] of sessionHosts) {
      if (hostId === host.id && !live.has(sessionId)) sessionHosts.delete(sessionId);
    }
  }

  function syncHostSubscriptions(host) {
    for (const sessionId of subscribers.keys()) {
      if (sessionHosts.get(sessionId) === host.id) void hostRequest(host, "subscribeSession", { sessionId }).catch(() => {});
    }
  }

  function resetHost(host) {
    host.ready = false;
    host.eligible = false;
    host.socket = null;
    host.finishConnect?.();
    for (const [requestId, waiting] of host.requests) {
      clearTimeout(waiting.timer);
      waiting.reject(new Error("extension_disconnected"));
      host.requests.delete(requestId);
    }
    setTimeout(() => {
      if (!host.ready && typeof onHostSessionsChanged === "function") {
        void Promise.resolve(onHostSessionsChanged()).catch(() => {});
      }
    }, hostCleanupDelayMs);
  }
}

function createHostRecord(url) {
  return {
    id: `host_${url}`,
    url,
    socket: null,
    ready: false,
    eligible: false,
    browserTarget: "auto",
    pairingRequired: false,
    hostInstanceId: null,
    version: null,
    requests: new Map(),
    counter: 0,
    connecting: null,
    finishConnect: null,
  };
}

function normalizeClientIdentity(value) {
  const clientId = String(value?.clientId ?? "");
  const browserFamily = String(value?.browserFamily ?? "");
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(clientId) || !["chrome", "edge", "chromium"].includes(browserFamily)) {
    throw new Error("invalid_client_identity");
  }
  return { clientId, browserFamily };
}

async function defaultHealthCheck(hostUrl) {
  if (typeof fetch !== "function") return true;
  const healthUrl = new URL(hostUrl);
  healthUrl.protocol = "http:";
  healthUrl.pathname = "/health";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 250);
  try {
    const response = await fetch(healthUrl.href, { cache: "no-store", method: "GET", signal: controller.signal });
    return response.status === 204;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function defaultSignChallenge(secret, hostInstanceId, nonce) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(`newton-browser-auth-v1:${hostInstanceId}:${nonce}`)));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
