// Bridge runtime for transport-injected browser sessions.
import { SessionCommandPump } from "./session-command-pump.js";
import { runSessionTransaction } from "./session-transaction.js";

type UnknownRecord = Record<string, unknown>;
type Theme = { color: string; accent: string };
type TabMode = "current" | "owned_group";
type Disposition = "close" | "deliverable" | "handoff";
type LifecycleState = "creating_tab" | "verifying_origin" | "attaching_debugger" | "publishing_ready" | "active" | "reconciling" | "degraded";
type Outcome = typeof OUTCOME_COMPLETED | typeof OUTCOME_PREVENTED | typeof OUTCOME_NOT_STARTED | typeof OUTCOME_UNKNOWN;
type TabInfo = { id?: number; url?: string; pendingUrl?: string; discarded?: boolean };
type DriverDelta = {
  status?: string;
  verified?: boolean;
  reason?: string;
  changed?: UnknownRecord;
  screenshot?: unknown;
  observation?: UnknownRecord;
};
type DriverEvidence = { resolved?: { origin?: string } & UnknownRecord; signals?: UnknownRecord };
type DriverPort = {
  accent: string | null;
  ownsTab: boolean;
  allowedOrigins: string[];
  attached?: boolean;
  containmentReady?: boolean;
  attach(tabId: number): Promise<unknown>;
  detach(): Promise<unknown>;
  isAttachedTo(tabId: number | null): boolean;
  reassertOverlay(): Promise<unknown>;
  markDetached(reason: string): void;
  markDiscarded?(): void;
  markTargetGone?(): void;
  recordDebuggerEvent?(source: DebuggerSource, method: string, params: UnknownRecord): Promise<unknown>;
  preflightAction?(action: UnknownRecord): Promise<unknown>;
  resolveEvidence(action: UnknownRecord): Promise<DriverEvidence | null>;
  executeAction(action: UnknownRecord, context: { commandId: string }): Promise<DriverDelta>;
};
type DebuggerSource = { tabId?: number };
type SessionDescriptor = {
  sessionId: string;
  origin?: string | null;
  allowedOrigins?: unknown;
  goal?: unknown;
  instanceLabel?: unknown;
  tabMode?: unknown;
  ownedTabId?: unknown;
  tabGroupId?: unknown;
  incognito?: boolean;
};
type Command = UnknownRecord & {
  commandId: string;
  sessionId: string;
  actionKind?: string;
  action?: UnknownRecord;
  sessionEpoch?: unknown;
  sequence?: unknown;
};
type TransportPort = {
  createSession(input: UnknownRecord): Promise<{ sessionId?: string }>;
  attachTab(sessionId: string, input: UnknownRecord): Promise<unknown>;
  stopSession(sessionId: string): Promise<unknown> | unknown;
  stopAll(): Promise<unknown>;
  listSessions(): Promise<SessionDescriptor[]>;
  subscribe(sessionId: string, callback: (command: unknown) => Promise<void>): () => void;
  postEvent(commandId: string, eventType: string, detail: UnknownRecord): Promise<unknown>;
  postResult(event: UnknownRecord): Promise<unknown> | unknown;
};
type TabsPort = {
  createOwnedTab(origin: unknown, color: unknown, title: string, options?: { incognito?: boolean }): Promise<{ tabId: number; groupId?: number | null }>;
  setAutoDiscardable?(tabId: number, autoDiscardable: boolean): Promise<unknown>;
  removeTab(tabId: number): Promise<unknown>;
  getTab(tabId: number): Promise<TabInfo>;
  focusTab?(tabId: number | null): Promise<unknown>;
  finalizeTab?(tabId: number, disposition: Disposition): Promise<unknown>;
  onDebuggerEvent?(callback: (source: DebuggerSource, method: string, params: UnknownRecord) => void): () => void;
  onDebuggerDetach?(callback: (source: DebuggerSource, reason: string) => void): () => void;
  onTabRemoved?(callback: (tabId: number) => void): () => void;
  onTabUpdated?(callback: (tabId: number, changeInfo: UnknownRecord, tab: TabInfo) => void): () => void;
};
type RuntimeOptions = {
  transport: TransportPort;
  evaluateFloor: (input: UnknownRecord) => unknown | Promise<unknown>;
  tabs: TabsPort;
  driverFactory: () => DriverPort;
  notify?: (event: UnknownRecord) => unknown | Promise<unknown>;
  themes?: Theme[];
};
type RuntimeOptionsInput = Partial<RuntimeOptions>;
type ControllerInput = {
  sessionId: string;
  tabId: number | null;
  origin: string | null;
  allowedOrigins: unknown;
  tabMode: TabMode;
  ownsTab: boolean;
  tabGroupId: number | null;
  accent: string | null;
  driver: DriverPort;
  lifecycleState: LifecycleState;
};
type StartSessionInput = {
  tabId?: number;
  origin?: string;
  allowedOrigins?: unknown;
  goal?: unknown;
  tabMode?: unknown;
  instanceLabel?: unknown;
};
type RestoredBinding = { sessionId?: string; tabId?: number; tabGroupId?: number | null };
type SequenceValidation = { rejected: boolean; code?: string; outcome?: Outcome; fence?: boolean };
type ShutdownResult = { finalized: boolean; disposition: Disposition | null; tabId: number | null; tabKept: boolean };
type CommandNotificationState = { notifyState: boolean; notifiedState: boolean };
type CommandShutdownState = { notification: CommandNotificationState; promise: Promise<ShutdownResult> };
type ShutdownState = { awaitCurrent: boolean; closePromise: Promise<unknown>; notifyState: boolean; promise: Promise<ShutdownResult> | null };
type Defer = (name: string, cleanup: () => unknown | Promise<unknown>, options: { dedupeKey: string }) => void;
const DEFAULT_SESSION_MAX_ITEMS = 32;
const DEFAULT_SESSION_MAX_BYTES = 1024 * 1024;
const STALE_COMMAND_EPOCH_ERROR = "stale_command_epoch";
const INVALID_COMMAND_SEQUENCE_ERROR = "invalid_command_sequence";
const OUTCOME_COMPLETED = "completed";
const OUTCOME_PREVENTED = "prevented";
const OUTCOME_NOT_STARTED = "not_started";
const OUTCOME_UNKNOWN = "outcome_unknown";
const MAX_REATTACH_ATTEMPTS = 4;
const commandByteEncoder = new TextEncoder();

