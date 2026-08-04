// @ts-check

const MUTATING_KINDS = new Set(["click", "press", "fill", "type", "select", "clear"]);

const DEFAULT_GROUP_THEMES = [
  { color: "blue", accent: "31, 111, 235" },
  { color: "purple", accent: "137, 87, 229" },
  { color: "green", accent: "35, 134, 54" },
  { color: "orange", accent: "219, 109, 40" },
  { color: "pink", accent: "207, 34, 126" },
];

class SessionController {
  constructor({ sessionId, tabId, origin, allowedOrigins, tabMode, ownsTab, tabGroupId, accent, driver }) {
    this.sessionId = sessionId;
    this.tabId = tabId ?? null;
    this.origin = origin ?? null;
    this.allowedOrigins = dedupeOrigins(allowedOrigins, origin);
    this.tabMode = tabMode ?? "owned_group";
    this.ownsTab = Boolean(ownsTab);
    this.tabGroupId = tabGroupId ?? null;
    this.driver = driver;
    this.driver.accent = accent ?? null;
    this.driver.ownsTab = Boolean(ownsTab);
    // Give the driver the origin grant so a network-body fetch (WS9.3) can refuse a
    // cross-origin request's body.
    this.driver.allowedOrigins = this.allowedOrigins;
    this.streaming = false;
    this.unsubscribe = null;
    this.reattaching = false;
  }

  snapshot() {
    return {
      sessionId: this.sessionId,
      tabId: this.tabId,
      tabGroupId: this.tabGroupId,
      origin: this.origin,
      tabMode: this.tabMode,
      ownsTab: this.ownsTab,
      streaming: this.streaming,
      attached: this.driver.attached,
    };
  }
}

