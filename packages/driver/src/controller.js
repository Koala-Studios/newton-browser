// @ts-check
import { SessionCommandPump } from "./session-command-pump.js";
import { runSessionTransaction } from "./session-transaction.js";
const DEFAULT_SESSION_MAX_ITEMS = 32;
const DEFAULT_SESSION_MAX_BYTES = 1024 * 1024;
const STALE_COMMAND_EPOCH_ERROR = "stale_command_epoch";
const INVALID_COMMAND_SEQUENCE_ERROR = "invalid_command_sequence";
const OUTCOME_COMPLETED = "completed";
const OUTCOME_PREVENTED = "prevented";
const OUTCOME_NOT_STARTED = "not_started";
const commandByteEncoder = new TextEncoder();

const DEFAULT_GROUP_THEMES = [
  { color: "blue", accent: "31, 111, 235" },
  { color: "purple", accent: "137, 87, 229" },
  { color: "green", accent: "35, 134, 54" },
  { color: "orange", accent: "219, 109, 40" },
  { color: "pink", accent: "207, 34, 126" },
];

class SessionController {
  constructor({ sessionId, tabId, origin, allowedOrigins, tabMode, ownsTab, tabGroupId, accent, driver, lifecycleState }) {
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
    this.closing = false;
    this.sessionEpoch = null;
    this.nextSequence = 1;
    this.unsubscribe = null;
    this.reattaching = false;
    this.lifecycleState = lifecycleState ?? "creating_tab";
    this.routingErrorCode = null;
    this._commandShutdown = null;
    this._shutdownState = null;
    this._stopSession = null;
    this.pump = new SessionCommandPump({
      maxItems: DEFAULT_SESSION_MAX_ITEMS,
      maxBytes: DEFAULT_SESSION_MAX_BYTES,
    });
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
      lifecycleState: this.lifecycleState,
      ...(this.routingErrorCode ? { routingErrorCode: this.routingErrorCode } : {}),
      commandPump: this.pump.snapshot(),
    };
  }
}