const DEFAULT_GROUP_THEMES: Theme[] = [
  { color: "blue", accent: "31, 111, 235" },
  { color: "purple", accent: "137, 87, 229" },
  { color: "green", accent: "35, 134, 54" },
  { color: "orange", accent: "219, 109, 40" },
  { color: "pink", accent: "207, 34, 126" },
];

class SessionController {
  readonly sessionId: string;
  readonly tabId: number | null;
  readonly origin: string | null;
  allowedOrigins: string[];
  readonly tabMode: TabMode;
  readonly ownsTab: boolean;
  readonly tabGroupId: number | null;
  readonly driver: DriverPort;
  streaming: boolean;
  closing: boolean;
  sessionEpoch: number | null;
  nextSequence: number;
  unsubscribe: (() => void) | null;
  reattaching: boolean;
  reattachPending: boolean;
  reattachAttempts: number;
  lastDetachReason: string | null;
  lifecycleState: LifecycleState;
  routingErrorCode: string | null;
  _commandShutdown: CommandShutdownState | null;
  _shutdownState: ShutdownState | null;
  _stopSession: Promise<void> | null;
  readonly pump: SessionCommandPump;

  constructor({ sessionId, tabId, origin, allowedOrigins, tabMode, ownsTab, tabGroupId, accent, driver, lifecycleState }: ControllerInput) {
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
    this.reattachPending = false;
    this.reattachAttempts = 0;
    this.lastDetachReason = null;
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

export function createBridgeRuntime(options: RuntimeOptionsInput = {}) {
  const { transport, evaluateFloor, tabs, driverFactory, notify, themes = DEFAULT_GROUP_THEMES } = requireRuntimeOptions(options);
  if (!transport) throw new Error("bridge transport is required");
  if (typeof evaluateFloor !== "function") throw new Error("bridge floor evaluator is required");
  if (!tabs) throw new Error("bridge tabs port is required");
  if (typeof driverFactory !== "function") throw new Error("bridge driver factory is required");

  const sessions = new Map<string, SessionController>();
  const provisioningByTab = new Map<number | null, SessionController>();
  const bindingSessions = new Set<string>();
  let themeCursor = 0;

  const emit = async (event: UnknownRecord): Promise<void> => {
    if (typeof notify !== "function") return;
    await Promise.resolve(notify(event)).catch(() => {});
  };

  const postResult = async (event: UnknownRecord): Promise<void> => {
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

  const notifyState = async ({ required = false }: { required?: boolean } = {}) => {
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

    isDrivingTab(tabId: number): boolean {
      for (const controller of sessions.values()) {
        if (controller.tabId === tabId && controller.driver.isAttachedTo(tabId)) return true;
      }
      return false;
    },

    async reassertOverlayForTab(tabId: number): Promise<void> {
      for (const controller of sessions.values()) {
        if (controller.tabId === tabId && controller.driver.isAttachedTo(tabId)) {
          await controller.driver.reassertOverlay().catch(() => {});
        }
      }
    },

    async startSession({ tabId, origin, allowedOrigins, goal, tabMode, instanceLabel }: StartSessionInput = {}) {
      if (!safeOrigin(origin)) throw new Error("origin_required");
      const mode = tabMode === "current" ? "current" : "owned_group";
      const theme = nextTheme();
      if (mode === "current" && typeof tabId !== "number") {
        throw new Error("A normal web tab is required to drive the current tab.");
      }
      return runSessionTransaction(async ({ defer }: { defer: Defer }) => {
        let selectedTabId: unknown = mode === "current" ? tabId : null;
        let tabGroupId = null;
        if (mode === "owned_group") {
          const acquired = await tabs.createOwnedTab(origin, theme.color, groupTitle({ goal, instanceLabel, origin }));
          selectedTabId = acquired.tabId;
          tabGroupId = acquired.groupId ?? null;
        }
        const ownedTabId = requireTabId(selectedTabId);
        if (mode === "owned_group") {
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
        const createdSessionId = created.sessionId;
        defer("host_session", () => transport.stopSession(createdSessionId), {
          dedupeKey: `host:${createdSessionId}`,
        });
        const controller = newController({
          sessionId: createdSessionId,
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
        controller.lifecycleState = "verifying_origin";
        const preAttachOrigin = await liveTabOrigin(ownedTabId);
        if (!controller.allowedOrigins.includes(preAttachOrigin)) throw new Error("origin_not_granted");
        controller.lifecycleState = "attaching_debugger";
        defer("debugger", () => controller.driver.detach(), { dedupeKey: `debugger:${createdSessionId}` });
        await controller.driver.attach(ownedTabId);
        controller.lifecycleState = "verifying_origin";
        const liveOrigin = await liveTabOrigin(ownedTabId);
        if (!controller.allowedOrigins.includes(liveOrigin)) throw new Error("origin_not_granted");
        await transport.attachTab(controller.sessionId, { ownedTabId, tabGroupId, attached: true, liveOrigin });
        controller.lifecycleState = "publishing_ready";
        defer("published_session", () => {
          sessions.delete(controller.sessionId);
          stopSubscription(controller);
        }, { dedupeKey: `published:${createdSessionId}` });
        sessions.set(controller.sessionId, controller);
        provisioningByTab.delete(controller.tabId);
        startSubscription(controller);
        controller.lifecycleState = "active";
        await notifyState({ required: true });
        return controller.sessionId;
      });
    },

    async ensureForActiveSessions(activeTabId?: number, restoredBindings: RestoredBinding[] = []) {
      const list = await transport.listSessions().catch(() => null);
      if (!Array.isArray(list)) return;
      const restored = new Map<string, RestoredBinding>((Array.isArray(restoredBindings) ? restoredBindings : []).flatMap((binding) =>
        binding.sessionId && Number.isInteger(binding.tabId) ? [[binding.sessionId, binding] as const] : [],
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

    async stop(sessionId?: string) {
      const controller = sessionId ? sessions.get(sessionId) : firstController();
      if (!controller) return { stopped: false };
      await shutdownController(controller, { awaitCurrent: true });
      if (!controller._commandShutdown?.notification.notifiedState) {
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

    async handleDebuggerEvent(source: DebuggerSource, method: string, params: UnknownRecord) {
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
      const targetInfo = isRecord(params.targetInfo) ? params.targetInfo : null;
      if (method === "Target.targetCreated" && targetInfo?.type === "page") {
        await emit({ type: "new_target", url: targetInfo.url ?? "" });
      }
      const frame = isRecord(params.frame) ? params.frame : null;
      if (method === "Page.frameNavigated" && frame && !frame.parentId) {
        await controller.driver.reassertOverlay().catch(() => {});
      }
    },

    async handleDebuggerDetach(source: DebuggerSource, reason: unknown) {
      const controller = controllerForTab(source?.tabId);
      if (!controller) return;
      const detachReason = String(reason ?? "debugger_detached");
      controller.driver.markDetached(detachReason);
      controller.lastDetachReason = detachReason;
      if (detachReason === "canceled_by_user") {
        await runtime.stop(controller.sessionId).catch(() => {});
        return;
      }
      if (/replaced|devtools|another debugger/i.test(detachReason)) {
        controller.routingErrorCode = "debugger_conflict";
        controller.lifecycleState = "degraded";
        await notifyState();
        return;
      }
      controller.routingErrorCode = "debugger_detached";
      controller.lifecycleState = "reconciling";
      controller.reattachPending = true;
      controller.reattachAttempts = 0;
      await attemptReattach(controller);
    },

    async handleTabUpdated(tabId: number, changeInfo: UnknownRecord, tab: TabInfo) {
      const controller = controllerForTab(tabId);
      if (!controller) return;
      if (changeInfo?.discarded === true || tab?.discarded === true) {
        controller.driver.markDiscarded?.();
        controller.routingErrorCode = "discarded";
        controller.lifecycleState = "degraded";
        controller.reattachPending = false;
        await notifyState();
        return;
      }
      if (controller.reattachPending) await attemptReattach(controller);
    },

    async handleTabRemoved(tabId: number) {
      const controller = controllerForTab(tabId);
      if (controller) {
        controller.driver.markTargetGone?.();
        await runtime.stop(controller.sessionId).catch(() => {});
      }
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
  tabs.onTabUpdated?.((tabId, changeInfo, tab) => {
    void runtime.handleTabUpdated(tabId, changeInfo, tab).catch(() => {});
  });

  function nextTheme() {
    const theme = themes[themeCursor % themes.length] ?? DEFAULT_GROUP_THEMES[0]!;
    themeCursor += 1;
    return theme;
  }

  function newController(input: Omit<ControllerInput, "driver">) {
    return new SessionController({ ...input, driver: driverFactory() });
  }

  async function bindExternalSession(session: SessionDescriptor, activeTabId?: number) {
    return runSessionTransaction(async ({ defer }: { defer: Defer }) => {
      const mode = session.tabMode === "current" ? "current" : "owned_group";
      const theme = nextTheme();
      let tabId = typeof session.ownedTabId === "number" && Number.isInteger(session.ownedTabId) ? session.ownedTabId : null;
      let tabGroupId = typeof session.tabGroupId === "number" && Number.isInteger(session.tabGroupId) ? session.tabGroupId : null;
      let retainedOwnedTab = false;
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
          tabId = requireTabId(acquired.tabId);
          tabGroupId = acquired.groupId ?? null;
          const acquiredTabId = tabId;
          defer("owned_tab", () => tabs.removeTab(acquiredTabId), { dedupeKey: `tab:${acquiredTabId}` });
        }
        await transport.attachTab(session.sessionId, {
          ownedTabId: tabId,
          tabGroupId: tabGroupId ?? undefined,
          attached: false,
        });
      } else if (mode === "owned_group") {
        const retainedTabId = tabId;
        defer("owned_tab", () => tabs.removeTab(retainedTabId), { dedupeKey: `tab:${retainedTabId}` });
        retainedOwnedTab = true;
      }
      if (retainedOwnedTab) await tabs.setAutoDiscardable?.(tabId, false);
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

  async function attemptReattach(controller: SessionController): Promise<boolean> {
    if (!controller.reattachPending || controller.reattaching || controller.closing) return false;
    if (!sessions.has(controller.sessionId) || typeof controller.tabId !== "number") return false;
    controller.reattaching = true;
    controller.reattachAttempts += 1;
    try {
      const tab = await tabs.getTab(controller.tabId).catch(() => null);
      if (!tab) {
        controller.driver.markTargetGone?.();
        controller.routingErrorCode = "target_gone";
        controller.lifecycleState = "degraded";
        controller.reattachPending = false;
        await notifyState();
        return false;
      }
      if (tab.discarded) {
        controller.driver.markDiscarded?.();
        controller.routingErrorCode = "discarded";
        controller.lifecycleState = "degraded";
        controller.reattachPending = false;
        await notifyState();
        return false;
      }
      const origin = safeOrigin(tab.pendingUrl) || safeOrigin(tab.url);
      if (!controller.allowedOrigins.includes(origin)) {
        controller.routingErrorCode = "origin_not_granted";
        controller.lifecycleState = "degraded";
        controller.reattachPending = false;
        await notifyState();
        return false;
      }
      controller.lifecycleState = "attaching_debugger";
      await controller.driver.attach(controller.tabId);
      controller.reattachPending = false;
      controller.reattachAttempts = 0;
      controller.routingErrorCode = null;
      controller.lifecycleState = "active";
      if (!controller.streaming) startSubscription(controller);
      await notifyState();
      return true;
    } catch (error) {
      if (/replaced|devtools|another debugger|already attached/i.test(errorMessage(error))) {
        controller.reattachPending = false;
        controller.routingErrorCode = "debugger_conflict";
        controller.lifecycleState = "degraded";
        await notifyState();
        return false;
      }
      if (controller.reattachAttempts >= MAX_REATTACH_ATTEMPTS) {
        controller.reattachPending = false;
        controller.lifecycleState = "degraded";
        controller.routingErrorCode = "debugger_detached";
        await notifyState();
        return false;
      }
      controller.lifecycleState = "reconciling";
      controller.routingErrorCode = "debugger_detached";
      await notifyState();
      return false;
    } finally {
      controller.reattaching = false;
    }
  }

  function startSubscription(controller: SessionController): void {
    if (controller.streaming || controller.closing || !sessions.has(controller.sessionId)) return;
    controller.streaming = true;
    controller.unsubscribe = transport.subscribe(controller.sessionId, async (command: unknown) => {
      await enqueueCommand(controller, command);
    });
  }

  function stopSubscription(controller: SessionController): void {
    controller.unsubscribe?.();
    controller.unsubscribe = null;
    controller.streaming = false;
  }

  async function runCommand(controller: SessionController, command: Command): Promise<void> {
    const commandId = command.commandId;
    if (!commandId || command.sessionId !== controller.sessionId) return;
    await transport.postEvent(commandId, "running", { actionKind: command.actionKind }).catch(() => {});
    let executionStarted = false;
    let terminalResultAttempted = false;
    const emitTerminalResult = async (details: UnknownRecord, outcome: Outcome) => {
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
      if (controller.driver.containmentReady === false) {
        await emitTerminalResult({ ok: false, errorCode: "origin_containment_unavailable" }, OUTCOME_PREVENTED);
        return;
      }
      if (!controller.driver.isAttachedTo(controller.tabId) && typeof controller.tabId === "number") {
        await controller.driver.attach(controller.tabId);
      }
      const action = command.action ?? {};
      if (action.kind === "__finalize") {
        const disposition = isDisposition(action.disposition) ? action.disposition : null;
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
      await controller.driver.preflightAction?.(action);
      if (action.kind === "__focus") {
        executionStarted = true;
        await tabs.focusTab?.(controller.tabId);
        await emitTerminalResult({ ok: true, result: { focused: true, tabId: controller.tabId } }, OUTCOME_COMPLETED);
        return;
      }
      if (action.kind === "__trusted_fill") {
        executionStarted = true;
        await controller.driver.executeAction({ kind: "fill", target: action.target, value: action.value }, { commandId });
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
      const delta = await controller.driver.executeAction(action, { commandId });
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
      const detail = errorCode(error);
      const stageOutcome = executionStarted
        ? (isUncertainDriverFailure(detail) ? OUTCOME_UNKNOWN : OUTCOME_COMPLETED)
        : OUTCOME_PREVENTED;
      await emitTerminalResult({ ok: false, errorCode: detail }, stageOutcome);
    }
  }

  async function preDispatchFloor(controller: SessionController, action: UnknownRecord) {
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
    if (!isRecord(decision)) return null;
    if (decision.blocked) return { stop: "blocked" as const, decision };
    return { stop: null, decision };
    } catch (error) {
      if (errorCode(error) === "invalid_selector") throw error;
      throw new Error("floor_evaluation_failed");
    }
  }

  function finalizeCurrentCommand(controller: SessionController, disposition: Disposition) {
    return commandShutdown(controller, { disposition });
  }

  function firstController(): SessionController | null {
    for (const controller of sessions.values()) return controller;
    return null;
  }

  function controllerForTab(tabId: number | null | undefined): SessionController | null {
    for (const controller of sessions.values()) {
      if (controller.tabId === tabId) return controller;
    }
    return tabId === undefined ? null : provisioningByTab.get(tabId) ?? null;
  }

  function registerProvisioningController(controller: SessionController, defer: Defer): void {
    if (provisioningByTab.has(controller.tabId)) throw new Error("tab_already_provisioning");
    provisioningByTab.set(controller.tabId, controller);
    defer("private_controller", () => {
      if (provisioningByTab.get(controller.tabId) === controller) provisioningByTab.delete(controller.tabId);
    }, { dedupeKey: `private:${controller.sessionId}` });
  }

  async function liveTabOrigin(tabId: number | null): Promise<string> {
    if (typeof tabId !== "number") return "";
    const tab = await tabs.getTab(tabId).catch(() => null);
    return safeOrigin(tab?.pendingUrl) || safeOrigin(tab?.url);
  }

  async function shutdownController(controller: SessionController, { awaitCurrent = true }: { awaitCurrent?: boolean } = {}) {
    return completeShutdown(controller, { awaitCurrent });
  }

  async function completeShutdown(controller: SessionController, { awaitCurrent = true, disposition = null, notifyState = false }: { awaitCurrent?: boolean; disposition?: Disposition | null; notifyState?: boolean } = {}) {
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

  function prepareShutdown(controller: SessionController, { awaitCurrent = true, notifyState = false }: { awaitCurrent?: boolean; notifyState?: boolean } = {}): ShutdownState {
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

  function stopHostSession(controller: SessionController): Promise<void> {
    if (controller._stopSession) return controller._stopSession;
    const stopping = Promise.resolve()
      .then(() => transport.stopSession(controller.sessionId))
      .then(() => undefined)
      .catch(() => undefined);
    controller._stopSession = stopping;
    return stopping;
  }

  function commandShutdown(controller: SessionController, { disposition = null, notifyState: shouldNotifyState = false }: { disposition?: Disposition | null; notifyState?: boolean } = {}): Promise<ShutdownResult> {
    if (!controller._commandShutdown) {
      const notification: CommandNotificationState = {
        notifyState: Boolean(shouldNotifyState),
        notifiedState: false,
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
        if (notification.notifyState) {
          await notifyState();
          notification.notifiedState = true;
        }
        return shutdownResult;
      })();

      controller._commandShutdown = { notification, promise: commandResult };
    } else if (shouldNotifyState) {
      controller._commandShutdown.notification.notifyState = true;
    }
    return controller._commandShutdown.promise;
  }

  async function enqueueCommand(controller: SessionController, command: unknown) {
    if (!isRecord(command)) return;
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
    if (typeof bytes !== "number" || !Number.isSafeInteger(bytes)) {
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

  function commandEnvelope(command: UnknownRecord): Command | null {
    const commandId = command.commandId;
    const sessionId = command.sessionId;
    if (typeof commandId !== "string" || commandId.length === 0) return null;
    if (typeof sessionId !== "string" || sessionId.length === 0) return null;
    return {
      ...command,
      commandId,
      sessionId,
    };
  }

  async function reportCommandResult(command: Command, details: UnknownRecord, outcome: Outcome) {
    const commandId = command.commandId;
    const sessionEpoch = command.sessionEpoch;
    const sequence = command.sequence;
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

  function validateAndTrackCommandSequence(controller: SessionController, command: Command): SequenceValidation {
    const sessionEpoch = positiveSafeInteger(command.sessionEpoch);
    const sequence = positiveSafeInteger(command.sequence);
    if (sessionEpoch == null || sequence == null) {
      return {
        rejected: true,
        code: INVALID_COMMAND_SEQUENCE_ERROR,
        outcome: OUTCOME_PREVENTED,
      };
    }
    if (typeof controller.sessionEpoch !== "number" || !Number.isSafeInteger(controller.sessionEpoch) || controller.sessionEpoch <= 0) {
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

  function commandByteCount(command: Command): number | null {
    try {
      const json = JSON.stringify(command);
      if (typeof json !== "string") return null;
      return commandByteEncoder.encode(json).byteLength;
    } catch {
      return null;
    }
  }

  function pumpRejectionCode(error: unknown): string {
    if (isRecord(error) && typeof error.code === "string") return error.code;
    const code = isRecord(error) && typeof error.message === "string" ? error.message : "";
    if (code === "invalid_command_size") return "invalid_command_size";
    if (code === "session_queue_full") return "session_queue_full";
    if (code === "session_finalizing") return "session_finalizing";
    return "driver_error";
  }

  return runtime;
}

function groupTitle({ goal, instanceLabel, origin }: { goal?: unknown; instanceLabel?: unknown; origin?: unknown } = {}) {
  const clean = (value: unknown) => String(value ?? "").replace(/\s+/g, " ").trim();
  const cap = (value: string) => (value.length > 28 ? `${value.slice(0, 27)}...` : value);
  const goalText = clean(goal);
  if (goalText) return cap(goalText);
  const label = clean(instanceLabel);
  if (label) return cap(label);
  try {
    const host = new URL(String(origin ?? "")).hostname.replace(/^www\./, "");
    if (host) return cap(host);
  } catch {
    // Ignore non-URL origins.
  }
  return "Newton";
}

function dedupeOrigins(origins: unknown, origin: unknown): string[] {
  const list = Array.isArray(origins) ? origins.map(safeOrigin).filter(Boolean) : [];
  const normalizedOrigin = safeOrigin(origin);
  if (normalizedOrigin && !list.includes(normalizedOrigin)) list.unshift(normalizedOrigin);
  return [...new Set(list)];
}

function safeOrigin(value: unknown): string {
  try {
    const url = new URL(String(value ?? ""));
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : "";
  } catch {
    return "";
  }
}

function deltaToResult(delta: DriverDelta | null | undefined): unknown {
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

function errorCode(error: unknown): string {
  if (isRecord(error) && typeof error.code === "string") return error.code.slice(0, 80);
  const message = errorMessage(error) || "driver_error";
  return message.slice(0, 80).replace(/[^a-z0-9_]+/gi, "_").toLowerCase() || "driver_error";
}

function stageRetrySafe(outcome: Outcome): boolean {
  return outcome === OUTCOME_NOT_STARTED || outcome === OUTCOME_PREVENTED;
}

function requireRuntimeOptions(options: RuntimeOptionsInput): RuntimeOptions {
  const { transport, evaluateFloor, tabs, driverFactory } = options;
  if (!transport) throw new Error("bridge transport is required");
  if (typeof evaluateFloor !== "function") throw new Error("bridge floor evaluator is required");
  if (!tabs) throw new Error("bridge tabs port is required");
  if (typeof driverFactory !== "function") throw new Error("bridge driver factory is required");
  return {
    transport,
    evaluateFloor,
    tabs,
    driverFactory,
    ...(options.notify ? { notify: options.notify } : {}),
    ...(options.themes ? { themes: options.themes } : {}),
  };
}

function isUncertainDriverFailure(code: string): boolean {
  return code === "input_cleanup_failed"
    || code === "renderer_unresponsive"
    || code === "debugger_conflict"
    || code === "target_gone"
    || code.startsWith("cdp_timeout_");
}

function positiveSafeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  if (isRecord(error) && typeof error.message === "string") return error.message;
  return String(error ?? "");
}

function isDisposition(value: unknown): value is Disposition {
  return value === "close" || value === "deliverable" || value === "handoff";
}

function requireTabId(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("invalid_tab_id");
  }
  return value;
}