export function createBridgeRuntime({ transport, evaluateFloor, tabs, driverFactory, notify, themes = DEFAULT_GROUP_THEMES } = {}) {
  if (!transport) throw new Error("bridge transport is required");
  if (typeof evaluateFloor !== "function") throw new Error("bridge floor evaluator is required");
  if (!tabs) throw new Error("bridge tabs port is required");
  if (typeof driverFactory !== "function") throw new Error("bridge driver factory is required");

  const sessions = new Map();
  const bindingSessions = new Set();
  let themeCursor = 0;

  const emit = async (event) => {
    if (typeof notify !== "function") return;
    await Promise.resolve(notify(event)).catch(() => {});
  };

  const bridgeSnapshot = () => {
    const list = [...sessions.values()].map((controller) => controller.snapshot());
    const primary = list[0] ?? { sessionId: null, tabId: null, origin: null, streaming: false, attached: false };
    return { ...primary, sessions: list, count: list.length };
  };

  const notifyState = async () => {
    await emit({ type: "state", state: bridgeSnapshot() });
  };

  const runtime = {
    isActive() {
      return sessions.size > 0;
    },

    snapshot: bridgeSnapshot,

    isDrivingTab(tabId) {
      for (const controller of sessions.values()) {
        if (controller.tabId === tabId && controller.driver.isAttachedTo(tabId)) return true;
      }
      return false;
    },

    async reassertOverlayForTab(tabId) {
      for (const controller of sessions.values()) {
        if (controller.tabId === tabId && controller.driver.isAttachedTo(tabId)) {
          await controller.driver.reassertOverlay().catch(() => {});
        }
      }
    },

    async startSession({ tabId, origin, allowedOrigins, goal, tabMode, instanceLabel } = {}) {
      if (!safeOrigin(origin)) throw new Error("origin_required");
      const mode = tabMode === "current" ? "current" : "owned_group";
      let ownedTabId = mode === "current" ? tabId : null;
      let tabGroupId = null;
      const theme = nextTheme();
      if (mode === "current" && typeof tabId !== "number") {
        throw new Error("A normal web tab is required to drive the current tab.");
      }
      if (mode === "owned_group") {
        const acquired = await tabs.createOwnedTab(origin, theme.color, groupTitle({ goal, instanceLabel, origin }));
        ownedTabId = acquired.tabId;
        tabGroupId = acquired.groupId ?? null;
      }
      try {
        const created = await transport.createSession({
          origin: origin ?? null,
          allowedOrigins: dedupeOrigins(allowedOrigins, origin),
          goal: goal ?? "",
          tabMode: mode,
          ownedTabId: ownedTabId ?? undefined,
          tabGroupId: tabGroupId ?? undefined,
          instanceLabel: instanceLabel ?? "",
        });
        if (!created?.sessionId) throw new Error("session_start_failed");
        const controller = newController({
          sessionId: created.sessionId,
          tabId: ownedTabId,
          origin: origin ?? null,
          allowedOrigins: dedupeOrigins(allowedOrigins, origin),
          tabMode: mode,
          ownsTab: mode === "owned_group",
          tabGroupId,
          accent: mode === "owned_group" ? theme.accent : null,
        });
        sessions.set(controller.sessionId, controller);
        await controller.driver.attach(ownedTabId);
        const liveOrigin = await liveTabOrigin(ownedTabId);
        if (!controller.allowedOrigins.includes(liveOrigin)) throw new Error("origin_not_granted");
        await transport.attachTab(controller.sessionId, { ownedTabId, tabGroupId, attached: true, liveOrigin });
        startSubscription(controller);
        await notifyState();
        return controller.sessionId;
      } catch (error) {
        if (mode === "owned_group" && typeof ownedTabId === "number") await tabs.removeTab(ownedTabId).catch(() => {});
        throw error;
      }
    },

    async ensureForActiveSessions(activeTabId, restoredBindings = []) {
      const list = await transport.listSessions().catch(() => null);
      if (!Array.isArray(list)) return;
      const restored = new Map((Array.isArray(restoredBindings) ? restoredBindings : []).flatMap((binding) =>
        binding?.sessionId && Number.isInteger(binding?.tabId) ? [[binding.sessionId, binding]] : [],
      ));
      for (const session of list) {
        if (!session?.sessionId) continue;
        if (sessions.has(session.sessionId)) {
          const existing = sessions.get(session.sessionId);
          if (existing && !existing.streaming) startSubscription(existing);
          continue;
        }
        if (bindingSessions.has(session.sessionId)) continue;
        bindingSessions.add(session.sessionId);
        const prior = restored.get(session.sessionId);
        const bindable = prior && !Number.isInteger(session.ownedTabId)
          ? { ...session, ownedTabId: prior.tabId, tabGroupId: Number.isInteger(prior.tabGroupId) ? prior.tabGroupId : null }
          : session;
        await bindExternalSession(bindable, activeTabId).catch(() => {}).finally(() => {
          bindingSessions.delete(session.sessionId);
        });
      }
    },

    async stop(sessionId) {
      const controller = sessionId ? sessions.get(sessionId) : firstController();
      if (!controller) return { stopped: false };
      sessions.delete(controller.sessionId);
      stopSubscription(controller);
      await controller.driver.detach().catch(() => {});
      if (controller.ownsTab && typeof controller.tabId === "number") {
        await tabs.removeTab(controller.tabId).catch(() => {});
      }
      await transport.stopSession(controller.sessionId).catch(() => {});
      await notifyState();
      return { stopped: true };
    },

    async stopAll() {
      const ids = [...sessions.keys()];
      for (const id of ids) await runtime.stop(id).catch(() => {});
      await transport.stopAll().catch(() => {});
      await notifyState();
      return { stopped: ids.length };
    },

    async renewLeases() {
      if (sessions.size === 0) return;
      const list = await transport.listSessions().catch(() => null);
      if (!Array.isArray(list)) return;
      const liveIds = new Set(list.map((session) => session.sessionId));
      for (const controller of [...sessions.values()]) {
        if (!liveIds.has(controller.sessionId)) {
          await runtime.stop(controller.sessionId).catch(() => {});
        } else if (!controller.streaming) {
          startSubscription(controller);
        }
      }
    },

    async handleDebuggerEvent(source, method, params) {
      const controller = controllerForTab(source?.tabId);
      if (!controller) return;
      controller.driver.recordDebuggerEvent?.(method, params);
      if (method === "Page.javascriptDialogOpening") {
        await emit({ type: "dialog", message: params?.message ?? "", dialogType: params?.type ?? "alert" });
      }
      if (method === "Target.targetCreated" && params?.targetInfo?.type === "page") {
        await emit({ type: "new_target", url: params.targetInfo.url ?? "" });
      }
      if (method === "Page.frameNavigated" && params?.frame && !params.frame.parentId) {
        await controller.driver.reassertOverlay().catch(() => {});
      }
    },

    async handleDebuggerDetach(source, reason) {
      const controller = controllerForTab(source?.tabId);
      if (!controller) return;
      controller.driver.markDetached();
      if (reason === "canceled_by_user") {
        await runtime.stop(controller.sessionId).catch(() => {});
        return;
      }
      if (controller.reattaching) return;
      controller.reattaching = true;
      try {
        const tabId = controller.tabId;
        for (let attempt = 0; attempt < 3 && sessions.has(controller.sessionId) && controller.tabId === tabId; attempt += 1) {
          const tab = await tabs.getTab(tabId).catch(() => null);
          if (!tab) {
            await runtime.stop(controller.sessionId).catch(() => {});
            return;
          }
          await delay(250 * (attempt + 1));
          try {
            await controller.driver.attach(tabId);
            if (!controller.streaming) startSubscription(controller);
            await notifyState();
            return;
          } catch {
            // The target may still be swapping under us.
          }
        }
        if (sessions.has(controller.sessionId) && controller.tabId === tabId && !controller.driver.attached) {
          await runtime.stop(controller.sessionId).catch(() => {});
        }
      } finally {
        controller.reattaching = false;
      }
    },

    async handleTabRemoved(tabId) {
      const controller = controllerForTab(tabId);
      if (controller) await runtime.stop(controller.sessionId).catch(() => {});
    },
  };

  tabs.onDebuggerEvent?.((source, method, params) => {
    void runtime.handleDebuggerEvent(source, method, params).catch(() => {});
  });
  tabs.onDebuggerDetach?.((source, reason) => {
    void runtime.handleDebuggerDetach(source, reason).catch(() => {});
  });
  tabs.onTabRemoved?.((tabId) => {
    void runtime.handleTabRemoved(tabId).catch(() => {});
  });

  function nextTheme() {
    const theme = themes[themeCursor % themes.length] ?? DEFAULT_GROUP_THEMES[0];
    themeCursor += 1;
    return theme;
  }

  function newController(input) {
    return new SessionController({ ...input, driver: driverFactory() });
  }

  async function bindExternalSession(session, activeTabId) {
    const mode = session.tabMode === "current" ? "current" : "owned_group";
    const theme = nextTheme();
    let tabId = Number.isInteger(session.ownedTabId) ? session.ownedTabId : null;
    let tabGroupId = Number.isInteger(session.tabGroupId) ? session.tabGroupId : null;
    const origin = session.origin ?? null;
    if (tabId !== null && !(await tabs.getTab(tabId).catch(() => null))) {
      tabId = null;
      tabGroupId = null;
    }
    if (tabId === null) {
      if (mode === "current") {
        if (typeof activeTabId !== "number") return;
        tabId = activeTabId;
      } else {
        const acquired = await tabs.createOwnedTab(origin, theme.color, groupTitle({ goal: session.goal, instanceLabel: session.instanceLabel, origin }), { incognito: session.incognito === true });
        tabId = acquired.tabId;
        tabGroupId = acquired.groupId ?? null;
      }
      await transport.attachTab(session.sessionId, {
        ownedTabId: tabId,
        tabGroupId: tabGroupId ?? undefined,
        attached: false,
      }).catch(() => {});
    }
    const controller = newController({
      sessionId: session.sessionId,
      tabId,
      origin,
      allowedOrigins: Array.isArray(session.allowedOrigins) ? session.allowedOrigins : [],
      tabMode: mode,
      ownsTab: mode === "owned_group",
      tabGroupId,
      accent: mode === "owned_group" ? theme.accent : null,
    });
    sessions.set(controller.sessionId, controller);
    const liveOrigin = await liveTabOrigin(tabId);
    if (!controller.allowedOrigins.includes(liveOrigin)) {
      if (mode === "owned_group") await tabs.removeTab(tabId).catch(() => {});
      await transport.stopSession(controller.sessionId).catch(() => {});
      sessions.delete(controller.sessionId);
      return;
    }
    await controller.driver.attach(tabId);
    await transport.attachTab(controller.sessionId, {
      ownedTabId: tabId,
      tabGroupId: tabGroupId ?? undefined,
      attached: true,
      liveOrigin,
    });
    startSubscription(controller);
    await notifyState();
  }

  function startSubscription(controller) {
    if (controller.streaming || !sessions.has(controller.sessionId)) return;
    controller.streaming = true;
    controller.unsubscribe = transport.subscribe(controller.sessionId, async (command) => {
      await runCommand(controller, command).catch(() => {});
    });
  }

  function stopSubscription(controller) {
    controller.unsubscribe?.();
    controller.unsubscribe = null;
    controller.streaming = false;
  }

  async function runCommand(controller, command) {
    const commandId = command.commandId;
    if (!commandId || command.sessionId !== controller.sessionId) return;
    await transport.postEvent(commandId, "running", { actionKind: command.actionKind }).catch(() => {});
    try {
      const liveOrigin = await liveTabOrigin(controller.tabId);
      if (!controller.allowedOrigins.includes(liveOrigin)) {
        await transport.postResult({ commandId, ok: false, errorCode: "origin_not_granted" }).catch(() => {});
        return;
      }
      if (!controller.driver.isAttachedTo(controller.tabId) && typeof controller.tabId === "number") {
        await controller.driver.attach(controller.tabId);
      }
      const action = command.action ?? {};
      if (action.kind === "__finalize") {
        const disposition = ["close", "deliverable", "handoff"].includes(action.disposition) ? action.disposition : null;
        if (!disposition) throw new Error("invalid_finalize_disposition");
        const finalized = await finalizeLocal(controller, disposition);
        await transport.postResult({ commandId, ok: true, result: finalized }).catch(() => {});
        await transport.stopSession(controller.sessionId).catch(() => {});
        return;
      }
      if (action.kind === "__focus") {
        await tabs.focusTab?.(controller.tabId);
        await transport.postResult({ commandId, ok: true, result: { focused: true, tabId: controller.tabId } }).catch(() => {});
        return;
      }
      if (action.kind === "__trusted_fill") {
        await controller.driver.executeAction({ kind: "fill", target: action.target, value: action.value });
        const postFillOrigin = await liveTabOrigin(controller.tabId);
        if (!controller.allowedOrigins.includes(postFillOrigin)) {
          await transport.postResult({ commandId, ok: false, errorCode: "origin_not_granted" }).catch(() => {});
          await finalizeLocal(controller, "close").catch(() => {});
          await transport.stopSession(controller.sessionId).catch(() => {});
          return;
        }
        await transport.postResult({ commandId, ok: true, result: { filled: true } }).catch(() => {});
        await emit({ type: "activity", commandId, actionKind: "trusted_fill", status: "verified", changed: { filled: true } });
        return;
      }
      const verdict = await preDispatchFloor(controller, action).catch(() => null);
      if (verdict?.stop === "blocked") {
        await transport.postResult({ commandId, ok: false, errorCode: "blocked_by_floor", decision: verdict.decision }).catch(() => {});
        await emit({ type: "activity", commandId, actionKind: command.actionKind, status: "blocked", changed: {} });
        return;
      }
      const delta = await controller.driver.executeAction(action);
      const postActionOrigin = await liveTabOrigin(controller.tabId);
      if (!controller.allowedOrigins.includes(postActionOrigin)) {
        await transport.postResult({ commandId, ok: false, errorCode: "origin_not_granted" }).catch(() => {});
        await finalizeLocal(controller, "close").catch(() => {});
        await transport.stopSession(controller.sessionId).catch(() => {});
        return;
      }
      await transport.postResult({ commandId, ok: true, result: deltaToResult(delta), ...(verdict?.decision ? { decision: verdict.decision } : {}) }).catch(() => {});
      await emit({ type: "activity", commandId, actionKind: command.actionKind, status: delta.status, changed: delta.changed ?? {} });
    } catch (error) {
      await transport.postResult({ commandId, ok: false, errorCode: errorCode(error) }).catch(() => {});
    }
  }

  async function preDispatchFloor(controller, action) {
    const evidence = await controller.driver.resolveEvidence(action).catch(() => null);
    if (!evidence) return null;
    const origin = evidence.resolved?.origin || controller.origin || undefined;
    const decision = await Promise.resolve(evaluateFloor({
      action,
      origin,
      allowedOrigins: controller.allowedOrigins,
      resolved: evidence.resolved,
      signals: evidence.signals,
    })).catch(() => null);
    if (!decision) return null;
    if (decision.blocked) return { stop: "blocked", decision };
    return { stop: null, decision };
  }

  async function finalizeLocal(controller, disposition) {
    sessions.delete(controller.sessionId);
    stopSubscription(controller);
    await controller.driver.detach().catch(() => {});
    const tabId = controller.tabId;
    let tabKept = true;
    if (disposition === "close" && controller.ownsTab && typeof tabId === "number") {
      await tabs.removeTab(tabId).catch(() => {});
      tabKept = false;
    } else if (typeof tabId === "number") {
      await tabs.finalizeTab?.(tabId, disposition).catch(() => {});
    }
    await emit({ type: "finalized", sessionId: controller.sessionId, disposition, tabId, tabKept });
    await notifyState();
    return { finalized: true, disposition, tabId, tabKept };
  }

  function firstController() {
    for (const controller of sessions.values()) return controller;
    return null;
  }

  function controllerForTab(tabId) {
    for (const controller of sessions.values()) {
      if (controller.tabId === tabId) return controller;
    }
    return null;
  }

  async function liveTabOrigin(tabId) {
    if (typeof tabId !== "number") return "";
    const tab = await tabs.getTab(tabId).catch(() => null);
    return safeOrigin(tab?.pendingUrl) || safeOrigin(tab?.url);
  }

  return runtime;
}