export function createBridgeRuntime({ transport, evaluateFloor, tabs, driverFactory, notify, themes = DEFAULT_GROUP_THEMES } = {}) {
  if (!transport) throw new Error("bridge transport is required");
  if (typeof evaluateFloor !== "function") throw new Error("bridge floor evaluator is required");
  if (!tabs) throw new Error("bridge tabs port is required");
  if (typeof driverFactory !== "function") throw new Error("bridge driver factory is required");

  const sessions = new Map();
  const provisioningByTab = new Map();
  const bindingSessions = new Set();
  let themeCursor = 0;

  const emit = async (event) => {
    if (typeof notify !== "function") return;
    await Promise.resolve(notify(event)).catch(() => {});
  };

  const postResult = async (event) => {
    try {
      await Promise.resolve(transport.postResult(event)).catch(() => {});
    } catch {
      // Transport failures are terminal diagnostics and must not block controller progress.
    }
  };

  const bridgeSnapshot = () => {
    const list = [...sessions.values()].map((controller) => controller.snapshot());
    const primary = list[0] ?? { sessionId: null, tabId: null, origin: null, streaming: false, attached: false };
    return { ...primary, sessions: list, count: list.length };
  };

  const notifyState = async ({ required = false } = {}) => {
    const event = { type: "state", state: bridgeSnapshot() };
    if (required && typeof notify === "function") {
      await Promise.resolve(notify(event));
      return;
    }
    await emit(event);
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
      const theme = nextTheme();
      if (mode === "current" && typeof tabId !== "number") {
        throw new Error("A normal web tab is required to drive the current tab.");
      }
      return runSessionTransaction(async ({ defer }) => {
        let ownedTabId = mode === "current" ? tabId : null;
        let tabGroupId = null;
        if (mode === "owned_group") {
          const acquired = await tabs.createOwnedTab(origin, theme.color, groupTitle({ goal, instanceLabel, origin }));
          ownedTabId = acquired.tabId;
          tabGroupId = acquired.groupId ?? null;
          defer("owned_tab", () => tabs.removeTab(ownedTabId), { dedupeKey: `tab:${ownedTabId}` });
        }
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
        defer("host_session", () => transport.stopSession(created.sessionId), {
          dedupeKey: `host:${created.sessionId}`,
        });
        const controller = newController({
          sessionId: created.sessionId,
          tabId: ownedTabId,
          origin: origin ?? null,
          allowedOrigins: dedupeOrigins(allowedOrigins, origin),
          tabMode: mode,
          ownsTab: mode === "owned_group",
          tabGroupId,
          accent: mode === "owned_group" ? theme.accent : null,
          lifecycleState: "attaching_debugger",
        });
        registerProvisioningController(controller, defer);
        defer("debugger", () => controller.driver.detach(), { dedupeKey: `debugger:${created.sessionId}` });
        await controller.driver.attach(ownedTabId);
        controller.lifecycleState = "verifying_origin";
        const liveOrigin = await liveTabOrigin(ownedTabId);
        if (!controller.allowedOrigins.includes(liveOrigin)) throw new Error("origin_not_granted");
        await transport.attachTab(controller.sessionId, { ownedTabId, tabGroupId, attached: true, liveOrigin });
        controller.lifecycleState = "publishing_ready";
        defer("published_session", () => {
          sessions.delete(controller.sessionId);
          stopSubscription(controller);
        }, { dedupeKey: `published:${created.sessionId}` });
        sessions.set(controller.sessionId, controller);
        provisioningByTab.delete(controller.tabId);
        startSubscription(controller);
        controller.lifecycleState = "active";
        await notifyState({ required: true });
        return controller.sessionId;
      });
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
      await shutdownController(controller, { awaitCurrent: true });
      if (!controller._commandShutdown?.notifiedState) {
        await notifyState();
      }
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
        } else if (!controller.streaming && !controller.closing) {
          startSubscription(controller);
        }
      }
    },

    async handleDebuggerEvent(source, method, params) {
      const controller = controllerForTab(source?.tabId);
      if (!controller) return;
      try {
        await controller.driver.recordDebuggerEvent?.(source, method, params);
      } catch {
        controller.routingErrorCode = "child_routing_unavailable";
        controller.lifecycleState = "degraded";
        return;
      }
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
    return runSessionTransaction(async ({ defer }) => {
      const mode = session.tabMode === "current" ? "current" : "owned_group";
      const theme = nextTheme();
      let tabId = Number.isInteger(session.ownedTabId) ? session.ownedTabId : null;
      let tabGroupId = Number.isInteger(session.tabGroupId) ? session.tabGroupId : null;
      const origin = session.origin ?? null;
      defer("host_session", () => transport.stopSession(session.sessionId), {
        dedupeKey: `host:${session.sessionId}`,
      });
      if (tabId !== null && !(await tabs.getTab(tabId).catch(() => null))) {
        tabId = null;
        tabGroupId = null;
      }
      if (tabId === null) {
        if (mode === "current") {
          if (typeof activeTabId !== "number") throw new Error("current_tab_unavailable");
          tabId = activeTabId;
        } else {
          const acquired = await tabs.createOwnedTab(
            origin,
            theme.color,
            groupTitle({ goal: session.goal, instanceLabel: session.instanceLabel, origin }),
            { incognito: session.incognito === true },
          );
          tabId = acquired.tabId;
          tabGroupId = acquired.groupId ?? null;
          defer("owned_tab", () => tabs.removeTab(tabId), { dedupeKey: `tab:${tabId}` });
        }
        await transport.attachTab(session.sessionId, {
          ownedTabId: tabId,
          tabGroupId: tabGroupId ?? undefined,
          attached: false,
        });
      } else if (mode === "owned_group") {
        defer("owned_tab", () => tabs.removeTab(tabId), { dedupeKey: `tab:${tabId}` });
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
        lifecycleState: "verifying_origin",
      });
      registerProvisioningController(controller, defer);
      const liveOrigin = await liveTabOrigin(tabId);
      if (!controller.allowedOrigins.includes(liveOrigin)) throw new Error("origin_not_granted");
      controller.lifecycleState = "attaching_debugger";
      defer("debugger", () => controller.driver.detach(), { dedupeKey: `debugger:${session.sessionId}` });
      await controller.driver.attach(tabId);
      await transport.attachTab(controller.sessionId, {
        ownedTabId: tabId,
        tabGroupId: tabGroupId ?? undefined,
        attached: true,
        liveOrigin,
      });
      controller.lifecycleState = "publishing_ready";
      defer("published_session", () => {
        sessions.delete(controller.sessionId);
        stopSubscription(controller);
      }, { dedupeKey: `published:${session.sessionId}` });
      sessions.set(controller.sessionId, controller);
      provisioningByTab.delete(controller.tabId);
      startSubscription(controller);
      controller.lifecycleState = "active";
      await notifyState({ required: true });
    });
  }

  function startSubscription(controller) {
    if (controller.streaming || controller.closing || !sessions.has(controller.sessionId)) return;
    controller.streaming = true;
    controller.unsubscribe = transport.subscribe(controller.sessionId, async (command) => {
      await enqueueCommand(controller, command);
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
    let executionStarted = false;
    let terminalResultAttempted = false;
    const emitTerminalResult = async (details, outcome) => {
      if (terminalResultAttempted) return;
      terminalResultAttempted = true;
      await reportCommandResult(command, details, outcome);
    };
    try {
      const liveOrigin = await liveTabOrigin(controller.tabId);
      if (!controller.allowedOrigins.includes(liveOrigin)) {
        await emitTerminalResult({ ok: false, errorCode: "origin_not_granted" }, OUTCOME_PREVENTED);
        return;
      }
      if (controller.routingErrorCode) {
        await emitTerminalResult({ ok: false, errorCode: controller.routingErrorCode }, OUTCOME_PREVENTED);
        return;
      }
      if (!controller.driver.isAttachedTo(controller.tabId) && typeof controller.tabId === "number") {
        await controller.driver.attach(controller.tabId);
      }
      const action = command.action ?? {};
      if (action.kind === "__finalize") {
        const disposition = ["close", "deliverable", "handoff"].includes(action.disposition) ? action.disposition : null;
        if (!disposition) throw new Error("invalid_finalize_disposition");
        executionStarted = true;
        prepareShutdown(controller, { notifyState: true, awaitCurrent: false });
        const finalized = await commandShutdown(controller, { disposition, notifyState: true });
        try {
          await emitTerminalResult({ ok: true, result: finalized }, OUTCOME_COMPLETED);
        } finally {
          await stopHostSession(controller);
        }
        return;
      }
      if (action.kind === "__focus") {
        executionStarted = true;
        await tabs.focusTab?.(controller.tabId);
        await emitTerminalResult({ ok: true, result: { focused: true, tabId: controller.tabId } }, OUTCOME_COMPLETED);
        return;
      }
      if (action.kind === "__trusted_fill") {
        executionStarted = true;
        await controller.driver.executeAction({ kind: "fill", target: action.target, value: action.value });
        const postFillOrigin = await liveTabOrigin(controller.tabId);
        if (!controller.allowedOrigins.includes(postFillOrigin)) {
          prepareShutdown(controller, { notifyState: true, awaitCurrent: false });
          await emitTerminalResult({ ok: false, errorCode: "origin_not_granted" }, OUTCOME_COMPLETED);
          try {
            await commandShutdown(controller, { disposition: "close", notifyState: true });
          } finally {
            await stopHostSession(controller);
          }
          return;
        }
        await reportCommandResult(command, { ok: true, result: { filled: true } }, OUTCOME_COMPLETED);
        await emit({ type: "activity", commandId, actionKind: "trusted_fill", status: "verified", changed: { filled: true } });
        return;
      }
      const verdict = await preDispatchFloor(controller, action);
      if (verdict?.stop === "blocked") {
        await emitTerminalResult({ ok: false, errorCode: "blocked_by_floor", decision: verdict.decision }, OUTCOME_PREVENTED);
        await emit({ type: "activity", commandId, actionKind: command.actionKind, status: "blocked", changed: {} });
        return;
      }
      executionStarted = true;
      const delta = await controller.driver.executeAction(action);
      const postActionOrigin = await liveTabOrigin(controller.tabId);
      if (!controller.allowedOrigins.includes(postActionOrigin)) {
        prepareShutdown(controller, { notifyState: true, awaitCurrent: false });
        await emitTerminalResult({ ok: false, errorCode: "origin_not_granted" }, OUTCOME_COMPLETED);
        try {
          await commandShutdown(controller, { disposition: "close", notifyState: true });
        } finally {
          await stopHostSession(controller);
        }
        return;
      }
      await emitTerminalResult({
        ok: true,
        result: deltaToResult(delta),
        ...(verdict?.decision ? { decision: verdict.decision } : {}),
      }, OUTCOME_COMPLETED);
      await emit({ type: "activity", commandId, actionKind: command.actionKind, status: delta.status, changed: delta.changed ?? {} });
    } catch (error) {
      const stageOutcome = executionStarted ? OUTCOME_COMPLETED : OUTCOME_PREVENTED;
      const detail = errorCode(error);
      await emitTerminalResult({ ok: false, errorCode: detail }, stageOutcome);
    }
  }

  async function preDispatchFloor(controller, action) {
    try {
      const evidence = await controller.driver.resolveEvidence(action);
    if (!evidence) return null;
    const origin = evidence.resolved?.origin || controller.origin || undefined;
    const decision = await Promise.resolve(evaluateFloor({
      action,
      origin,
      allowedOrigins: controller.allowedOrigins,
      resolved: evidence.resolved,
      signals: evidence.signals,
    }));
    if (!decision) return null;
    if (decision && typeof decision !== "object") return null;
    if (decision.blocked) return { stop: "blocked", decision };
    return { stop: null, decision };
    } catch (error) {
      throw new Error("floor_evaluation_failed");
    }
  }

  function finalizeCurrentCommand(controller, disposition) {
    return commandShutdown(controller, { disposition });
  }

  function firstController() {
    for (const controller of sessions.values()) return controller;
    return null;
  }

  function controllerForTab(tabId) {
    for (const controller of sessions.values()) {
      if (controller.tabId === tabId) return controller;
    }
    return provisioningByTab.get(tabId) ?? null;
  }

  function registerProvisioningController(controller, defer) {
    if (provisioningByTab.has(controller.tabId)) throw new Error("tab_already_provisioning");
    provisioningByTab.set(controller.tabId, controller);
    defer("private_controller", () => {
      if (provisioningByTab.get(controller.tabId) === controller) provisioningByTab.delete(controller.tabId);
    }, { dedupeKey: `private:${controller.sessionId}` });
  }

  async function liveTabOrigin(tabId) {
    if (typeof tabId !== "number") return "";
    const tab = await tabs.getTab(tabId).catch(() => null);
    return safeOrigin(tab?.pendingUrl) || safeOrigin(tab?.url);
  }

  async function shutdownController(controller, { awaitCurrent = true } = {}) {
    return completeShutdown(controller, { awaitCurrent });
  }

  async function completeShutdown(controller, { awaitCurrent = true, disposition = null, notifyState = false } = {}) {
    const shutdownState = prepareShutdown(controller, { awaitCurrent, notifyState });
    if (!shutdownState.promise) {
      shutdownState.promise = (async () => {
        if (shutdownState.awaitCurrent) {
          await shutdownState.closePromise;
        }
        const finalized = await commandShutdown(controller, { disposition, notifyState: shutdownState.notifyState });
        await stopHostSession(controller);
        return finalized;
      })();
    }
    return shutdownState.promise;
  }

  function prepareShutdown(controller, { awaitCurrent = true, notifyState = false } = {}) {
    if (!controller._shutdownState) {
      controller.closing = true;
      const closePromise = controller.pump.closeAfterCurrent();
      stopSubscription(controller);
      controller._shutdownState = {
        awaitCurrent: Boolean(awaitCurrent),
        closePromise,
        notifyState: Boolean(notifyState),
        promise: null,
      };
    }
    if (awaitCurrent) {
      controller._shutdownState.awaitCurrent = true;
    }
    if (notifyState) {
      controller._shutdownState.notifyState = true;
    }
    return controller._shutdownState;
  }

  function stopHostSession(controller) {
    if (controller._stopSession) return controller._stopSession;
    controller._stopSession = Promise.resolve()
      .then(() => transport.stopSession(controller.sessionId))
      .catch(() => {});
    return controller._stopSession;
  }

  function commandShutdown(controller, { disposition = null, notifyState: shouldNotifyState = false } = {}) {
    if (!controller._commandShutdown) {
      const state = {
        notifyState: Boolean(shouldNotifyState),
        notifiedState: false,
        promise: null,
      };

      const commandResult = (async () => {
        let tabKept = true;
        const tabId = controller.tabId;

        const shutdownResult = {
          finalized: Boolean(disposition),
          disposition,
          tabId,
          tabKept,
        };

        if (typeof tabId === "number" && (disposition === null || disposition === "close") && controller.ownsTab) {
          shutdownResult.tabKept = false;
        }

        sessions.delete(controller.sessionId);
        stopSubscription(controller);
        await controller.driver.detach().catch(() => {});

        if (typeof tabId === "number" && (disposition === null || disposition === "close") && controller.ownsTab) {
          tabKept = false;
          shutdownResult.tabKept = false;
          await tabs.removeTab(tabId).catch(() => {});
        } else if (typeof tabId === "number" && disposition) {
          await tabs.finalizeTab?.(tabId, disposition).catch(() => {});
        }

        if (disposition) {
          await emit({ type: "finalized", sessionId: controller.sessionId, disposition, tabId, tabKept });
        }
        if (state.notifyState) {
          await notifyState();
          state.notifiedState = true;
        }
        return shutdownResult;
      })();

      state.promise = commandResult;
      controller._commandShutdown = state;
    } else if (shouldNotifyState) {
      controller._commandShutdown.notifyState = true;
    }
    return controller._commandShutdown.promise;
  }

  async function enqueueCommand(controller, command) {
    if (!command || typeof command !== "object") return;
    const commandId = command.commandId;
    if (typeof commandId !== "string" || commandId.length === 0) return;
    if (command.sessionId !== controller.sessionId) return;
    const envelope = commandEnvelope(command);
    if (!envelope) return;
    const sequenceValidation = validateAndTrackCommandSequence(controller, envelope);
    if (sequenceValidation.rejected) {
      const outcome = sequenceValidation.outcome ?? OUTCOME_PREVENTED;
      const code = sequenceValidation.code ?? INVALID_COMMAND_SEQUENCE_ERROR;
      await reportCommandResult(envelope, { ok: false, errorCode: code }, outcome);
      if (sequenceValidation.fence) {
        await completeShutdown(controller, { awaitCurrent: true });
      }
      return;
    }

    const bytes = commandByteCount(envelope);
    if (!Number.isSafeInteger(bytes)) {
      await reportCommandResult(envelope, { ok: false, errorCode: "invalid_command_size" }, OUTCOME_PREVENTED);
      return;
    }

    const execute = () => runCommand(controller, envelope);
    const queued = controller.pump.enqueue(envelope, bytes, execute);
    const handled = queued.catch(async (error) => {
      const code = pumpRejectionCode(error);
      await reportCommandResult(envelope, { ok: false, errorCode: code }, OUTCOME_NOT_STARTED);
    });
    return handled;
  }

  function commandEnvelope(command) {
    const commandId = command?.commandId;
    const sessionId = command?.sessionId;
    if (typeof commandId !== "string" || commandId.length === 0) return null;
    if (typeof sessionId !== "string" || sessionId.length === 0) return null;
    return {
      ...command,
      commandId,
      sessionId,
    };
  }

  async function reportCommandResult(command, details, outcome) {
    const commandId = command?.commandId;
    const sessionEpoch = command?.sessionEpoch;
    const sequence = command?.sequence;
    if (typeof commandId !== "string" || commandId.length === 0) return;
    const retrySafe = stageRetrySafe(outcome);
    await postResult({
      commandId,
      sessionEpoch,
      sequence,
      ...details,
      outcome,
      retrySafe,
    });
  }

  function validateAndTrackCommandSequence(controller, command) {
    const sessionEpoch = positiveSafeInteger(command?.sessionEpoch);
    const sequence = positiveSafeInteger(command?.sequence);
    if (sessionEpoch == null || sequence == null) {
      return {
        rejected: true,
        code: INVALID_COMMAND_SEQUENCE_ERROR,
        outcome: OUTCOME_PREVENTED,
      };
    }
    if (!Number.isSafeInteger(controller.sessionEpoch) || controller.sessionEpoch <= 0) {
      if (sequence !== 1) {
        return {
          rejected: true,
          code: INVALID_COMMAND_SEQUENCE_ERROR,
          outcome: OUTCOME_PREVENTED,
        };
      }
      controller.sessionEpoch = sessionEpoch;
      controller.nextSequence = 2;
      return { rejected: false };
    }
    if (sessionEpoch < controller.sessionEpoch) {
      return { rejected: true, code: STALE_COMMAND_EPOCH_ERROR, outcome: OUTCOME_PREVENTED };
    }
    if (sessionEpoch > controller.sessionEpoch) {
      if (sequence !== 1) {
        return { rejected: true, code: INVALID_COMMAND_SEQUENCE_ERROR, outcome: OUTCOME_PREVENTED };
      }
      controller.sessionEpoch = sessionEpoch;
      controller.nextSequence = 2;
      return { rejected: false };
    }

    if (sequence !== controller.nextSequence) {
      const isForwardGap = sequence > controller.nextSequence;
      return {
        rejected: true,
        code: INVALID_COMMAND_SEQUENCE_ERROR,
        outcome: OUTCOME_PREVENTED,
        fence: isForwardGap,
      };
    }
    controller.nextSequence += 1;
    return { rejected: false };
  }

  function commandByteCount(command) {
    try {
      const json = JSON.stringify(command);
      if (typeof json !== "string") return null;
      return commandByteEncoder.encode(json).byteLength;
    } catch {
      return null;
    }
  }

  function pumpRejectionCode(error) {
    if (error && typeof error.code === "string") return error.code;
    const code = String(error?.message ?? "");
    if (code === "invalid_command_size") return "invalid_command_size";
    if (code === "session_queue_full") return "session_queue_full";
    if (code === "session_finalizing") return "session_finalizing";
    return "driver_error";
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
  if (error && typeof error.code === "string") return error.code.slice(0, 80);
  const message = String(error?.message ?? error ?? "driver_error");
  return message.slice(0, 80).replace(/[^a-z0-9_]+/gi, "_").toLowerCase() || "driver_error";
}

function stageRetrySafe(outcome) {
  return outcome === OUTCOME_NOT_STARTED || outcome === OUTCOME_PREVENTED;
}

function positiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}