function groupTitle({ goal, instanceLabel, origin } = {}) {
  const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
  const cap = (value) => (value.length > 28 ? `${value.slice(0, 27)}...` : value);
  const goalText = clean(goal);
  if (goalText) return cap(goalText);
  const label = clean(instanceLabel);
  if (label) return cap(label);
  try {
    const host = new URL(origin).hostname.replace(/^www\./, "");
    if (host) return cap(host);
  } catch {
    // Ignore non-URL origins.
  }
  return "Newton";
}

function dedupeOrigins(origins, origin) {
  const list = Array.isArray(origins) ? origins.map(safeOrigin).filter(Boolean) : [];
  const normalizedOrigin = safeOrigin(origin);
  if (normalizedOrigin && !list.includes(normalizedOrigin)) list.unshift(normalizedOrigin);
  return [...new Set(list)];
}

function safeOrigin(value) {
  try {
    const url = new URL(String(value ?? ""));
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : "";
  } catch {
    return "";
  }
}

function deltaToResult(delta) {
  if (!delta) return { kind: "ack", message: "ok" };
  if (delta.screenshot) return delta.screenshot;
  if (delta.observation) {
    return {
      ...delta.observation,
      ...(delta.status ? { actionStatus: delta.status } : {}),
      ...(typeof delta.verified === "boolean" ? { verified: delta.verified } : {}),
      ...(delta.reason ? { reason: delta.reason } : {}),
      ...(delta.changed ? { changed: delta.changed } : {}),
    };
  }
  return { kind: "ack", message: delta.status ?? "ok" };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorCode(error) {
  const message = String(error?.message ?? error ?? "driver_error");
  return message.slice(0, 80).replace(/[^a-z0-9_]+/gi, "_").toLowerCase() || "driver_error";
}
