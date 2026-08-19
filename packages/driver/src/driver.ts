// Newton Browser strict TypeScript CDP driver. The owned-browser runtime injects
// its private transport; this module has no ambient browser-extension dependency.
//
// Observing and acting are bound to a Newton-owned Chromium target. The private
// CDP transport is injected by the direct session runtime. Observing and
// acting are the same subsystem — an observation is the read half of an action.
//
// Trusted input only: CDP Input dispatches real events that land on SPAs that
// check isTrusted in event-driven applications. The model never gets raw CDP or raw JS;
// every action is funneled through the typed contract.

import { TargetRegistry, TARGET_REGISTRY_ERROR_CODES } from "./target-registry.js";
import { DialogTracker, InputDispatcher } from "./input-dispatcher.js";
import { RendererLiveness } from "./renderer-liveness.js";
import { maskCapturedPng } from "./raster-mask.js";
import type {
  ActiveActionSignals,
  ActionSignalWindow,
  Box,
  BrowserAction,
  BrowserWaitFor,
  BrowserDriverOptions,
  CdpRecord,
  CdpRoute,
  ConsoleEntry,
  ChangeRecord,
  DeltaObservation,
  DebuggerPort,
  DriverAction,
  DriverContext,
  DriverError,
  DriverObservation,
  DriverObservationNode,
  DriverRecord,
  FullObservation,
  NetworkEntry,
  NormalizedTarget,
  NormalizedWait,
  ObserveOptions,
  ObservationNodeSnapshot,
  PendingDialogRoute,
  Point,
  InputDispatchScope,
  InteractiveFilters,
  PageSignature,
  ScreenshotOptions,
  TargetRoute,
  TargetResolution,
  TextObservation,
  Viewport,
  WaitResult,
} from "./types.js";

const CDP_DOMAINS = ["DOM", "Accessibility", "Page", "Runtime", "Network", "Log"];
const CONSOLE_BUFFER_MAX = 500;
const NETWORK_BUFFER_MAX = 500;
const NETWORK_BODY_MAX_CHARS = 512_000;
const ACTIONABLE_ROLES = new Set([
  "button", "link", "textbox", "searchbox", "combobox", "checkbox", "radio", "switch",
  "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "option", "slider", "spinbutton",
  "listbox", "textarea",
]);
const AUTO_WAIT_TIMEOUT_MS = 8000;
const AUTO_WAIT_POLL_MS = 120;
const SETTLE_TIMEOUT_MS = 4000;
const NODE_CAP = 80;
// Readable-text observation defaults. The DOM expression prefers main/article
// content and falls back to body innerText; it reads nothing outside the live document.
const TEXT_OBSERVE_CHAR_CAP = 20_000;
const TEXT_OBSERVE_EXPRESSION =
  "(function(){var m=document.querySelector('main,article,[role=\"main\"]');var el=m||document.body;return (el&&el.innerText)||(document.body&&document.body.innerText)||'';})()";
const MAX_SHOT_PX = 20000;            // bound an explicit-clip capture (D5)
const CDP_TIMEOUT_MS = 20000;         // bound each CDP call so a hang can't wedge the pump
const SCROLL_DISPATCH_TIMEOUT_MS = 2000; // scroll verifies page state even if Chrome drops the wheel acknowledgement
const OWNED_ROOT_INPUT_TIMEOUT_MS = 2000; // Chromium can omit release ACK when a click synchronously creates a target.
const FULLPAGE_MAX_PX = 6000;         // cap full-page height so capture stays practical
const FULLPAGE_MAX_WIDTH = 1440;      // downscale wide full-page captures
const MASK_REGION_PADDING_CSS = 3;
const INITIAL_NAVIGATION_COMMIT_CAP = 32;
const CHILD_TARGET_FILTER = [
  { type: "iframe", exclude: false },
  { type: "worker", exclude: false },
  { type: "shared_worker", exclude: false },
  { type: "service_worker", exclude: false },
  { exclude: true },
];
const OWNED_BROWSER_TARGET_FILTER = [
  { type: "page", exclude: false },
  { exclude: true },
];
const PRESERVED_ATTACH_FAILURE_CODES = new Set<string>([
  ...Object.values(TARGET_REGISTRY_ERROR_CODES),
  "browser_control_unavailable",
  "browser_control_failed",
  "debugger_conflict",
  "shutdown_detach_failed",
  "renderer_unresponsive",
]);

type IframeOwnerRoute = Readonly<{ targetId: string; sessionId: string | null; frameId: string }>;
type IframeOwnerGeometry = Readonly<{
  x: number;
  y: number;
  viewportWidth: number;
  viewportHeight: number;
}>;
type PreparedEmbeddingFrames = Readonly<{
  routes: ReadonlyArray<IframeOwnerRoute>;
  geometries: ReadonlyArray<IframeOwnerGeometry>;
}>;
type FramedPointProof = Readonly<{
  targetId: string;
  frameId: string;
  sessionId: string | null;
  point: Point;
  frames: PreparedEmbeddingFrames;
}>;
type DriverObserveOptions = ObserveOptions;
type InitialNavigationCommit = Readonly<{ frameId: string; loaderId: string; url: string; origin: string }>;
type InitialNavigationState = {
  generation: number;
  expectedFrameId: string | null;
  expectedLoaderId: string | null;
  commits: InitialNavigationCommit[];
  commitOverflow: boolean;
  commitResolved: boolean;
  resolve(value: InitialNavigationCommit): void;
  reject(error: unknown): void;
  promise: Promise<InitialNavigationCommit>;
  timer: ReturnType<typeof setTimeout>;
};

export function createNewtonBrowserDriver(options: BrowserDriverOptions) {
  return new NewtonBrowserDriver(options);
}

class NewtonBrowserDriver {
  attached: boolean;
  refIndex: Map<string, TargetRoute>;
  devicePixelRatio: number;
  zoom: number;
  lastNodes: Map<string, ObservationNodeSnapshot>;
  lastObserveUrl: string | null;
  lastScrollY: number;
  nodeFactsCache: Map<string, CdpRecord>;
  activeActionSignals: ActiveActionSignals | null;
  pendingDialog: CdpRecord | null;
  pendingDialogRoute: PendingDialogRoute | null;
  pendingDialogs: Map<string, CdpRecord>;
  sessionViewport: Viewport | null;
  consoleBuffer: ConsoleEntry[];
  consoleDropped: number;
  networkBuffer: Map<string, NetworkEntry>;
  networkDropped: number;
  networkInFlight: Set<string>;
  targetRegistry: TargetRegistry;
  mainTargetId: string | null;
  mainFrameId: string | null;
  mainLoaderId: string | null;
  actionabilityFailure: string | null;
  framedPointProof: FramedPointProof | null;
  browserControlReady: boolean;
  inputDispatcher: InputDispatcher;
  dialogTracker: DialogTracker;
  rendererLiveness: RendererLiveness;
  livenessEpoch: number;
  activeCommandId: string | null;
  browserControlSessionId: string | null;
  browserRootSessionId: string | null;
  browserPageAutoAttachActive: boolean;
  protocolEventTail: Promise<void>;
  protocolGeneration: number;
  protocolEventFailure: unknown | null;
  activeCommandKind: DriverAction["kind"] | null;
  initialNavigation: InitialNavigationState | null;
  closing: boolean;
  relationshipCleanupComplete: boolean;
  debuggerPort: DebuggerPort;
  debuggerEventUnsubscribe: (() => void) | null;

  constructor(options: BrowserDriverOptions) {
    this.attached = false;
    this.refIndex = new Map(); // ref -> immutable target route
    this.devicePixelRatio = 1;
    this.zoom = 1;
    // Diff-delta state: baseline of the last full observation
    // and caches that cut per-action CDP round-trips.
    this.lastNodes = new Map(); // ref -> { role, name, value, bbox }
    this.lastObserveUrl = null;
    this.lastScrollY = 0;
    this.nodeFactsCache = new Map();
    this.activeActionSignals = null;
    // A page-initiated JS dialog blocking the renderer, or null. Set on
    // Page.javascriptDialogOpening and cleared when handled/closed.
    this.pendingDialog = null;
    this.pendingDialogRoute = null;
    this.pendingDialogs = new Map();
    // Viewport override requested via `resize`, or null. Re-applied
    // after a debugger re-attach so a cross-process navigation does not silently
    // revert the caller's chosen size.
    this.sessionViewport = null;
    // Read-only console and network ring buffers. Populated from CDP
    // events; bounded so a chatty page cannot grow them without bound. `dropped`
    // counts entries evicted since the last read. Network HEADERS are never buffered.
    this.consoleBuffer = [];
    this.consoleDropped = 0;
    this.networkBuffer = new Map(); // requestId -> entry (insertion-ordered)
    this.networkDropped = 0;
    this.networkInFlight = new Set();
    this.targetRegistry = new TargetRegistry();
    this.mainTargetId = null;
    this.mainFrameId = null;
    this.mainLoaderId = null;
    this.actionabilityFailure = null;
    this.framedPointProof = null;
    this.browserControlReady = false;
    this.inputDispatcher = new InputDispatcher((method: string, params: CdpRecord, route: CdpRoute) => this.cdp(method, params, route));
    this.dialogTracker = new DialogTracker();
    this.rendererLiveness = new RendererLiveness();
    this.livenessEpoch = 1;
    this.rendererLiveness.register("root", this.livenessEpoch);
    this.activeCommandId = null;
    this.browserControlSessionId = null;
    this.browserRootSessionId = null;
    this.browserPageAutoAttachActive = false;
    this.protocolEventTail = Promise.resolve();
    this.protocolGeneration = 0;
    this.protocolEventFailure = null;
    this.activeCommandKind = null;
    this.initialNavigation = null;
    this.closing = false;
    this.relationshipCleanupComplete = false;
    this.debuggerPort = options.debuggerPort;
    this.debuggerEventUnsubscribe = null;
  }

  async attach(): Promise<void> {
    if (this.attached) return;
    this.protocolGeneration += 1;
    try {
      await attachStage("root_debugger_attach_failed", async () => {
        this.subscribeDebuggerEvents();
        await this.debuggerPort.attach();
      });
    } catch (error) {
      this.protocolGeneration += 1;
      this.unsubscribeDebuggerEvents();
      this.protocolEventTail = Promise.resolve();
      this.protocolEventFailure = null;
      throw error;
    }
    this.attached = true;
    this.relationshipCleanupComplete = false;
    this.protocolEventFailure = null;
    try {
      await attachStage("root_protocol_setup_failed", async () => {
        await this.initializeTargetRegistry();
        for (const domain of CDP_DOMAINS) {
          await this.cdp(`${domain}.enable`, {});
        }
      });
    // Child frames / popups attach to the same session (§7.5).
      const browserAttachResult = await attachStage("browser_control_attach_failed", () => this.cdp("Target.attachToBrowserTarget", {}));
      const browserSessionId = typeof browserAttachResult.sessionId === "string" && browserAttachResult.sessionId
        ? browserAttachResult.sessionId
        : null;
      if (!browserSessionId || !this.mainTargetId) throw typedDriverError("browser_control_unavailable");
      this.browserControlSessionId = browserSessionId;
      await attachStage("browser_page_autoattach_failed", () => this.cdp("Target.setAutoAttach", {
          autoAttach: true,
          flatten: true,
          waitForDebuggerOnStart: false,
          filter: OWNED_BROWSER_TARGET_FILTER,
        }, { sessionId: browserSessionId }));
      this.browserPageAutoAttachActive = true;
      await this.fenceBrowserProtocolEvents("browser_control_fence_failed");
      await attachStage("root_autoattach_failed", () => this.cdp("Target.setAutoAttach", {
        autoAttach: true,
        flatten: true,
        waitForDebuggerOnStart: false,
        filter: CHILD_TARGET_FILTER,
      }));
      await attachStage("calibration_failed", () => this.calibrate());
    // Re-apply a caller-chosen viewport that a re-attach would otherwise drop.
      if (this.sessionViewport) {
        await this.cdp("Emulation.setDeviceMetricsOverride", { width: this.sessionViewport.width, height: this.sessionViewport.height, deviceScaleFactor: 1, mobile: false }).catch(() => {});
      }
      this.browserControlReady = true;
      this.reconcileRenderer("root");
    } catch (error) {
      await this.detach();
      throw error;
    }
  }

  async detach(): Promise<void> {
    if (!this.attached) return;
    this.closing = true;
    this.browserControlReady = false;
    this.rejectInitialNavigation(typedDriverError("debugger_conflict"));
    if (!this.relationshipCleanupComplete) {
      const browserControlSessionId = this.browserControlSessionId;
      try {
        await this.drainProtocolEventQueue();
        if (browserControlSessionId && this.mainTargetId) {
          await this.cdp("Target.getTargetInfo", { targetId: this.mainTargetId }, { sessionId: browserControlSessionId });
          await this.drainProtocolEventQueue();
          if (this.browserPageAutoAttachActive) {
            await this.cdp("Target.setAutoAttach", {
              autoAttach: false,
              flatten: true,
              waitForDebuggerOnStart: false,
            }, { sessionId: browserControlSessionId });
          }
          await this.drainProtocolEventQueue();
          await this.cdp("Target.detachFromTarget", { sessionId: browserControlSessionId });
        }
      } catch {
        throw this.browserControlFailure("browser_control_cleanup_failed");
      }
      this.relationshipCleanupComplete = true;
      this.protocolGeneration += 1;
      this.browserControlSessionId = null;
      this.browserRootSessionId = null;
      this.browserPageAutoAttachActive = false;
    }
    try {
      await this.debuggerPort.detach();
    } catch {
      throw typedDriverError("shutdown_detach_failed");
    }
    this.unsubscribeDebuggerEvents();
    this.activeCommandKind = null;
    this.attached = false;
    this.refIndex.clear();
    this.targetRegistry = new TargetRegistry();
    this.mainTargetId = null;
    this.mainFrameId = null;
    this.mainLoaderId = null;
    this.browserControlReady = false;
    this.networkInFlight.clear();
    this.pendingDialogs.clear();
    this.pendingDialog = null;
    this.pendingDialogRoute = null;
    this.dialogTracker = new DialogTracker();
    this.protocolEventTail = Promise.resolve();
    this.protocolEventFailure = null;
    this.closing = false;
    this.relationshipCleanupComplete = false;
    this.browserPageAutoAttachActive = false;
    this.rendererLiveness.remove("root", "driver_detached");
  }

  // Chrome detached the debugger underneath us (e.g. a cross-process navigation
  // closed the old target). Clear the stale in-memory flag so a follow-up
  // attach() actually re-establishes the CDP session instead of no-op'ing. We do
  // Do not call the injected detach transport here: Chromium already detached it.
  markDetached(reason = "debugger_detached"): void {
    this.unsubscribeDebuggerEvents();
    this.failRenderer("root", "debugger_detached", reason);
    this.attached = false;
    this.protocolGeneration += 1;
    this.browserControlSessionId = null;
    this.browserRootSessionId = null;
    this.browserPageAutoAttachActive = false;
    this.activeCommandKind = null;
    this.rejectInitialNavigation(typedDriverError("debugger_conflict"));
    this.protocolEventTail = Promise.resolve();
    this.protocolEventFailure = null;
    this.closing = false;
    this.relationshipCleanupComplete = false;
    this.refIndex.clear();
    this.targetRegistry = new TargetRegistry();
    this.mainTargetId = null;
    this.mainFrameId = null;
    this.mainLoaderId = null;
    this.browserControlReady = false;
    this.networkInFlight.clear();
    this.pendingDialogs.clear();
    this.pendingDialog = null;
    this.pendingDialogRoute = null;
    this.dialogTracker = new DialogTracker();
  }

  ensureRenderer(targetKey: string): NonNullable<ReturnType<RendererLiveness["snapshot"]>> {
    const existing = this.rendererLiveness.snapshot(targetKey);
    if (existing) return existing;
    return this.rendererLiveness.register(targetKey, this.livenessEpoch)!;
  }

  failRenderer(targetKey: string, state: string, detail?: string): NonNullable<ReturnType<RendererLiveness["snapshot"]>> {
    const snapshot = this.ensureRenderer(targetKey);
    if (snapshot.state === state || snapshot.state === "terminal") return snapshot;
    try {
      return this.rendererLiveness.transition(targetKey, state, { epoch: snapshot.epoch, ...(detail !== undefined ? { detail } : {}) })!;
    } catch {
      return snapshot;
    }
  }

  reconcileRenderer(targetKey: string): NonNullable<ReturnType<RendererLiveness["snapshot"]>> {
    let snapshot = this.ensureRenderer(targetKey);
    if (snapshot.state === "healthy") return snapshot;
    try {
      if (snapshot.state !== "reconciling") {
        snapshot = this.rendererLiveness.transition(targetKey, "reconciling", { epoch: snapshot.epoch })!;
      }
      return this.rendererLiveness.transition(targetKey, "healthy", { epoch: snapshot.epoch })!;
    } catch {
      this.livenessEpoch += 1;
      return this.rendererLiveness.register(targetKey, this.livenessEpoch)!;
    }
  }

  assertRendererLive(targetKey: string, actionKind: string): void {
    const snapshot = this.ensureRenderer(targetKey);
    if (snapshot.state === "healthy" || snapshot.state === "reconciling") return;
    if (snapshot.state === "dialog_blocked" && (actionKind === "dialog_accept" || actionKind === "dialog_dismiss")) return;
    const code = snapshot.state === "discarded" ? "discarded"
      : snapshot.state === "debugger_detached" ? "debugger_conflict"
        : snapshot.state === "target_gone" || snapshot.state === "terminal" ? "target_gone"
          : snapshot.state === "dialog_blocked" ? "dialog_blocked" : "renderer_unresponsive";
    throw typedDriverError(code);
  }

  markDiscarded(): NonNullable<ReturnType<RendererLiveness["snapshot"]>> {
    return this.failRenderer("root", "discarded", "tab_discarded");
  }

  markTargetGone(targetKey = "root"): NonNullable<ReturnType<RendererLiveness["snapshot"]>> {
    return this.failRenderer(targetKey, "target_gone", "target_removed");
  }

  async dispatchInput<T>(
    route: TargetRoute,
    operation: (input: InputDispatchScope) => Promise<T>,
    mode: "root" | "target" = "root",
  ): Promise<T> {
    if (mode === "target" && !route.sessionId) throw typedDriverError("stale_target");
    const targetKey = inputTargetKey(route);
    this.ensureRenderer(targetKey);
    const inputRoute: CdpRoute = mode === "target"
      ? {
          ...(route.sessionId ? { sessionId: route.sessionId } : {}),
          ...(typeof route.timeoutMs === "number" ? { timeoutMs: route.timeoutMs } : {}),
        }
      : route.sessionId || route.frameId
        ? { ...(typeof route.timeoutMs === "number" ? { timeoutMs: route.timeoutMs } : {}) }
        : route;
    const result = await this.dialogTracker.race(targetKey, this.activeCommandId, () => this.inputDispatcher.run(inputRoute, operation));
    if (result.kind === "dialog") throw typedDriverError("dialog_blocked");
    return result.value;
  }

  recordDebuggerEvent(sourceOrMethod: CdpRecord | string, methodOrParams: CdpRecord | string = {}, eventParams: CdpRecord = {}): Promise<void> {
    const source = typeof sourceOrMethod === "string" ? {} : sourceOrMethod ?? {};
    const method = typeof sourceOrMethod === "string" ? sourceOrMethod : String(methodOrParams);
    const params: CdpRecord = typeof sourceOrMethod === "string" && typeof methodOrParams !== "string" ? methodOrParams : eventParams;
    const authenticatedAtReceipt = this.isAuthenticatedEventSource(source);
    if (authenticatedAtReceipt) this.recordDebuggerSideEffects(source, method, params);
    const generation = this.protocolGeneration;
    const work = this.protocolEventTail.then(async () => {
      if (generation !== this.protocolGeneration) return;
      await this.recordTargetEventNow(source, method, params);
      if (!authenticatedAtReceipt && this.isAuthenticatedEventSource(source)) {
        this.recordDebuggerSideEffects(source, method, params);
      }
    });
    this.protocolEventTail = work.catch((error: unknown) => {
      if (generation === this.protocolGeneration) this.protocolEventFailure = error;
    });
    return work;
  }

  isAuthenticatedEventSource(source: CdpRecord): boolean {
    const sessionId = typeof source?.sessionId === "string" && source.sessionId ? source.sessionId : null;
    if (!sessionId) return true;
    return sessionId === this.browserControlSessionId
      || sessionId === this.browserRootSessionId
      || Boolean(this.targetRegistry.targetForSession(sessionId));
  }

  recordDebuggerSideEffects(source: CdpRecord, method: string, params: CdpRecord): void {
    this.noteInitialNavigationEvent(source, method, params);
    // Dialog open/close is tracked persistently (not just inside an action window)
    // because a JS dialog blocks the renderer until it is handled.
    if (method === "Page.javascriptDialogOpening") {
      const targetKey = inputTargetKey(source);
      const dialog = this.dialogTracker.open(targetKey, params);
      this.pendingDialogs.delete(targetKey);
      this.pendingDialogs.set(targetKey, { dialog, route: { targetKey, ...(source?.sessionId ? { sessionId: source.sessionId } : {}) } });
      this.refreshPendingDialog();
      this.failRenderer(targetKey, "dialog_blocked", dialog.dialogType);
    }
    if (method === "Page.javascriptDialogClosed") {
      const targetKey = inputTargetKey(source);
      this.dialogTracker.close(targetKey);
      this.pendingDialogs.delete(targetKey);
      this.refreshPendingDialog();
      this.reconcileRenderer(targetKey);
    }
    // Console ring buffer.
    if (method === "Runtime.consoleAPICalled") {
      this.pushConsole({ level: consoleLevelFor(params?.type), text: consoleArgsText(params?.args), at: new Date().toISOString() });
    }
    if (method === "Runtime.exceptionThrown") {
      const detail = params?.exceptionDetails;
      this.pushConsole({ level: "error", text: detail?.exception?.description || detail?.text || "Uncaught exception", source: "exception", at: new Date().toISOString() });
    }
    if (method === "Log.entryAdded" && params?.entry) {
      this.pushConsole({ level: consoleLevelFor(params.entry.level), text: String(params.entry.text ?? ""), source: params.entry.source, at: new Date().toISOString() });
    }
    // Network ring buffer — metadata only, never headers.
    if (method === "Network.requestWillBeSent" && params?.requestId) {
      while (this.networkInFlight.size >= NETWORK_BUFFER_MAX) {
        const oldest = this.networkInFlight.values().next().value;
        if (typeof oldest === "string") this.networkInFlight.delete(oldest);
      }
      this.networkInFlight.add(String(params.requestId));
      const networkEntry: NetworkEntry = { requestId: params.requestId, method: String(params.request?.method ?? "GET"), url: String(params.request?.url ?? ""), resourceType: params.type, at: new Date().toISOString() };
      this.pushNetwork(params.requestId, networkEntry);
    }
    if (method === "Network.responseReceived" && params?.requestId) {
      this.updateNetwork(params.requestId, { status: params.response?.status, mimeType: params.response?.mimeType, resourceType: params.type });
    }
    if (method === "Network.loadingFinished" && params?.requestId) {
      this.networkInFlight.delete(String(params.requestId));
      this.updateNetwork(params.requestId, { bytes: params.encodedDataLength });
    }
    if (method === "Network.loadingFailed" && params?.requestId) {
      this.networkInFlight.delete(String(params.requestId));
      this.updateNetwork(params.requestId, { failed: true });
    }
    const signals = this.activeActionSignals;
    if (!signals) return;
    if (method === "Page.frameNavigated" && params?.frame && !params.frame.parentId) {
      signals.navigation = true;
    }
    if (method === "Page.javascriptDialogOpening") {
      signals.dialog = true;
    }
    if (method === "Page.downloadWillBegin" || method === "Browser.downloadWillBegin") {
      signals.download = true;
    }
    if (method === "Target.targetCreated" && params?.targetInfo?.type === "page") {
      signals.newTarget = true;
    }
  }

  subscribeDebuggerEvents(): void {
    if (this.debuggerEventUnsubscribe || !this.debuggerPort.onDebuggerEvent) return;
    this.debuggerEventUnsubscribe = this.debuggerPort.onDebuggerEvent((source, method, params) =>
      this.recordDebuggerEvent(source, method, params));
  }

  unsubscribeDebuggerEvents(): void {
    const unsubscribe = this.debuggerEventUnsubscribe;
    if (!unsubscribe) return;
    this.debuggerEventUnsubscribe = null;
    try {
      unsubscribe();
    } catch {
      // Debugger ownership is already terminal; a faulty observer cleanup cannot
      // turn a confirmed browser detach into an uncertain detach.
    }
  }

  cdp(method: string, params: CdpRecord = {}, routeOrTimeout: CdpRoute | number = {}): Promise<CdpRecord> {
    const timeoutMs = typeof routeOrTimeout === "number"
      ? routeOrTimeout
      : routeOrTimeout?.timeoutMs ?? CDP_TIMEOUT_MS;
    const sessionId = typeof routeOrTimeout === "object" ? routeOrTimeout?.sessionId : null;
    return new Promise((resolve, reject) => {
      // Bound every CDP call: the debugger transport can hang indefinitely
      // (e.g. Page.captureScreenshot under device emulation on some pages). The
      // per-session command pump awaits each call, so one hung call would wedge
      // the whole session. A timeout turns a hang into a recoverable error.
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.failRenderer(inputTargetKey(routeOrTimeout), "unresponsive", `cdp_timeout_${method}`);
        const error = typedDriverError("renderer_unresponsive");
        error.detail = `cdp_timeout_${method}`;
        reject(error);
      }, timeoutMs);
      const debuggee = sessionId ? { sessionId } : {};
      this.debuggerPort.sendCommand(debuggee, method, params).then((result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result ?? {});
      }, (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  async initializeTargetRegistry(): Promise<void> {
    this.targetRegistry = new TargetRegistry();
    const response = await this.cdp("Target.getTargetInfo", {}).catch(() => null);
    const info = response?.targetInfo;
    const targetId = typeof info?.targetId === "string" && info.targetId ? info.targetId : null;
    if (!targetId) throw typedDriverError("browser_control_unavailable");
    this.mainTargetId = targetId;
    this.targetRegistry.registerTarget({
      targetId,
      type: "page",
      origin: safeOrigin(info?.url),
    });
    this.targetRegistry.commitTopLevelDocument(targetId);
  }

  recordTargetEvent(source: CdpRecord, method: string, params: CdpRecord): Promise<void> {
    const generation = this.protocolGeneration;
    const work = this.protocolEventTail.then(async () => {
      if (generation !== this.protocolGeneration) return;
      await this.recordTargetEventNow(source, method, params);
    });
    this.protocolEventTail = work.catch((error: unknown) => {
      if (generation === this.protocolGeneration) this.protocolEventFailure = error;
    });
    return work;
  }

  async recordTargetEventNow(source: CdpRecord, method: string, params: CdpRecord): Promise<void> {
    const sourceSessionId = typeof source?.sessionId === "string" ? source.sessionId : null;
    if (method !== "Target.attachedToTarget" && sourceSessionId && !this.isAuthenticatedEventSource(source)) return;
    if (method === "Target.attachedToTarget" && params?.targetInfo && typeof params.sessionId === "string") {
      const info = params.targetInfo;
      if (!["page", "iframe", "worker", "shared_worker", "service_worker"].includes(info.type)) return;
      const type = info.type === "shared_worker" || info.type === "service_worker" ? "worker" : info.type;
      const targetId = String(info.targetId ?? "");
      if (!targetId) return;
      const fromBrowserControl = sourceSessionId !== null && sourceSessionId === this.browserControlSessionId;
      if (fromBrowserControl && targetId === this.mainTargetId) {
        this.browserRootSessionId = params.sessionId;
        if (params.waitingForDebugger === true) {
          await this.cdp("Runtime.runIfWaitingForDebugger", {}, { sessionId: params.sessionId });
        }
        return;
      }
      if (type === "page" && !fromBrowserControl) return;
      if (fromBrowserControl && type !== "page") return;
      if (sourceSessionId && !fromBrowserControl && !this.targetRegistry.targetForSession(sourceSessionId)) return;
      const sourceTarget = sourceSessionId ? this.targetRegistry.targetForSession(sourceSessionId) : null;
      const parentTargetId = type === "page"
        ? (typeof info.openerId === "string" ? info.openerId : null)
        : type === "iframe" || type === "worker" ? (sourceTarget?.targetId ?? this.mainTargetId) : null;
      const hostFrameId = type === "iframe"
        ? (typeof info.openerFrameId === "string" ? info.openerFrameId : targetId)
        : null;
      try {
        this.targetRegistry.registerTarget({
          targetId,
          type,
          ...(parentTargetId ? { parentTargetId } : {}),
          ...(hostFrameId ? { hostFrameId } : {}),
          sessionId: params.sessionId,
          origin: safeOrigin(info.url),
        });
        await this.cdp(
          "Target.setAutoAttach",
          { autoAttach: true, flatten: true, waitForDebuggerOnStart: false, filter: CHILD_TARGET_FILTER },
          { sessionId: params.sessionId },
        );
        const domains = type === "worker"
          ? ["Runtime", "Network", "Log"]
          : type === "page" ? ["Page", "Runtime", "Network", "Log"] : CDP_DOMAINS;
        for (const domain of domains) await this.cdp(`${domain}.enable`, {}, { sessionId: params.sessionId });
        if (params.waitingForDebugger === true) {
          await this.cdp("Runtime.runIfWaitingForDebugger", {}, { sessionId: params.sessionId });
        }
      } catch (error) {
        if (params.waitingForDebugger !== true && this.browserControlSessionId) {
          // Short-lived frames and workers can disappear while their optional
          // observation domains are enabled. Retire the transient route without
          // affecting the main page; a later attachment is a fresh route.
          try {
            await this.cdp(
              "Target.detachFromTarget",
              { sessionId: params.sessionId },
              { sessionId: this.browserControlSessionId },
            );
          } catch { /* the transient session may already be gone */ }
          try { this.targetRegistry.detachTarget(targetId, params.sessionId); } catch { /* already retired */ }
          return;
        }
        throw error;
      }
      return;
    }
    if (method === "Target.targetInfoChanged" && params?.targetInfo?.targetId) {
      const existing = this.targetRegistry.targetForSession(sourceSessionId ?? "");
      if (existing && existing.targetId === params.targetInfo.targetId) {
        this.targetRegistry.registerTarget({
          targetId: existing.targetId,
          type: existing.type,
          ...(existing.parentTargetId ? { parentTargetId: existing.parentTargetId } : {}),
          ...(existing.hostFrameId ? { hostFrameId: existing.hostFrameId } : {}),
          ...(existing.sessionId ? { sessionId: existing.sessionId } : {}),
          origin: safeOrigin(params.targetInfo.url),
        });
      }
      return;
    }
    if (method === "Target.detachedFromTarget") {
      if (typeof params?.sessionId === "string" && params.sessionId === this.browserControlSessionId) {
        this.browserControlSessionId = null;
        this.browserRootSessionId = null;
        this.browserPageAutoAttachActive = false;
        this.browserControlReady = false;
        this.protocolEventFailure = typedDriverError("browser_control_failed");
        return;
      }
      if (sourceSessionId === this.browserControlSessionId && params?.sessionId === this.browserRootSessionId) {
        this.browserRootSessionId = null;
        return;
      }
      const target = typeof params?.sessionId === "string"
        ? this.targetRegistry.targetForSession(params.sessionId)
        : undefined;
      const targetId = typeof params?.targetId === "string" ? params.targetId : target?.targetId;
      if (targetId) {
        this.targetRegistry.detachTarget(
          targetId,
          typeof params?.sessionId === "string" ? params.sessionId : undefined,
        );
      }
      return;
    }
    if (method === "Page.frameDetached" && typeof params?.frameId === "string") {
      const sourceTarget = sourceSessionId
        ? this.targetRegistry.targetForSession(sourceSessionId)
        : this.mainTargetId ? { targetId: this.mainTargetId } : undefined;
      if (params.reason === "swap" && sourceTarget?.targetId) {
        this.targetRegistry.beginFrameSwap(params.frameId, sourceTarget.targetId);
      } else {
        this.targetRegistry.detachFrame(params.frameId);
      }
      return;
    }
    if (method !== "Page.frameNavigated" || !params?.frame || typeof params.frame.id !== "string") return;
    const frame = params.frame;
    if (!frame.parentId && !sourceSessionId) {
      if (!this.mainTargetId) return;
      this.reconcileTopLevelDocument(frame, safeOrigin(frame.url), true);
      return;
    }
    const target = sourceSessionId
      ? this.targetRegistry.targetForSession(sourceSessionId)
      : this.mainTargetId ? { targetId: this.mainTargetId } : undefined;
    if (!target?.targetId) return;
    if ("type" in target && target.type === "page" && target.targetId !== this.mainTargetId) return;
    const parentFrameId = typeof frame.parentId === "string" ? frame.parentId : null;
    const hostFrameId = "hostFrameId" in target ? target.hostFrameId : null;
    const parentRoute = parentFrameId
      ? this.targetRegistry.listObservationRoutes().find((route) => route.frameId === parentFrameId)
      : undefined;
    // The root frame reported inside a flattened OOPIF session retains the
    // embedding frame as its CDP parent. That parent belongs to the ancestor
    // target, so expressing it as an intra-target frame edge creates a false
    // cross-target cycle/conflict. The target's hostFrameId already preserves
    // the boundary; nested frames inside the OOPIF keep their local parent.
    const crossesTargetBoundary = sourceSessionId && (
      parentFrameId === hostFrameId
      || (parentRoute && parentRoute.targetId !== target.targetId)
    );
    const localParentFrameId = crossesTargetBoundary || parentFrameId === this.mainFrameId
      ? null
      : parentFrameId;
    this.targetRegistry.reconcileOopifFrame({
      frameId: frame.id,
      targetId: target.targetId,
      ...(localParentFrameId ? { parentFrameId: localParentFrameId } : {}),
      origin: safeOrigin(frame.url),
    });
  }

  async drainProtocolEventQueue(): Promise<void> {
    while (true) {
      const tail = this.protocolEventTail;
      await tail;
      if (tail === this.protocolEventTail) return;
    }
  }

  async fenceBrowserProtocolEvents(attachFailureCode: string | null = null): Promise<void> {
    const sessionId = this.browserControlSessionId;
    if (this.protocolEventFailure) {
      if (isPreservedAttachFailure(this.protocolEventFailure)) throw this.protocolEventFailure;
      throw this.browserControlFailure("browser_protocol_event_failed");
    }
    if (!sessionId || !this.mainTargetId) {
      if (this.browserControlReady) {
        throw this.browserControlFailure("browser_control_session_missing");
      }
      return;
    }
    try {
      await this.cdp("Target.getTargetInfo", { targetId: this.mainTargetId });
      await this.drainProtocolEventQueue();
      await this.cdp("Target.getTargetInfo", { targetId: this.mainTargetId }, { sessionId });
      while (true) {
        const tail = this.protocolEventTail;
        await tail;
        if (this.protocolEventFailure) throw this.protocolEventFailure;
        if (tail === this.protocolEventTail) return;
      }
    } catch (error) {
      if (isPreservedAttachFailure(error)) throw error;
      if (attachFailureCode && !isPreservedAttachFailure(error)) {
        this.browserControlReady = false;
        throw typedDriverError(attachFailureCode);
      }
      throw this.browserControlFailure("browser_protocol_fence_failed");
    }
  }

  browserControlFailure(detail: string): DriverError {
    this.browserControlReady = false;
    const error = typedDriverError("browser_control_failed");
    error.detail = detail;
    return error;
  }

  async navigateInitial(url: string): Promise<InitialNavigationCommit> {
    if (!this.attached || !this.browserControlReady) {
      throw typedDriverError("browser_control_unavailable");
    }
    requireHttpNavigationUrl(url);
    if (this.initialNavigation) throw typedDriverError("initial_navigation_conflict");
    const browserSessionId = this.browserControlSessionId;

    let resolve!: (value: InitialNavigationCommit) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<InitialNavigationCommit>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    void promise.catch(() => {});
    const state: InitialNavigationState = {
      generation: this.protocolGeneration,
      expectedFrameId: null,
      expectedLoaderId: null,
      commits: [],
      commitOverflow: false,
      commitResolved: false,
      resolve,
      reject,
      promise,
      timer: setTimeout(() => {
        if (this.initialNavigation === state) {
          this.initialNavigation = null;
          reject(typedDriverError("initial_navigation_uncommitted"));
        }
      }, CDP_TIMEOUT_MS),
    };
    this.initialNavigation = state;
    try {
      const response = await this.cdp("Page.navigate", { url });
      if (typeof response.errorText === "string" && response.errorText) throw typedDriverError("initial_navigation_failed");
      if (response.isDownload === true) throw typedDriverError("initial_navigation_download");
      if (typeof response.frameId !== "string" || !response.frameId) throw typedDriverError("initial_navigation_uncommitted");
      if (typeof response.loaderId !== "string" || !response.loaderId) throw typedDriverError("initial_navigation_uncommitted");
      state.expectedFrameId = response.frameId;
      state.expectedLoaderId = response.loaderId;
      this.reconcileInitialNavigation(state);
      const commit = await promise;
      if (state.generation !== this.protocolGeneration || !this.attached) throw typedDriverError("debugger_conflict");
      await this.fenceBrowserProtocolEvents();
      if (
        state.generation !== this.protocolGeneration
        || !this.attached
        || !this.browserControlReady
        || !browserSessionId
        || this.browserControlSessionId !== browserSessionId
      ) throw typedDriverError("debugger_conflict");
      if (state.commitOverflow) throw typedDriverError("initial_navigation_event_overflow");
      return commit;
    } catch (error) {
      if (this.initialNavigation === state) {
        this.initialNavigation = null;
        clearTimeout(state.timer);
      }
      throw error;
    } finally {
      if (this.initialNavigation === state) this.initialNavigation = null;
      clearTimeout(state.timer);
    }
  }

  noteInitialNavigationEvent(source: CdpRecord, method: string, params: CdpRecord): void {
    const state = this.initialNavigation;
    if (!state || state.generation !== this.protocolGeneration) return;
    if (source?.sessionId || method !== "Page.frameNavigated" || params?.frame?.parentId) return;
    const frame = params?.frame;
    if (typeof frame?.id !== "string" || typeof frame?.loaderId !== "string" || typeof frame?.url !== "string") return;
    if (state.commits.length >= INITIAL_NAVIGATION_COMMIT_CAP) {
      state.commitOverflow = true;
    } else {
      state.commits.push({ frameId: frame.id, loaderId: frame.loaderId, url: frame.url, origin: safeOrigin(frame.url) });
    }
    this.reconcileInitialNavigation(state);
  }

  reconcileInitialNavigation(state: InitialNavigationState): void {
    if (this.initialNavigation !== state || !state.expectedFrameId || !state.expectedLoaderId) return;
    if (state.commitOverflow) {
      if (state.commitResolved) return;
      this.initialNavigation = null;
      clearTimeout(state.timer);
      state.reject(typedDriverError("initial_navigation_event_overflow"));
      return;
    }
    const commit = state.commits.find((candidate) =>
      candidate.frameId === state.expectedFrameId && candidate.loaderId === state.expectedLoaderId);
    if (!commit) return;
    clearTimeout(state.timer);
    if (!state.commitResolved) {
      state.commitResolved = true;
      state.resolve(commit);
    }
  }

  rejectInitialNavigation(error: unknown): void {
    const state = this.initialNavigation;
    if (!state) return;
    this.initialNavigation = null;
    clearTimeout(state.timer);
    state.reject(error);
  }

  preflightAction(action: DriverAction): Promise<void> | void {
    if (!this.browserControlReady) throw typedDriverError("browser_control_unavailable");
    if (action?.kind === "navigate") requireHttpNavigationUrl(action.url);
    const selector = selectorFromAction(action);
    if (selector) return this.validateSelector(selector);
  }

  async validateSelector(selector: string): Promise<void> {
    const result = await this.cdp("Runtime.evaluate", {
      expression: `document.querySelector(${JSON.stringify(selector)}), true`,
      returnByValue: true,
      awaitPromise: false,
    });
    if (!result?.exceptionDetails) return;
    const detail = `${result.exceptionDetails.text ?? ""} ${result.exceptionDetails.exception?.description ?? ""}`;
    if (isInvalidSelectorError(detail)) throw typedDriverError("invalid_selector");
    throw typedDriverError("target_resolution_failed");
  }

  // CDP Input coordinates are layout-viewport CSS pixels. Measure DPR and zoom
  // so trusted input lands on the intended element at non-default scale.
  async calibrate(): Promise<void> {
    const metrics = await this.cdp("Page.getLayoutMetrics", {}).catch(() => null);
    const scale = metrics?.visualViewport?.scale;
    this.zoom = typeof scale === "number" && scale > 0 ? scale : 1;
    const dpr = await this.evalNumber("window.devicePixelRatio");
    this.devicePixelRatio = dpr && dpr > 0 ? dpr : 1;
  }

  // ── Observation (the read half) ───────────────────────────────────────────
  // Compact AX observation with backendNodeId-keyed refs. The direct runtime
  // injects no page UI, so every actionable node belongs to the page.
  async observe(options?: DriverObserveOptions & { mode?: "full" }): Promise<FullObservation>;
  async observe(options: DriverObserveOptions & { mode: "text" }): Promise<TextObservation>;
  async observe(options: DriverObserveOptions & { mode: "diff" }): Promise<FullObservation | DeltaObservation>;
  async observe(options?: DriverObserveOptions): Promise<DriverObservation>;
  async observe({ maxNodes = NODE_CAP, query, roles, includeInteractive = false, mode = "full", maxChars }: DriverObserveOptions = {}): Promise<DriverObservation> {
    if (mode === "text") return this.observeText(maxChars === undefined ? {} : { maxChars });
    // Interactive refs belong to one bounded observation cycle, not the
    // lifetime of a long-running SPA document. Reset synchronously before any
    // CDP work so a saturated prior snapshot can always recover by observing.
    this.targetRegistry.resetObservationRefs();
    this.refIndex.clear();
    const cap = Math.max(1, Math.min(Number(maxNodes) || NODE_CAP, 250));
    const url = await this.evalString("location.href");
    // A navigation invalidates the diff baseline and document-scoped node facts.
    if (url !== this.lastObserveUrl) {
      this.lastNodes.clear();
      this.nodeFactsCache.clear();
      this.lastObserveUrl = url;
    }
    // Only reuse cached bboxes when the page has not scrolled since the last
    // observe (bbox is viewport-relative — a scroll moves every node).
    const scrollY = (await this.evalNumber("window.scrollY")) || 0;
    const reuseBboxes = Math.abs(scrollY - (this.lastScrollY || 0)) < 1;
    const frameObservation = await this.accessibilityTreesForOrigin(safeOrigin(url));
    const trees = frameObservation.trees;
    const filterText = typeof query === "string" ? query.toLowerCase() : "";
    const requestedRoles = new Set(Array.isArray(roles) ? roles.map((value) => String(value).toLowerCase()).slice(0, 12) : []);
    const nodes = [];
    const observedRefs = new Set<string>();
    let truncated = false;
    for (const tree of trees) for (const axNode of tree.nodes ?? []) {
      if (nodes.length >= cap) { truncated = true; break; }
      const role = axNode.role?.value;
      if (!role || (!ACTIONABLE_ROLES.has(role) && !requestedRoles.has(role))) continue;
      if (requestedRoles.size > 0 && !requestedRoles.has(role)) continue;
      if (axNode.ignored) continue;
      const backendNodeId = axNode.backendDOMNodeId;
      if (typeof backendNodeId !== "number") continue;
      const route = tree.route ?? { targetId: this.mainTargetId, sessionId: null, frameId: null, origin: safeOrigin(url) };
      const nodeFacts = await this.describedNodeFactsCached(backendNodeId, route);
      const name = String(axNode.name?.value ?? "").slice(0, 240);
      if (filterText && !name.toLowerCase().includes(filterText)) continue;
      const value = axNode.value?.value ? String(axNode.value.value).slice(0, 240) : undefined;
      const states = axObservationStates(axNode);
      // Stable, element-keyed ref (S21): the same element keeps the same ref
      // across observations. Reuse the prior bbox for an unchanged node when the
      // page has not scrolled — skipping the per-node measurement round-trips
      // (J45). Targeting still re-measures its own element before any click.
      const ref = this.targetRegistry.createRef(route.targetId, backendNodeId, route.frameId ? { frameId: route.frameId } : {});
      if (observedRefs.has(ref)) continue;
      let retained = false;
      try {
        const prev = this.lastNodes.get(ref);
        let bbox;
        if (reuseBboxes && prev && prev.bbox && prev.role === role && prev.name === name && prev.value === value) {
          bbox = prev.bbox;
        } else {
          const measured = await this.boxFor(backendNodeId, route);
          if (!measured) continue; // not laid out / not visible
          bbox = [Math.round(measured.x), Math.round(measured.y), Math.round(measured.width), Math.round(measured.height)];
        }
        const resolvedRoute = this.targetRegistry.resolveRef(ref);
        this.refIndex.set(ref, resolvedRoute);
        observedRefs.add(ref);
        nodes.push({
          ref, role, name, ...(value ? { value } : {}), ...states, ...publicNodeFacts(nodeFacts, route.origin), bbox,
          documentEpoch: resolvedRoute.documentEpoch,
          ...(resolvedRoute.frameId ? { frameId: resolvedRoute.frameId, frameOrigin: resolvedRoute.origin } : {}),
        });
        retained = true;
      } finally {
        if (!retained) this.targetRegistry.discardObservationRef(ref);
      }
    }
    if (includeInteractive && nodes.length < cap) {
      const discovered = await this.interactiveObservationNodes(cap - nodes.length, observedRefs, { requestedRoles, filterText });
      for (const node of discovered) {
        if (!node.route) continue;
        this.refIndex.set(node.ref, node.route);
        const { route: _route, ...publicNode } = node;
        nodes.push(publicNode);
      }
    }
    for (const fileNode of await this.fileInputObservationNodes(cap - nodes.length)) {
      if (nodes.some((node) => node.ref === fileNode.ref)) continue;
      if (!fileNode.route) continue;
      this.refIndex.set(fileNode.ref, fileNode.route);
      const { backendNodeId: _backendNodeId, route: _route, ...publicNode } = fileNode;
      nodes.push(publicNode);
      if (nodes.length >= cap) { truncated = true; break; }
    }
    this.lastScrollY = scrollY;
    const title = await this.evalString("document.title");
    const origin = safeOrigin(url);
    const capturedAt = new Date().toISOString();
    const full = { kind: "observation", mode: "cdp", origin, title, nodes, nodeCount: nodes.length, truncated, capturedAt };
    // D6: emit a compact diff when asked (and a baseline exists, and the read is
    // not query-filtered). If the page churned heavily, fall back to a full snapshot.
    const canDiff = mode === "diff" && !filterText && this.lastNodes.size > 0;
    const baseline = this.lastNodes;
    this.lastNodes = new Map(nodes.map((node) => [node.ref, observationNodeSnapshot(node)]));
    if (canDiff) {
      const delta = computeObservationDelta(baseline, nodes);
      const churn = delta.added.length + delta.removed.length + delta.updated.length;
      if (churn <= Math.max(8, Math.round(nodes.length * 0.6))) {
        return { kind: "observation_delta", mode: "cdp", origin, title, added: delta.added, removed: delta.removed, updated: delta.updated, nodeCount: nodes.length, capturedAt };
      }
    }
    return full;
  }

  // Readable-text observation. Prefer main/article content, fall back to body
  // innerText. Raw text crosses the private driver boundary and is secret-redacted host-side by
  // redactBrowserResult before it reaches the client, exactly like accessible names.
  async observeText({ maxChars = TEXT_OBSERVE_CHAR_CAP }: Pick<ObserveOptions, "maxChars"> = {}): Promise<TextObservation> {
    const cap = Math.max(200, Math.min(Number(maxChars) || TEXT_OBSERVE_CHAR_CAP, TEXT_OBSERVE_CHAR_CAP));
    const url = await this.evalString("location.href");
    const title = await this.evalString("document.title");
    const raw = await this.evalString(TEXT_OBSERVE_EXPRESSION);
    const full = String(raw ?? "");
    const truncated = full.length > cap;
    return {
      kind: "observation_text",
      mode: "text",
      origin: safeOrigin(url),
      title,
      text: full.slice(0, cap),
      chars: Math.min(full.length, cap),
      truncated,
      capturedAt: new Date().toISOString(),
    };
  }

  async accessibilityTreesForOrigin(origin: string): Promise<CdpRecord> {
    const page = await this.cdp("Page.getFrameTree", {}).catch(() => null);
    this.reconcileFrameTree(page?.frameTree, origin);
    const trees = [];
    for (const route of this.targetRegistry.listObservationRoutes()) {
      const params = route.frameId ? { frameId: route.frameId } : {};
      const tree = await this.cdp("Accessibility.getFullAXTree", params, route).catch(() => ({ nodes: [] }));
      trees.push({ ...tree, route });
    }
    return { trees };
  }

  reconcileFrameTree(frameTree: CdpRecord | undefined, origin: string): void {
    if (!this.mainTargetId) {
      throw typedDriverError("browser_control_unavailable");
    }
    const topFrame = frameTree?.frame;
    if (topFrame) this.reconcileTopLevelDocument(topFrame, origin, false);
    const known = new Set(this.targetRegistry.listObservationRoutes().map((route) => route.frameId).filter(Boolean));
    const targetBoundaries = new Set<string>();
    for (const frame of childFrameRecords(frameTree)) {
      if (frame.parentFrameId && targetBoundaries.has(frame.parentFrameId)) {
        targetBoundaries.add(frame.frameId);
        continue;
      }
      const identity = this.targetRegistry.frameIdentity(frame.frameId);
      if (identity) {
        if ((identity.state === "active" || identity.state === "pending") && identity.targetId === this.mainTargetId) {
          known.add(frame.frameId);
        } else {
          targetBoundaries.add(frame.frameId);
        }
        continue;
      }
      this.targetRegistry.registerFrame({
        frameId: frame.frameId,
        targetId: this.mainTargetId,
        ...(frame.parentFrameId && known.has(frame.parentFrameId) ? { parentFrameId: frame.parentFrameId } : {}),
        origin: frame.origin,
      });
      known.add(frame.frameId);
    }
  }

  reconcileTopLevelDocument(frame: CdpRecord, origin: string, commitWithoutLoader: boolean): void {
    if (!this.mainTargetId) return;
    if (typeof frame.id === "string") this.mainFrameId = frame.id;
    const loaderId = safeLoaderId(frame.loaderId);
    if (loaderId !== null) {
      if (loaderId === this.mainLoaderId) return;
      this.targetRegistry.commitTopLevelDocument(this.mainTargetId, origin);
      this.mainLoaderId = loaderId;
      this.refIndex.clear();
      return;
    }
    if (!commitWithoutLoader) return;
    this.targetRegistry.commitTopLevelDocument(this.mainTargetId, origin);
    this.mainLoaderId = null;
    this.refIndex.clear();
  }

  // Post-action observation as a compact diff (D6). Used after in-place actions
  // (click/fill/scroll/…); navigations and the explicit observe stay full so the
  // diff baseline is re-established.
  observeDelta(): Promise<FullObservation | DeltaObservation> {
    return this.observe({ mode: "diff" });
  }

  async describedNodeFactsCached(backendNodeId: number, route: TargetRoute = {}): Promise<CdpRecord> {
    const key = `${route.sessionId ?? "root"}:${backendNodeId}:facts`;
    const cached = this.nodeFactsCache.get(key);
    if (cached) return cached;
    const described = await this.cdp("DOM.describeNode", { backendNodeId }, route).catch(() => null);
    const node = described?.node ?? {};
    const attributes: CdpRecord = {};
    for (let index = 0; index < (node.attributes ?? []).length; index += 2) {
      attributes[String(node.attributes[index]).toLowerCase()] = String(node.attributes[index + 1] ?? "");
    }
    const facts = { localName: String(node.localName || node.nodeName || "").toLowerCase(), attributes };
    this.nodeFactsCache.set(key, facts);
    return facts;
  }

  // Bounded viewport/full-page capture with fail-closed sensitive-zone masking.
  async screenshot({ sensitiveZones = [], fullPage = false, clip, format = "png", quality }: ScreenshotOptions = {}): Promise<DriverRecord> {
    const masksConfigured = Array.isArray(sensitiveZones) && sensitiveZones.length > 0;
    // Trusted post-capture masking operates on Chromium's bounded lossless PNG.
    // A masked JPEG request is safely upgraded to PNG rather than returning pixels
    // that would need a lossy decoder/encoder in the security boundary.
    const requestedFormat = format === "jpeg" ? "jpeg" : "png";
    const imageFormat = masksConfigured ? "png" : requestedFormat;
    let maskDisposition: "mask_applied" | "mask_not_configured" | "mask_not_applicable" = masksConfigured
      ? "mask_applied"
      : "mask_not_configured";
    {
      let targets: TargetResolution[] = [];
      if (masksConfigured) {
        targets = await this.resolveMaskTargets(sensitiveZones);
      }
      const { params, truncated } = await this.screenshotCapturePlan({
        imageFormat,
        quality,
        fullPage,
        clip,
      });
      const captureClip = params.clip as (Box & { scale: number }) | undefined;
      if (!captureClip) throw new Error("screenshot_clip_unavailable");
      let maskRegions: Box[] = [];
      if (masksConfigured) {
        const rootScroll = {
          x: (await this.evalNumber("window.scrollX")) || 0,
          y: (await this.evalNumber("window.scrollY")) || 0,
        };
        maskRegions = await this.maskRegionsForTargets(targets, rootScroll);
      }
      const shot = await this.cdp("Page.captureScreenshot", params).catch(() => null);
      let screenshotData = typeof shot?.data === "string" ? shot.data : null;
      let rasterWidth: number | undefined;
      let rasterHeight: number | undefined;
      if (masksConfigured) {
        if (!screenshotData) throw new Error("mask_capture_failed");
        const masked = maskCapturedPng(screenshotData, captureClip, maskRegions);
        screenshotData = masked.base64;
        rasterWidth = masked.width;
        rasterHeight = masked.height;
        maskDisposition = masked.appliedRegions > 0 ? "mask_applied" : "mask_not_applicable";
      }
      const url = await this.evalString("location.href");
      const title = await this.evalString("document.title");
      const scale = captureClip?.scale || 1;
      const width = rasterWidth ?? (captureClip ? Math.round(captureClip.width * scale) : undefined);
      const height = rasterHeight ?? (captureClip ? Math.round(captureClip.height * scale) : undefined);
      const dataUrl = screenshotData ? `data:image/${imageFormat};base64,${screenshotData}` : null;
      return {
        kind: "screenshot",
        mode: "cdp",
        origin: safeOrigin(url),
        title,
        fullPage: Boolean(fullPage),
        truncated,
        maskDisposition,
        format: imageFormat,
        ...(requestedFormat !== imageFormat ? { requestedFormat } : {}),
        ...(width ? { width } : {}),
        ...(height ? { height } : {}),
        ...(dataUrl ? { dataUrl } : {}),
        capturedAt: new Date().toISOString(),
      };
    }
  }

  async screenshotCapturePlan(input: {
    imageFormat: "png" | "jpeg";
    quality: number | undefined;
    fullPage: boolean;
    clip: Box | undefined;
  }): Promise<{ params: CdpRecord; truncated: boolean }> {
    const params: CdpRecord = { format: input.imageFormat };
    if (input.imageFormat === "jpeg") {
      params.quality = Math.max(1, Math.min(typeof input.quality === "number" && Number.isFinite(input.quality) ? Math.trunc(input.quality) : 70, 100));
    }
    let truncated = false;
    if (input.clip && Number.isFinite(input.clip.width) && Number.isFinite(input.clip.height)
      && input.clip.width > 0 && input.clip.height > 0) {
      params.clip = {
        x: Math.max(0, input.clip.x || 0),
        y: Math.max(0, input.clip.y || 0),
        width: Math.min(input.clip.width, MAX_SHOT_PX),
        height: Math.min(input.clip.height, MAX_SHOT_PX),
        scale: 1,
      };
      params.captureBeyondViewport = true;
    } else if (input.fullPage) {
      const metrics = await this.cdp("Page.getLayoutMetrics", {}).catch(() => null);
      const size = metrics?.cssContentSize || metrics?.contentSize;
      const width = Math.round(size?.width || 0);
      let height = Math.round(size?.height || 0);
      if (height > FULLPAGE_MAX_PX) { height = FULLPAGE_MAX_PX; truncated = true; }
      if (width > 0 && height > 0) {
        const scale = width > FULLPAGE_MAX_WIDTH ? FULLPAGE_MAX_WIDTH / width : 1;
        params.clip = { x: 0, y: 0, width, height, scale };
        params.captureBeyondViewport = true;
      } else {
        params.captureBeyondViewport = true;
      }
    } else {
      const width = (await this.evalNumber("window.innerWidth")) || 1280;
      const height = (await this.evalNumber("window.innerHeight")) || 800;
      const x = (await this.evalNumber("window.scrollX")) || 0;
      const y = (await this.evalNumber("window.scrollY")) || 0;
      params.clip = { x, y, width: Math.min(width, MAX_SHOT_PX), height: Math.min(height, MAX_SHOT_PX), scale: 1 };
      params.captureBeyondViewport = true;
    }
    return { params, truncated };
  }

  // ── Action execution (the write half) ──────────────────────────────────────
  async executeAction(action: DriverAction, context: DriverContext = {}): Promise<DriverRecord> {
    const kind = action.kind;
    this.assertRendererLive("root", kind);
    this.activeCommandId = typeof context?.commandId === "string" ? context.commandId : null;
    this.activeCommandKind = kind;
    try {
      return await this.executeActionNow(action);
    } finally {
      this.activeCommandKind = null;
      this.activeCommandId = null;
    }
  }

  async executeActionNow(action: DriverAction): Promise<DriverRecord> {
    const kind = action.kind;
      switch (kind) {
        case "observe":
          return this.withObservationMeta("verified", {}, await this.observe({
            ...(action.maxNodes !== undefined ? { maxNodes: action.maxNodes } : {}),
            ...(action.query !== undefined ? { query: action.query } : {}),
            ...(action.roles !== undefined ? { roles: action.roles } : {}),
            ...(action.includeInteractive !== undefined ? { includeInteractive: action.includeInteractive } : {}),
            ...(action.mode !== undefined ? { mode: action.mode } : {}),
          }));
        case "screenshot":
          return { status: "verified", changed: {}, screenshot: await this.screenshot({
            ...(action.sensitiveZones !== undefined ? { sensitiveZones: action.sensitiveZones } : {}),
            ...(action.fullPage !== undefined ? { fullPage: action.fullPage } : {}),
            ...(action.clip !== undefined ? { clip: action.clip } : {}),
            ...(action.format !== undefined ? { format: action.format } : {}),
            ...(action.quality !== undefined ? { quality: action.quality } : {}),
          }) };
        case "navigate": return this.navigate(action);
        case "back":
        case "forward":
        case "reload": return this.historyAction(kind);
        case "scroll": return this.scroll(action);
        case "wait_for": return this.waitFor(action);
        case "click": return this.click(action);
        case "press": return this.press(action);
        case "hover":
        case "move": return this.hover(action);
        case "fill":
        case "type": return this.fill(action);
        case "select": return this.select(action);
        case "clear": return this.clear(action);
        case "set_files": return this.setFiles(action);
        case "dialog_accept":
        case "dialog_dismiss": return this.handleDialog(kind, action);
        case "resize": return this.resizeViewport(action);
        case "console": return { status: "verified", changed: {}, observation: this.getConsole(action) };
        case "network": return { status: "verified", changed: {}, observation: await this.getNetwork(action) };
        default: {
          const unhandled: never = kind;
          void unhandled;
          return this.withObservationMeta("failed", {}, await this.observe({}), "unsupported_action");
        }
      }
  }

  // Console / network read-only buffers.
  pushConsole(entry: ConsoleEntry): void {
    if (!entry.text) return;
    entry.text = String(entry.text).slice(0, 2000);
    this.consoleBuffer.push(entry);
    while (this.consoleBuffer.length > CONSOLE_BUFFER_MAX) { this.consoleBuffer.shift(); this.consoleDropped += 1; }
  }

  pushNetwork(requestId: string, entry: NetworkEntry): void {
    if (!this.networkBuffer.has(requestId)) {
      while (this.networkBuffer.size >= NETWORK_BUFFER_MAX) {
        const oldest = this.networkBuffer.keys().next().value;
        if (typeof oldest === "string") this.networkBuffer.delete(oldest);
        this.networkDropped += 1;
      }
    }
    this.networkBuffer.set(requestId, { ...this.networkBuffer.get(requestId), ...entry });
  }

  updateNetwork(requestId: string, patch: Partial<NetworkEntry>): void {
    const existing = this.networkBuffer.get(requestId);
    if (existing) this.networkBuffer.set(requestId, { ...existing, ...patch });
  }

  getConsole(action: DriverAction = { kind: "console" }): DriverRecord {
    const level = typeof action.level === "string" ? action.level : null;
    const pattern = typeof action.pattern === "string" ? action.pattern.toLowerCase() : null;
    const limit = typeof action.limit === "number" && Number.isInteger(action.limit) ? action.limit : 100;
    let entries = this.consoleBuffer.filter((entry) =>
      (!level || entry.level === level) && (!pattern || String(entry.text).toLowerCase().includes(pattern)));
    entries = entries.slice(-limit);
    return { kind: "console_log", origin: safeOrigin(this.lastObserveUrl || ""), entries, count: entries.length, dropped: this.consoleDropped, capturedAt: new Date().toISOString() };
  }

  async getNetwork(action: DriverAction = { kind: "network" }): Promise<DriverRecord> {
    if (typeof action.requestId === "string" && action.requestId) return this.getNetworkBody(action.requestId);
    const urlPattern = typeof action.urlPattern === "string" ? action.urlPattern.toLowerCase() : null;
    const limit = typeof action.limit === "number" && Number.isInteger(action.limit) ? action.limit : 100;
    let entries = [...this.networkBuffer.values()].filter((entry) => !urlPattern || String(entry.url).toLowerCase().includes(urlPattern));
    entries = entries.slice(-limit);
    return { kind: "network_log", origin: safeOrigin(this.lastObserveUrl || ""), entries, count: entries.length, dropped: this.networkDropped, capturedAt: new Date().toISOString() };
  }

  // Fetch one response body only when it belongs to the currently visible origin.
  // Response HEADERS are never returned. Bodies are capped; over-cap is truncated.
  async getNetworkBody(requestId: string): Promise<DriverRecord> {
    const entry = this.networkBuffer.get(requestId);
    const base = { kind: "network_log", origin: safeOrigin(this.lastObserveUrl || ""), entries: [], count: 0, dropped: this.networkDropped, capturedAt: new Date().toISOString() };
    if (!entry) return { ...base, body: null, reason: "unknown_request_id" };
    const currentOrigin = safeOrigin(this.lastObserveUrl || "");
    if (!currentOrigin || currentOrigin !== safeOrigin(entry.url)) {
      return { ...base, body: null, bodyDisposition: "cross_origin_body_not_returned", reason: "cross_origin_body_not_returned" };
    }
    const response = await this.cdp("Network.getResponseBody", { requestId }).catch(() => null);
    if (!response) return { ...base, body: null, bodyDisposition: "body_unavailable", reason: "body_unavailable" };
    const raw = String(response.body ?? "");
    const mimeType = String(entry.mimeType || "").toLowerCase().split(";", 1)[0] ?? "";
    const truncated = raw.length > NETWORK_BODY_MAX_CHARS;
    if (response.base64Encoded || !isSupportedTextMime(mimeType) || raw.includes("\uFFFD")) {
      const bytes = bodyBytes(raw, Boolean(response.base64Encoded));
      return {
        ...base,
        body: null,
        bodyDisposition: "opaque_body_not_returned",
        bodyMetadata: {
          requestId,
          url: entry.url,
          mimeType: mimeType || "application/octet-stream",
          declaredEncoding: response.base64Encoded ? "base64" : raw.includes("\uFFFD") ? "malformed_utf8" : "unknown",
          encodedBytes: bytes.byteLength,
          sha256: await sha256Hex(bytes),
        },
      };
    }
    const data = raw.slice(0, NETWORK_BODY_MAX_CHARS);
    return {
      ...base,
      bodyDisposition: "text_body_returned",
      body: { requestId, url: entry.url, encoding: "utf-8", mimeType, data, byteLength: new TextEncoder().encode(raw).byteLength, truncated },
    };
  }

  // Set the isolated session viewport. Resizing affects only the
  // session's owned browser. The
  // override persists on the driver and is re-applied on re-attach.
  async resizeViewport(action: DriverAction): Promise<DriverRecord> {
    const viewport = action?.viewport;
    if (!viewport || typeof viewport.width !== "number" || typeof viewport.height !== "number") {
      return this.withObservationMeta("failed", {}, await this.observe({}), "invalid_viewport");
    }
    this.sessionViewport = { width: viewport.width, height: viewport.height };
    await this.cdp("Emulation.setDeviceMetricsOverride", { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: false }).catch(() => {});
    await this.settleShort();
    const observation = await this.observe({});
    return this.withObservationMeta("verified", { viewport: `${viewport.width}x${viewport.height}` }, observation);
  }

  // Accept or dismiss a page-initiated JavaScript dialog. The renderer is
  // blocked while a dialog is open, so we resolve it via CDP FIRST and only then
  // observe. `promptText` is applied to prompt() dialogs on accept and ignored
  // otherwise. With no dialog open this is a typed no-op, not an error the agent
  // must recover from.
  async handleDialog(kind: "dialog_accept" | "dialog_dismiss", action: DriverAction): Promise<DriverRecord> {
    if (!this.pendingDialog) {
      return this.withObservationMeta("failed", {}, await this.observe({}), "no_dialog_open");
    }
    const accept = kind === "dialog_accept";
    const dialog = this.pendingDialog;
    const pendingRoute = this.pendingDialogRoute;
    const params: CdpRecord = { accept };
    if (accept && dialog.dialogType === "prompt") {
      params.promptText = String(action?.promptText ?? dialog.defaultPrompt ?? "");
    }
    const signalWindow = this.beginActionSignals();
    try {
      const route = dialogRoute(pendingRoute);
      const targetKey = pendingRoute?.targetKey ?? inputTargetKey(route);
      await this.cdp("Page.handleJavaScriptDialog", params, route);
      this.dialogTracker.close(targetKey);
      this.pendingDialogs.delete(targetKey);
      this.refreshPendingDialog();
      this.reconcileRenderer(targetKey);
      await this.inputDispatcher.whenIdle();
      await this.waitForSettle();
      const signals = signalWindow.finish();
      const observation = await this.observe({});
      const changed = { dialog: accept ? "accepted" : "dismissed", ...reconciliationChanges(signals) };
      return this.withObservationMeta("verified", changed, observation);
    } finally {
      signalWindow.finish();
    }
  }

  async navigate(action: DriverAction): Promise<DriverRecord> {
    await this.preflightAction(action);
    const startUrl = await this.evalString("location.href");
    await this.cdp("Page.navigate", { url: action.url });
    await this.waitForSettle();
    const observation = await this.observe({});
    return this.withObservationMeta("verified", { navigated: action.url ?? observation.origin, ...(observation.origin !== safeOrigin(startUrl) ? { newTarget: false } : {}) }, observation);
  }

  async historyAction(kind: "back" | "forward" | "reload"): Promise<DriverRecord> {
    const before = await this.pageSignature();
    if (kind === "back") await this.cdp("Runtime.evaluate", { expression: "history.back()" });
    if (kind === "forward") await this.cdp("Runtime.evaluate", { expression: "history.forward()" });
    if (kind === "reload") await this.cdp("Page.reload", { ignoreCache: false });
    await this.waitForSettle();
    const after = await this.pageSignature();
    const changed = diffPage(before, after);
    const observation = await this.observe({});
    return this.withObservationMeta(Object.keys(changed).length > 0 || kind === "reload" ? "verified" : "dispatched_unverified", changed, observation);
  }

  async click(action: DriverAction): Promise<DriverRecord> {
    const target = await this.resolveTarget(action);
    if (!target) return this.targetMoved("not_found");
    const framedTarget = typeof target.frameId === "string" && target.frameId.length > 0;
    if (framedTarget && !target.backendNodeId) return this.targetMoved("stale_target", "target_geometry_unavailable");
    if (target.backendNodeId) await this.cdp("DOM.focus", { backendNodeId: target.backendNodeId }, target).catch(() => {});
    const point = framedTarget && target.backendNodeId
      ? await this.actionablePoint(target.backendNodeId, target)
      : target.point ?? (target.backendNodeId ? await this.actionablePoint(target.backendNodeId, target) : null);
    if (!point) return this.targetMoved("stale_target", this.actionabilityFailure ?? undefined);
    const pointerRoute = this.pointerInputRoute(target, point);
    if (!pointerRoute) return this.targetMoved("stale_target", this.actionabilityFailure ?? "frame_input_route_unavailable");
    const before = await this.pageSignature();
    const beforeState = target.backendNodeId ? await this.elementState(target.backendNodeId, target) : {};
      const signalWindow = this.beginActionSignals();
      try {
        let dispatched: boolean;
        let committingInputStarted = false;
        let releaseAcknowledgementUncertain = false;
        try {
          const inputTarget = pointerRoute.mode === "root"
            ? { ...target, timeoutMs: OWNED_ROOT_INPUT_TIMEOUT_MS }
            : target;
          dispatched = await this.dispatchInput(inputTarget, async (input) => {
            await input.pointerMove(pointerRoute.point);
            if (target.backendNodeId) {
              const actionable = framedTarget
                ? await this.verifyFramedPoint(target.backendNodeId, target, point)
                : await this.hitTestTarget(target.backendNodeId, point.x, point.y, target);
              if (!actionable) return false;
            }
            committingInputStarted = true;
            await input.mouseDown("left");
            await input.mouseUp("left");
            return true;
          }, pointerRoute.mode);
        } catch (error) {
          if (committingInputStarted && isInputReleaseAcknowledgementTimeout(error)) {
            releaseAcknowledgementUncertain = true;
            dispatched = true;
          } else {
          // A child session can disappear at any input boundary. Convert only
          // raw transport failures from this internal mode to the established
          // stale-target contract; typed renderer/dialog failures retain their
          // existing semantics.
          if (pointerRoute.mode === "target" && !isTypedDriverError(error)) {
            if (committingInputStarted) return this.inputDispatchUncertain();
            return this.targetMoved("stale_target", "frame_input_route_unavailable");
          }
          throw error;
          }
        }
        if (!dispatched) {
          if (framedTarget) return this.targetMoved("stale_target", this.actionabilityFailure ?? undefined);
          const blocker = await this.blockingElementEvidence(point, target);
          if (!blocker) return this.targetMoved();
          const observation = await this.observe({});
          return this.withObservationMeta("stale_target", { blocker }, observation, "click_intercepted");
        }
      await this.settleShort();
      if (releaseAcknowledgementUncertain) this.reconcileRenderer(inputTargetKey(target));
      const waitResult = action.waitFor ? await this.waitForCondition(action.waitFor, action.timeoutMs) : null;
      const signals = signalWindow.finish();
      const after = await this.pageSignature();
      const afterState = target.backendNodeId ? await this.elementState(target.backendNodeId, target).catch(() => ({})) : {};
      const verifiedChanges = { ...diffPage(before, after), ...diffElement(beforeState, afterState), ...(waitResult?.matched ? { waitedFor: true } : {}) };
      const changed = { ...verifiedChanges, ...reconciliationChanges(signals), ...(releaseAcknowledgementUncertain ? { inputReleaseAcknowledgement: "unacknowledged" } : {}) };
      const observation = await this.observeDelta();
      const verified = waitResult
        ? waitResult.matched
        : Object.keys(verifiedChanges).length > 0 || hasDirectlyObservableEffect(signals);
      return this.withObservationMeta(
        releaseAcknowledgementUncertain ? "dispatched_unverified" : verified ? "verified" : "dispatched_unverified",
        changed,
        observation,
        releaseAcknowledgementUncertain ? "input_release_unacknowledged" : waitResult && !waitResult.matched ? waitResult.reason : undefined,
      );
    } finally {
      signalWindow.finish();
    }
  }

  async fill(action: DriverAction): Promise<DriverRecord> {
    let target = await this.resolveTarget(action);
    if (!target?.backendNodeId) return this.targetMoved("not_found");
    let backendNodeId = target.backendNodeId;
    await this.cdp("DOM.focus", { backendNodeId }, target).catch(() => {});
    const explicitRef = typeof normalizedTarget(action)?.ref === "string";
    if (!explicitRef) {
      const refreshedTarget = await this.resolveTarget(action);
      if (!refreshedTarget?.backendNodeId) return this.targetMoved("stale_target");
      target = refreshedTarget;
      backendNodeId = refreshedTarget.backendNodeId;
    }
    let point = await this.actionablePoint(backendNodeId, target);
    if (!point && !explicitRef) {
      const refreshedTarget = await this.resolveTarget(action);
      if (refreshedTarget?.backendNodeId) {
        target = refreshedTarget;
        backendNodeId = refreshedTarget.backendNodeId;
        point = await this.actionablePoint(backendNodeId, target);
      }
    }
    if (!point) return this.targetMoved("stale_target", this.actionabilityFailure ?? undefined);
    const inputPoint = point;
    const framedTarget = typeof target.frameId === "string" && target.frameId.length > 0;
    const pointerRoute = this.pointerInputRoute(target, inputPoint);
    if (!pointerRoute) return this.targetMoved("stale_target", this.actionabilityFailure ?? "frame_input_route_unavailable");
    const beforeState = await this.elementState(backendNodeId, target);
    let dispatched: boolean;
    let committingInputStarted = false;
    try {
      dispatched = await this.dispatchInput(target, async (input) => {
        await input.pointerMove(pointerRoute.point);
        if (framedTarget && !(await this.verifyFramedPoint(backendNodeId, target, inputPoint))) return false;
        committingInputStarted = true;
        await input.mouseDown("left");
        await input.mouseUp("left");
        await input.chord(["Control", "a"]);
        await input.insertText(String(action.value ?? ""));
        return true;
      }, pointerRoute.mode);
    } catch (error) {
      if (pointerRoute.mode === "target" && !isTypedDriverError(error)) {
        if (committingInputStarted) return this.inputDispatchUncertain();
        return this.targetMoved("stale_target", "frame_input_route_unavailable");
      }
      throw error;
    }
    if (!dispatched) return this.targetMoved("stale_target", this.actionabilityFailure ?? undefined);
    const waitResult = action.waitFor ? await this.waitForCondition(action.waitFor, action.timeoutMs) : null;
    const afterState = await this.elementState(backendNodeId, target).catch(() => ({}));
    const changed = { ...diffElement(beforeState, afterState), ...(waitResult?.matched ? { waitedFor: true } : {}) };
    const observation = await this.observeDelta();
    return this.withObservationMeta(waitResult ? (waitResult.matched ? "verified" : "timed_out") : "verified", changed, observation, waitResult && !waitResult.matched ? waitResult.reason : undefined);
  }

  async select(action: DriverAction): Promise<DriverRecord> {
    const target = await this.resolveTarget(action);
    if (!target?.backendNodeId) return this.targetMoved("not_found");
    const beforeState = await this.elementState(target.backendNodeId, target);
    // Native <select>: choose the option by value/label/text and fire input+change
    // so frameworks observe the change (S9). Plain insertText does not select an
    // <option> and is a no-op on real selects.
    let applied = false;
    const objectId = await this.objectIdFor(target.backendNodeId, target);
    if (objectId) {
      const result = await this.cdp("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: `function (wanted) {
          if (!this.tagName || this.tagName.toLowerCase() !== "select") return false;
          const want = String(wanted == null ? "" : wanted).trim().toLowerCase();
          const options = Array.from(this.options || []);
          const match = options.find((o) => String(o.value).toLowerCase() === want)
            || options.find((o) => String(o.label || o.text || "").trim().toLowerCase() === want)
            || options.find((o) => String(o.text || "").toLowerCase().includes(want));
          if (!match) return false;
          this.value = match.value;
          this.dispatchEvent(new Event("input", { bubbles: true }));
          this.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        }`,
        arguments: [{ value: String(action.value ?? "") }],
        returnByValue: true,
      }, target).catch(() => null);
      applied = Boolean(result?.result?.value);
    }
    if (!applied) {
      // Fallback for custom (non-native) selects: focus + trusted typing.
      await this.cdp("DOM.focus", { backendNodeId: target.backendNodeId }, target).catch(() => {});
      const inputMode = this.targetInputMode(target);
      try {
        await this.dispatchInput(target, (input) => input.insertText(String(action.value ?? "")), inputMode);
      } catch (error) {
        if (inputMode === "target" && !isTypedDriverError(error)) return this.inputDispatchUncertain();
        throw error;
      }
    }
    const afterState = await this.elementState(target.backendNodeId, target).catch(() => ({}));
    const changed = diffElement(beforeState, afterState);
    const observation = await this.observeDelta();
    return this.withObservationMeta(applied || Object.keys(changed).length > 0 ? "verified" : "dispatched_unverified", changed, observation);
  }

  async clear(action: DriverAction): Promise<DriverRecord> {
    const target = await this.resolveTarget(action);
    if (!target?.backendNodeId) return this.targetMoved("not_found");
    const beforeState = await this.elementState(target.backendNodeId, target);
    await this.cdp("DOM.focus", { backendNodeId: target.backendNodeId }, target).catch(() => {});
    const inputMode = this.targetInputMode(target);
    try {
      await this.dispatchInput(target, async (input) => {
        await input.chord(["Control", "a"]);
        await input.keyPress("Delete");
      }, inputMode);
    } catch (error) {
      if (inputMode === "target" && !isTypedDriverError(error)) return this.inputDispatchUncertain();
      throw error;
    }
    const afterState = await this.elementState(target.backendNodeId, target).catch(() => ({}));
    const observation = await this.observeDelta();
    return this.withObservationMeta("verified", diffElement(beforeState, afterState), observation);
  }

  async interactiveObservationNodes(limit: number, existingRefs: Set<string> = new Set(), filters: InteractiveFilters = {}): Promise<DriverObservationNode[]> {
    if (limit <= 0) return [];
    const output = [];
    const selector = "a[href],button,input,select,textarea,[role],[tabindex]";
    for (const route of this.targetRegistry.listObservationRoutes()) {
      if (output.length >= limit) break;
      const document = await this.cdp("DOM.getDocument", { depth: 0, pierce: true }, route).catch(() => null);
      if (!document?.root?.nodeId) continue;
      const queried = await this.cdp("DOM.querySelectorAll", { nodeId: document.root.nodeId, selector }, route).catch(() => null);
      for (const nodeId of (queried?.nodeIds ?? []).slice(0, Math.min(500, Math.max(50, limit * 10)))) {
        if (output.length >= limit) break;
        const described = await this.cdp("DOM.describeNode", { nodeId }, route).catch(() => null);
        const backendNodeId = described?.node?.backendNodeId;
        if (!Number.isInteger(backendNodeId)) continue;
        const ref = this.targetRegistry.createRef(route.targetId, backendNodeId, route.frameId ? { frameId: route.frameId } : {});
        if (existingRefs.has(ref)) continue;
        let retained = false;
        try {
          const [facts, name, bbox, nodeFacts] = await Promise.all([
            this.elementFacts(backendNodeId, route),
            this.axNameFor(backendNodeId, route),
            this.boxFor(backendNodeId, route),
            this.describedNodeFactsCached(backendNodeId, route),
          ]);
          if (!bbox || !facts.role) continue;
          const role = String(facts.role).toLowerCase();
          const accessibleName = String(name || facts.accessibleName || "").slice(0, 240);
          if (filters.requestedRoles && filters.requestedRoles.size > 0 && !filters.requestedRoles.has(role)) continue;
          if (filters.filterText && !`${role} ${accessibleName}`.toLowerCase().includes(filters.filterText)) continue;
          const resolvedRoute = this.targetRegistry.resolveRef(ref);
          existingRefs.add(ref);
          output.push({
            ref,
            role: role.slice(0, 80),
            name: accessibleName,
            ...(typeof facts.disabled === "boolean" ? { disabled: facts.disabled } : {}),
            ...(typeof facts.checked === "boolean" ? { checked: facts.checked } : {}),
            ...publicNodeFacts(nodeFacts, route.origin),
            bbox: [Math.round(bbox.x), Math.round(bbox.y), Math.round(bbox.width), Math.round(bbox.height)],
            documentEpoch: resolvedRoute.documentEpoch,
            ...(resolvedRoute.frameId ? { frameId: resolvedRoute.frameId, frameOrigin: resolvedRoute.origin } : {}),
            route: resolvedRoute,
          });
          retained = true;
        } finally {
          if (!retained) this.targetRegistry.discardObservationRef(ref);
        }
      }
    }
    return output;
  }

  async fileInputObservationNodes(limit: number): Promise<DriverObservationNode[]> {
    if (limit <= 0) return [];
    const route = this.targetRegistry.listObservationRoutes()[0];
    if (!route) return [];
    const document = await this.cdp("DOM.getDocument", { depth: 0, pierce: true }, route).catch(() => null);
    const nodeId = document?.root?.nodeId;
    if (!nodeId) return [];
    const queried = await this.cdp("DOM.querySelectorAll", { nodeId, selector: "input[type='file']" }, route).catch(() => null);
    const output = [];
    for (const candidateNodeId of (queried?.nodeIds ?? []).slice(0, limit)) {
      const described = await this.cdp("DOM.describeNode", { nodeId: candidateNodeId }, route).catch(() => null);
      const backendNodeId = described?.node?.backendNodeId;
      if (!Number.isInteger(backendNodeId)) continue;
      const facts = await this.fileInputDisplayFacts(backendNodeId, route);
      const ref = this.targetRegistry.createRef(route.targetId, backendNodeId);
      const resolvedRoute = this.targetRegistry.resolveRef(ref);
      output.push({
        backendNodeId,
        route: resolvedRoute,
        ref,
        role: "file",
        name: facts.name || "File input",
        documentEpoch: resolvedRoute.documentEpoch,
        ...(facts.bbox ? { bbox: facts.bbox } : {}),
      });
    }
    return output;
  }

  async fileInputDisplayFacts(backendNodeId: number, route: TargetRoute = {}): Promise<CdpRecord> {
    const objectId = await this.objectIdFor(backendNodeId, route);
    if (!objectId) return { name: "", bbox: null };
    const result = await this.cdp("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: `function () {
        const id = String(this.id || "");
        const label = this.labels && this.labels[0] ? (this.labels[0].innerText || this.labels[0].textContent || "") : "";
        const name = String(this.getAttribute("aria-label") || label || this.getAttribute("name") || id || "File input").trim().slice(0, 240);
        const rect = this.getBoundingClientRect();
        const style = getComputedStyle(this);
        const visible = rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
        return { name, bbox: visible ? [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)] : null };
      }`,
      returnByValue: true,
    }, route).catch(() => null);
    return result?.result?.value ?? { name: "", bbox: null };
  }

  async setFiles(action: DriverAction): Promise<DriverRecord> {
    const target = await this.resolveTarget(action);
    if (!target?.backendNodeId) return this.targetMoved("not_found");
    const facts = await this.fileInputFacts(target.backendNodeId, target);
    if (!facts.isFileInput) throw new Error("target_not_file_input");
    const explicitRef = Boolean(action.ref);
    if (!facts.visible && !explicitRef) throw new Error("hidden_file_input_requires_ref");
    const files = Array.isArray(action.files) ? action.files : [];
    if (files.length > 1 && !facts.multiple) throw new Error("file_input_not_multiple");
    await this.cdp("DOM.setFileInputFiles", { backendNodeId: target.backendNodeId, files }, target);
    const accepted = await this.fileInputState(target.backendNodeId, target);
    const expectedNames = files.map((file: string) => String(file).split(/[\\/]/).at(-1) || "");
    if (accepted.length !== expectedNames.length || accepted.some((file: CdpRecord, index: number) => file.filename !== expectedNames[index])) {
      throw new Error("file_input_acceptance_mismatch");
    }
    const observation = await this.observeDelta();
    return this.withObservationMeta("verified", { files: accepted, fileCount: accepted.length }, observation);
  }

  async fileInputFacts(backendNodeId: number, route: TargetRoute = {}): Promise<CdpRecord> {
    const objectId = await this.objectIdFor(backendNodeId, route);
    if (!objectId) return { isFileInput: false, multiple: false, visible: false };
    const result = await this.cdp("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: `function () {
        const tag = String(this.tagName || "").toLowerCase();
        const type = String(this.type || "").toLowerCase();
        const rect = this.getBoundingClientRect();
        const style = getComputedStyle(this);
        return {
          isFileInput: tag === "input" && type === "file",
          multiple: Boolean(this.multiple),
          visible: rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden",
        };
      }`,
      returnByValue: true,
    }, route).catch(() => null);
    return result?.result?.value ?? { isFileInput: false, multiple: false, visible: false };
  }

  async fileInputState(backendNodeId: number, route: TargetRoute = {}): Promise<CdpRecord[]> {
    const objectId = await this.objectIdFor(backendNodeId, route);
    if (!objectId) return [];
    const result = await this.cdp("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: `function () {
        return Array.from(this.files || []).map((file) => ({
          filename: String(file.name || ""),
          sizeBytes: Number(file.size || 0),
          mimeType: String(file.type || ""),
        }));
      }`,
      returnByValue: true,
    }, route).catch(() => null);
    return Array.isArray(result?.result?.value) ? result.result.value : [];
  }

  async scroll(action: DriverAction): Promise<DriverRecord> {
    const dy = Number(action.value) || 600;
    const beforeY = await this.evalNumber("window.scrollY");
    const acknowledged = await this.dispatchInput(
      { timeoutMs: SCROLL_DISPATCH_TIMEOUT_MS },
      (input) => input.wheel({ x: 10, y: 10 }, { x: 0, y: dy }),
    ).then(() => true).catch(() => false);
    const afterY = await this.waitForScrollPositionChange(beforeY);
    const observation = await this.observeDelta();
    const changed = Math.abs(afterY - beforeY) > 1;
    return this.withObservationMeta(
      changed ? "verified" : "dispatched_unverified",
      { scrollY: Math.round(afterY), wheelAcknowledged: acknowledged },
      observation,
      !changed && !acknowledged ? "wheel_acknowledgement_timeout" : undefined,
    );
  }

  async waitForScrollPositionChange(beforeY: number, timeoutMs = 1200): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    let current = beforeY;
    while (Date.now() < deadline) {
      current = await this.evalNumber("window.scrollY");
      if (Math.abs(current - beforeY) > 1) return current;
      await delay(AUTO_WAIT_POLL_MS);
    }
    return current;
  }

  // First-class wait_for: ref-appears / text-appears / networkIdle. Never
  // caller-supplied JS (§7.5).
  async waitFor(action: DriverAction): Promise<DriverRecord> {
    if (!action.waitFor) throw typedDriverError("invalid_arguments");
    const waitResult = await this.waitForCondition(action.waitFor, action.waitFor.timeoutMs);
    const observation = await this.observeDelta();
    return this.withObservationMeta(waitResult.matched ? "verified" : "timed_out", waitResult.matched ? { waitedFor: true } : {}, observation, waitResult.reason);
  }

  async press(action: DriverAction): Promise<DriverRecord> {
    const target = await this.resolveTarget(action);
    if (target?.backendNodeId) await this.cdp("DOM.focus", { backendNodeId: target.backendNodeId }, target).catch(() => {});
    if (!Array.isArray(action.keys) || action.keys.length === 0) throw typedDriverError("invalid_arguments");
    const keys = action.keys;
    const inputMode = this.targetInputMode(target ?? {});
    const signalWindow = this.beginActionSignals();
    try {
      try {
        await this.dispatchInput(target ?? {}, (input) => input.chord(keys.slice(0, 8)), inputMode);
      } catch (error) {
        if (inputMode === "target" && !isTypedDriverError(error)) return this.inputDispatchUncertain();
        throw error;
      }
      const waitResult = action.waitFor ? await this.waitForCondition(action.waitFor, action.timeoutMs) : null;
      const signals = signalWindow.finish();
      const observation = await this.observeDelta();
      const changed = { ...reconciliationChanges(signals), ...(waitResult?.matched ? { waitedFor: true } : {}) };
      return this.withObservationMeta(waitResult ? (waitResult.matched ? "verified" : "timed_out") : "dispatched_unverified", changed, observation, waitResult && !waitResult.matched ? waitResult.reason : undefined);
    } finally {
      signalWindow.finish();
    }
  }

  async hover(action: DriverAction): Promise<DriverRecord> {
    const target = await this.resolveTarget(action);
    if (!target) return this.targetMoved("not_found");
    const framedTarget = typeof target.frameId === "string" && target.frameId.length > 0;
    if (framedTarget && !target.backendNodeId) return this.targetMoved("stale_target", "target_geometry_unavailable");
    const point = framedTarget && target.backendNodeId
      ? await this.actionablePoint(target.backendNodeId, target)
      : target.point ?? (target.backendNodeId ? await this.actionablePoint(target.backendNodeId, target) : null);
    if (!point) return this.targetMoved("stale_target", this.actionabilityFailure ?? undefined);
    const pointerRoute = this.pointerInputRoute(target, point);
    if (!pointerRoute) return this.targetMoved("stale_target", this.actionabilityFailure ?? "frame_input_route_unavailable");
    let dispatched: boolean;
    try {
      dispatched = await this.dispatchInput(target, async (input) => {
        await input.pointerMove(pointerRoute.point);
        return !framedTarget || (target.backendNodeId !== undefined && await this.verifyFramedPoint(target.backendNodeId, target, point));
      }, pointerRoute.mode);
    } catch (error) {
      if (pointerRoute.mode === "target" && !isTypedDriverError(error)) {
        return this.targetMoved("stale_target", "frame_input_route_unavailable");
      }
      throw error;
    }
    if (!dispatched) return this.targetMoved("stale_target", this.actionabilityFailure ?? undefined);
    await this.settleShort();
    const observation = await this.observeDelta();
    return this.withObservationMeta("verified", { hovered: true }, observation);
  }

  // Resolve the target element's structural facts so the SW can re-check the
  // floor with real evidence BEFORE dispatching a mutating action (§7, S3). The
  // accessible name lets host/structural commit rules gate a ref-targeted click.
  async resolveEvidence(action: DriverAction): Promise<DriverRecord> {
    const target = await this.resolveTarget(action);
    const origin = target?.origin || await this.evalString("location.origin");
    if (!target?.backendNodeId) {
      return { resolved: { origin }, signals: {} };
    }
    const facts = await this.elementFacts(target.backendNodeId, target);
    // Use the authoritative AX accessible name (same source as observe). The
    // naive aria-label/innerText read in elementFacts misses names computed by
    // the accessibility algorithm (labelledby, nested web components like the
    // YouTube Subscribe button) — without this the commit re-check under-reads
    // the name and fails to escalate.
    const axName = await this.axNameFor(target.backendNodeId, target);
    return {
      resolved: {
        role: facts.role || "",
        accessibleName: axName || facts.accessibleName || "",
        formOwner: facts.formOwner ?? null,
        inputType: facts.inputType || "",
        autocomplete: facts.autocomplete || "",
        origin,
      },
      signals: {
        ...(facts.formSubmit ? { formSubmit: true } : {}),
        ...(facts.inputType === "password" ? { secretField: true } : {}),
      },
    };
  }

  // Authoritative accessible name from the AX tree (matches what observe shows
  // the model), used by the pre-dispatch commit re-check.
  async axNameFor(backendNodeId: number, route: TargetRoute = {}): Promise<string> {
    const tree = await this.cdp("Accessibility.getPartialAXTree", { backendNodeId, fetchRelatives: false }, route).catch(() => null);
    const nodes = Array.isArray(tree?.nodes) ? tree.nodes : [];
    const node = nodes.find((n) => n.backendDOMNodeId === backendNodeId && n.name?.value) ?? nodes.find((n) => n.name?.value);
    return node?.name?.value ? String(node.name.value).slice(0, 240) : "";
  }

  async elementFacts(backendNodeId: number, route: TargetRoute = {}): Promise<CdpRecord> {
    const objectId = await this.objectIdFor(backendNodeId, route);
    if (!objectId) return {};
    const result = await this.cdp("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: `function () {
        const tag = this.tagName ? this.tagName.toLowerCase() : "";
        const attr = (n) => (this.getAttribute ? (this.getAttribute(n) || "") : "");
        const explicitRole = attr("role");
        const implicitRole = tag === "button" ? "button"
          : tag === "a" ? "link"
          : (tag === "input" && ["submit", "button", "reset"].includes(this.type)) ? "button"
          : tag === "select" ? "combobox"
          : (tag === "input" || tag === "textarea") ? "textbox" : "";
        const name = (attr("aria-label") || (this.innerText || this.textContent || "") || this.value || attr("title") || attr("placeholder") || "").trim().slice(0, 160);
        const form = this.form && this.form.id ? this.form.id
          : (this.closest && this.closest("form")) ? (this.closest("form").id || "form") : null;
        const isSubmit = (tag === "button" && (this.type === "submit" || !this.type))
          || (tag === "input" && this.type === "submit")
          || attr("type") === "submit";
        return {
          role: explicitRole || implicitRole || "",
          accessibleName: name,
          formOwner: form,
          inputType: this.type || "",
          autocomplete: attr("autocomplete"),
          disabled: Boolean(this.disabled || attr("aria-disabled") === "true"),
          checked: typeof this.checked === "boolean" ? this.checked : undefined,
          formSubmit: Boolean(isSubmit && form),
        };
      }`,
      returnByValue: true,
    }, route).catch(() => null);
    return result?.result?.value && typeof result.result.value === "object" ? result.result.value : {};
  }

  // ── Targeting + actionability (§7.5) ───────────────────────────────────────
  async resolveTarget(action: DriverAction): Promise<TargetResolution | null> {
    const target = normalizedTarget(action);
    if (target) {
      if (target.coordinates) return { point: target.coordinates };
      if (target.ref) return this.targetRegistry.resolveRef(target.ref);
      if (target.selector) {
        const backendNodeId = await this.backendNodeIdForSelector(target.selector);
        if (backendNodeId) return { backendNodeId };
      }
      if (target.testId) {
        const backendNodeId = await this.backendNodeIdFromElementExpression(findByTestIdSource(), [target.testId]);
        if (backendNodeId) return { backendNodeId };
      }
      if (target.placeholder) {
        const backendNodeId = await this.backendNodeIdFromElementExpression(findByAttributeTextSource(), ["placeholder", target.placeholder, Boolean(target.exact)]);
        if (backendNodeId) return { backendNodeId };
      }
      if (target.label) {
        const backendNodeId = await this.backendNodeIdFromElementExpression(findByLabelSource(), [target.label, Boolean(target.exact)]);
        if (backendNodeId) return { backendNodeId };
      }
      if (target.role || target.name || target.label || target.text || target.ref) {
        const observation = await this.observe({});
        const matches = observation.nodes.filter((node) => nodeMatchesTarget(node, target));
        if (matches.length > 1) throw new Error("ambiguous");
        const match = matches[0];
        if (match && this.refIndex.has(match.ref)) return this.refIndex.get(match.ref) ?? null;
      }
      if (target.text) {
        const backendNodeId = await this.backendNodeIdFromElementExpression(findByVisibleTextSource(), [target.text, Boolean(target.exact)]);
        if (backendNodeId) return { backendNodeId };
      }
      return null;
    }
    // valid ref → role_name → text → selector. Never click a guess.
    if (action.ref && this.refIndex.has(action.ref)) {
      return this.targetRegistry.resolveRef(action.ref) ?? null;
    }
    if (action.selector) {
      const backendNodeId = await this.backendNodeIdForSelector(action.selector);
      if (backendNodeId) return { backendNodeId };
    }
    if (action.text || action.ref) {
      // Re-snapshot and match by accessible name / value.
      const observation = await this.observe({});
      const needle = String(action.text ?? action.ref ?? "").toLowerCase();
      const matches = observation.nodes.filter((node) => (node.name ?? "").toLowerCase().includes(needle));
      if (matches.length > 1) throw new Error("ambiguous");
      const match = matches[0];
      if (match && this.refIndex.has(match.ref)) return this.refIndex.get(match.ref) ?? null;
    }
    return null;
  }

  async backendNodeIdForSelector(selector: string): Promise<number | null> {
    const root = await this.cdp("DOM.getDocument", { depth: 0 }).catch(() => null);
    const nodeId = root?.root?.nodeId;
    if (!nodeId) return null;
    let found;
    try {
      found = await this.cdp("DOM.querySelectorAll", { nodeId, selector });
    } catch (error) {
      if (isInvalidSelectorError(error)) throw typedDriverError("invalid_selector");
      throw error;
    }
    const nodeIds = Array.isArray(found?.nodeIds) ? found.nodeIds : [];
    if (nodeIds.length === 0) return null;
    if (nodeIds.length > 64) throw new Error("ambiguous");
    const visibleBackendNodeIds: number[] = [];
    for (const nodeId of nodeIds) {
      const described = await this.cdp("DOM.describeNode", { nodeId }).catch(() => null);
      const backendNodeId = described?.node?.backendNodeId;
      if (!Number.isSafeInteger(backendNodeId) || backendNodeId <= 0) continue;
      if (await this.selectorCandidateVisible(backendNodeId)) {
        visibleBackendNodeIds.push(backendNodeId);
        if (visibleBackendNodeIds.length > 1) throw new Error("ambiguous");
      }
    }
    return visibleBackendNodeIds[0] ?? null;
  }

  async selectorCandidateVisible(backendNodeId: number): Promise<boolean> {
    const objectId = await this.objectIdFor(backendNodeId);
    if (!objectId) return false;
    const result = await this.cdp("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: `function () {
        if (this.isConnected !== true) return false;
        const style = getComputedStyle(this);
        const rect = this.getBoundingClientRect();
        return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) > 0 && rect.width > 0 && rect.height > 0;
      }`,
      returnByValue: true,
    }).catch(() => null);
    return result?.result?.value === true;
  }

  async backendNodeIdFromElementExpression(functionDeclaration: string, args: unknown[]): Promise<number | null> {
    const expression = `(${functionDeclaration})(...${JSON.stringify(args)})`;
    const evaluated = await this.cdp("Runtime.evaluate", {
      expression,
      objectGroup: "newton-browser-target",
      includeCommandLineAPI: false,
    }).catch(() => null);
    if (evaluated?.exceptionDetails) {
      const detail = `${evaluated.exceptionDetails.text ?? ""} ${evaluated.exceptionDetails.exception?.description ?? ""}`;
      if (/ambiguous/i.test(detail)) throw new Error("ambiguous");
      throw new Error("target_resolution_failed");
    }
    const objectId = evaluated?.result?.objectId;
    if (!objectId) return null;
    try {
      const requested = await this.cdp("DOM.requestNode", { objectId }).catch(() => null);
      if (!requested?.nodeId) return null;
      const described = await this.cdp("DOM.describeNode", { nodeId: requested.nodeId }).catch(() => null);
      return described?.node?.backendNodeId ?? null;
    } finally {
      await this.cdp("Runtime.releaseObjectGroup", { objectGroup: "newton-browser-target" }).catch(() => {});
    }
  }

  async actionablePoint(backendNodeId: number, route: TargetRoute = {}): Promise<Point | null> {
    this.actionabilityFailure = null;
    this.framedPointProof = null;
    const framedTarget = typeof route.frameId === "string" && route.frameId.length > 0;
    let embeddingFrames: PreparedEmbeddingFrames | null = null;
    // Bring off-screen / below-the-fold targets into view first — the single
    // biggest real-world reliability win. Without this, an element outside the
    // viewport never hit-tests and times out as stale_target (seen live on the
    // large dynamic catalog).
    await this.scrollIntoView(backendNodeId, route);
    if (framedTarget) {
      embeddingFrames = await this.prepareEmbeddingFrames(route);
      if (!embeddingFrames) {
        this.actionabilityFailure ??= "frame_chain_unavailable";
        return null;
      }
    }
    const deadline = Date.now() + AUTO_WAIT_TIMEOUT_MS;
    const viewportRoute = framedTarget ? {} : route;
    const measuredHeight = await this.evalNumber("window.innerHeight", viewportRoute);
    const measuredWidth = await this.evalNumber("window.innerWidth", viewportRoute);
    if (framedTarget && (measuredHeight <= 0 || measuredWidth <= 0)) return null;
    const vh = measuredHeight || 100000;
    const vw = measuredWidth || 100000;
    let previous = null;
    let rescrolls = 0;
    while (Date.now() < deadline) {
      const localBox = framedTarget
        ? await this.localBoxFor(backendNodeId, route)
        : await this.boxFor(backendNodeId, route);
      const box = framedTarget && localBox && embeddingFrames
        ? this.composeThroughEmbeddingFrames(localBox, embeddingFrames)
        : localBox;
      if (box && box.width > 0 && box.height > 0) {
        const cx = box.x + box.width / 2;
        const cy = box.y + box.height / 2;
        // If the bbox centre is outside the viewport, re-scroll (bounded) and re-measure.
        if ((cy < 0 || cy > vh || cx < 0 || cx > vw) && rescrolls < 3) {
          rescrolls += 1;
          if (framedTarget) {
            await this.scrollIntoView(backendNodeId, route);
            embeddingFrames = await this.prepareEmbeddingFrames(route);
            if (!embeddingFrames) {
              this.actionabilityFailure ??= "frame_chain_unavailable";
              return null;
            }
          } else {
            await this.scrollIntoView(backendNodeId, route);
          }
          previous = null;
          await delay(AUTO_WAIT_POLL_MS);
          continue;
        }
        // stable: two equal boxes one frame apart
        if (previous && Math.abs(previous.x - box.x) < 1 && Math.abs(previous.y - box.y) < 1) {
          // Inline links wrap across lines: their bbox centre can fall in the gap
          // *between* line fragments and hit-test to a different element (seen live
          // on footer links → stale_target). Try each rendered fragment's centre
          // (getClientRects) and the bbox centre; the first point that actually
          // hit-tests to this node (or a descendant) wins.
          if (framedTarget && !(await this.locallyActionable(backendNodeId, route))) {
            this.actionabilityFailure = "target_local_hit_failed";
            return null;
          }
          const candidates = framedTarget
            ? await this.localCandidatePoints(backendNodeId, route)
            : await this.candidatePoints(backendNodeId, route);
          let framedCandidateOutsideRoot = false;
          for (const pt of candidates) {
            const composed = framedTarget && embeddingFrames
              ? this.composeThroughEmbeddingFrames(pt, embeddingFrames)
              : pt;
            const x = Math.round(composed.x);
            const y = Math.round(composed.y);
            if (x < 0 || x > vw || y < 0 || y > vh) {
              if (framedTarget) framedCandidateOutsideRoot = true;
              continue;
            }
            if (framedTarget) {
              if (!embeddingFrames || !this.embeddingTopologyMatches(route, embeddingFrames.routes)) {
                this.actionabilityFailure = "frame_topology_changed";
                return null;
              }
              if (!route.targetId || !route.frameId) return null;
              this.framedPointProof = Object.freeze({
                targetId: route.targetId,
                frameId: route.frameId,
                sessionId: route.sessionId ?? null,
                point: Object.freeze({ x, y }),
                frames: embeddingFrames,
              });
              return { x, y };
            }
            if (await this.hitTestTarget(backendNodeId, x, y, route)) return { x, y };
          }
          if (framedTarget && framedCandidateOutsideRoot && rescrolls < 3) {
            rescrolls += 1;
            await this.scrollIntoView(backendNodeId, route);
            embeddingFrames = await this.prepareEmbeddingFrames(route);
            if (!embeddingFrames) {
              this.actionabilityFailure ??= "frame_chain_unavailable";
              return null;
            }
            previous = null;
            await delay(AUTO_WAIT_POLL_MS);
            continue;
          }
        }
        previous = box;
      }
      await delay(AUTO_WAIT_POLL_MS);
    }
    this.actionabilityFailure ??= framedTarget ? "target_geometry_unavailable" : "target_moved";
    return null;
  }

  async prepareEmbeddingFrames(route: TargetRoute): Promise<PreparedEmbeddingFrames | null> {
    if (!route.targetId || !route.frameId) return null;
    let owners: ReadonlyArray<IframeOwnerRoute>;
    try {
      owners = this.embeddingOwnerRoutes(route);
    } catch {
      this.actionabilityFailure = "frame_topology_unavailable";
      return null;
    }
    if (owners.length === 0) {
      this.actionabilityFailure = "frame_topology_unavailable";
      return null;
    }
    // Phase one mutates scroll state only. A later nested owner scroll can move
    // an earlier owner in its parent viewport, so no geometry from this phase
    // is eligible for the final point proof.
    for (const owner of owners) {
      if (!owner) {
        this.actionabilityFailure = "frame_topology_unavailable";
        return null;
      }
      const ownerRoute: TargetRoute = { targetId: owner.targetId, sessionId: owner.sessionId, frameId: owner.frameId };
      const backendNodeId = await this.frameOwnerBackendNodeId(owner);
      if (backendNodeId === null) {
        this.actionabilityFailure = "frame_owner_unavailable";
        return null;
      }
      await this.scrollIntoView(backendNodeId, ownerRoute);
    }

    // Phase two re-resolves and proves every owner after all scroll mutations
    // have completed, keeping the captured geometry internally consistent.
    const geometries: IframeOwnerGeometry[] = [];
    for (let index = 0; index < owners.length; index += 1) {
      const owner = owners[index];
      if (!owner) {
        this.actionabilityFailure = "frame_topology_unavailable";
        return null;
      }
      const ownerRoute: TargetRoute = { targetId: owner.targetId, sessionId: owner.sessionId, frameId: owner.frameId };
      const backendNodeId = await this.frameOwnerBackendNodeId(owner);
      if (backendNodeId === null) {
        this.actionabilityFailure = "frame_owner_unavailable";
        return null;
      }
      if (!(await this.locallyActionable(backendNodeId, ownerRoute))) {
        this.actionabilityFailure = "frame_owner_hit_failed";
        return null;
      }
      const geometry = await this.iframeOwnerGeometry(backendNodeId, ownerRoute);
      if (!geometry) {
        this.actionabilityFailure = "frame_owner_geometry_unavailable";
        return null;
      }
      const childOwner = owners[index + 1];
      const childRoute: TargetRoute = childOwner
        ? { targetId: childOwner.targetId, sessionId: childOwner.sessionId }
        : route;
      if (childRoute.sessionId && childRoute.targetId !== owner.targetId) {
        const childWidth = await this.evalNumber("window.innerWidth", childRoute);
        const childHeight = await this.evalNumber("window.innerHeight", childRoute);
        if (!sameCssPixelSize(geometry.viewportWidth, childWidth)
          || !sameCssPixelSize(geometry.viewportHeight, childHeight)) {
          this.actionabilityFailure = "frame_viewport_mismatch";
          return null;
        }
      }
      geometries.push(geometry);
    }
    if (!this.embeddingTopologyMatches(route, owners)) {
      this.actionabilityFailure = "frame_topology_changed";
      return null;
    }
    return Object.freeze({ routes: Object.freeze([...owners]), geometries: Object.freeze(geometries) });
  }

  embeddingTopologyMatches(route: TargetRoute, expected: ReadonlyArray<IframeOwnerRoute>): boolean {
    if (!route.targetId || !route.frameId) return false;
    try {
      const current = this.embeddingOwnerRoutes(route);
      return current.length === expected.length && current.every((owner, index) => {
        const prior = expected[index];
        return Boolean(prior
          && owner.targetId === prior.targetId
          && owner.sessionId === prior.sessionId
          && owner.frameId === prior.frameId);
      });
    } catch {
      return false;
    }
  }

  embeddingOwnerRoutes(route: TargetRoute): ReadonlyArray<IframeOwnerRoute> {
    if (!route.targetId || !route.frameId) return [];
    return this.targetRegistry.embeddingOwnerRoutes(route.targetId, route.frameId);
  }

  async frameOwnerBackendNodeId(owner: IframeOwnerRoute): Promise<number | null> {
    const ownerRoute: TargetRoute = { targetId: owner.targetId, sessionId: owner.sessionId, frameId: owner.frameId };
    const result = await this.cdp("DOM.getFrameOwner", { frameId: owner.frameId }, ownerRoute).catch(() => null);
    const directBackendNodeId = result?.backendNodeId;
    if (typeof directBackendNodeId === "number" && Number.isSafeInteger(directBackendNodeId)) return directBackendNodeId;
    const ownerNodeId = result?.nodeId;
    if (typeof ownerNodeId !== "number" || !Number.isSafeInteger(ownerNodeId)) return null;
    const described = await this.cdp("DOM.describeNode", { nodeId: ownerNodeId }, ownerRoute).catch(() => null);
    const describedBackendNodeId = described?.node?.backendNodeId;
    return typeof describedBackendNodeId === "number" && Number.isSafeInteger(describedBackendNodeId)
      ? describedBackendNodeId
      : null;
  }

  async verifyFramedPoint(backendNodeId: number, route: TargetRoute, point: Point): Promise<boolean> {
    const proof = this.framedPointProof;
    if (!proof || !route.targetId || !route.frameId
      || proof.targetId !== route.targetId
      || proof.frameId !== route.frameId
      || proof.sessionId !== (route.sessionId ?? null)
      || proof.point.x !== point.x
      || proof.point.y !== point.y
      || !this.embeddingTopologyMatches(route, proof.frames.routes)) {
      this.actionabilityFailure = "frame_topology_changed";
      return false;
    }
    let localX = point.x;
    let localY = point.y;
    for (let index = 0; index < proof.frames.routes.length; index += 1) {
      const owner = proof.frames.routes[index];
      const priorGeometry = proof.frames.geometries[index];
      if (!owner || !priorGeometry) {
        this.actionabilityFailure = "frame_topology_changed";
        return false;
      }
      const ownerRoute: TargetRoute = { targetId: owner.targetId, sessionId: owner.sessionId, frameId: owner.frameId };
      const ownerBackendNodeId = await this.frameOwnerBackendNodeId(owner);
      if (ownerBackendNodeId === null) {
        this.actionabilityFailure = "frame_owner_unavailable";
        return false;
      }
      const geometry = await this.iframeOwnerGeometry(ownerBackendNodeId, ownerRoute);
      if (!geometry || !sameFrameGeometry(geometry, priorGeometry)) {
        this.actionabilityFailure = "frame_owner_geometry_changed";
        return false;
      }
      if (!(await this.runtimeHitTestTarget(ownerBackendNodeId, localX, localY, ownerRoute))) {
        this.actionabilityFailure = "frame_owner_hit_failed";
        return false;
      }
      localX -= geometry.x;
      localY -= geometry.y;
    }
    if (!(await this.runtimeHitTestTarget(backendNodeId, localX, localY, route))) {
      this.actionabilityFailure = "target_local_hit_failed";
      return false;
    }
    if (!this.embeddingTopologyMatches(route, proof.frames.routes)) {
      this.actionabilityFailure = "frame_topology_changed";
      return false;
    }
    return true;
  }

  targetMainViewportPoint(route: TargetRoute, rootPoint: Point): Point | null {
    const proof = this.framedPointProof;
    if (!proof || !route.targetId || !route.frameId || !route.sessionId
      || proof.targetId !== route.targetId
      || proof.frameId !== route.frameId
      || proof.sessionId !== route.sessionId
      || proof.point.x !== rootPoint.x
      || proof.point.y !== rootPoint.y
      || !Number.isFinite(proof.point.x)
      || !Number.isFinite(proof.point.y)
      || Math.round(proof.point.x) !== proof.point.x
      || Math.round(proof.point.y) !== proof.point.y
      || this.targetRegistry.targetForSession(route.sessionId)?.targetId !== route.targetId
      || !this.embeddingTopologyMatches(route, proof.frames.routes)) {
      this.actionabilityFailure = "frame_input_route_unavailable";
      return null;
    }
    // Input coordinates in a child session are relative to that target's main
    // viewport. Subtract only the ancestor-owned prefix from the exact rounded
    // root point retained by the actionability proof. Any same-process frames
    // inside the target form a contiguous suffix and remain part of the target-
    // local coordinate.
    let x = proof.point.x;
    let y = proof.point.y;
    let enteredTarget = false;
    let targetViewport: IframeOwnerGeometry | null = null;
    for (let index = 0; index < proof.frames.routes.length; index += 1) {
      const owner = proof.frames.routes[index];
      const geometry = proof.frames.geometries[index];
      if (!owner || !geometry) {
        this.actionabilityFailure = "frame_input_route_unavailable";
        return null;
      }
      if (owner.targetId === route.targetId) {
        enteredTarget = true;
        continue;
      }
      if (enteredTarget) {
        this.actionabilityFailure = "frame_input_route_unavailable";
        return null;
      }
      x -= geometry.x;
      y -= geometry.y;
      targetViewport = geometry;
    }
    if (!targetViewport || !Number.isFinite(x) || !Number.isFinite(y)
      || !Number.isFinite(targetViewport.viewportWidth) || targetViewport.viewportWidth <= 0
      || !Number.isFinite(targetViewport.viewportHeight) || targetViewport.viewportHeight <= 0
      || x < 0 || x > targetViewport.viewportWidth
      || y < 0 || y > targetViewport.viewportHeight) {
      this.actionabilityFailure = "frame_input_point_invalid";
      return null;
    }
    return { x, y };
  }

  pointerInputRoute(route: TargetRoute, rootPoint: Point): Readonly<{ mode: "root" | "target"; point: Point }> | null {
    if (this.targetInputMode(route) === "root") return Object.freeze({ mode: "root", point: rootPoint });
    const point = this.targetMainViewportPoint(route, rootPoint);
    return point ? Object.freeze({ mode: "target", point: Object.freeze(point) }) : null;
  }

  targetInputMode(route: TargetRoute): "root" | "target" {
    return typeof route.frameId === "string" && route.frameId.length > 0 && typeof route.sessionId === "string" && route.sessionId.length > 0
      ? "target"
      : "root";
  }

  composeThroughEmbeddingFrames<T extends Point | Box>(value: T, frames: PreparedEmbeddingFrames): T {
    let x = value.x;
    let y = value.y;
    for (let index = frames.geometries.length - 1; index >= 0; index -= 1) {
      const geometry = frames.geometries[index];
      if (!geometry) continue;
      x += geometry.x;
      y += geometry.y;
    }
    return { ...value, x, y };
  }

  async iframeOwnerGeometry(backendNodeId: number, route: TargetRoute): Promise<IframeOwnerGeometry | null> {
    const objectId = await this.objectIdFor(backendNodeId, route);
    if (!objectId) return null;
    const result = await this.cdp("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: `function () {
        try {
          let cursor = this;
          let depth = 0;
          while (cursor) {
            if (depth >= 64) return null;
            const cursorStyle = window.getComputedStyle(cursor);
            if (cursorStyle.transform !== "none" || cursorStyle.perspective !== "none"
              || (cursorStyle.zoom !== "1" && cursorStyle.zoom !== "normal")) return null;
            const root = cursor.getRootNode();
            cursor = cursor.parentElement || (root && root.host) || null;
            depth += 1;
          }
          if (window.visualViewport && window.visualViewport.scale !== 1) return null;
          const rect = Element.prototype.getBoundingClientRect.call(this);
          const style = window.getComputedStyle(this);
          return {
            x: rect.left + this.clientLeft,
            y: rect.top + this.clientTop,
            viewportWidth: this.clientWidth,
            viewportHeight: this.clientHeight,
            renderedWidth: rect.width,
            renderedHeight: rect.height,
            layoutWidth: this.offsetWidth,
            layoutHeight: this.offsetHeight,
            transform: style.transform,
            zoom: style.zoom,
            axisAligned: true,
          };
        } catch (e) { return null; }
      }`,
      returnByValue: true,
    }, route).catch(() => null);
    const value = result?.result?.value;
    if (!value || typeof value !== "object") return null;
    const x = finiteNumber(value.x);
    const y = finiteNumber(value.y);
    const viewportWidth = finiteNumber(value.viewportWidth);
    const viewportHeight = finiteNumber(value.viewportHeight);
    const renderedWidth = finiteNumber(value.renderedWidth);
    const renderedHeight = finiteNumber(value.renderedHeight);
    const layoutWidth = finiteNumber(value.layoutWidth);
    const layoutHeight = finiteNumber(value.layoutHeight);
    if (x === null || y === null || viewportWidth === null || viewportHeight === null
      || renderedWidth === null || renderedHeight === null || layoutWidth === null || layoutHeight === null
      || viewportWidth <= 0 || viewportHeight <= 0 || renderedWidth <= 0 || renderedHeight <= 0
      || layoutWidth <= 0 || layoutHeight <= 0
      || value.axisAligned !== true
      || value.transform !== "none"
      || (value.zoom !== "1" && value.zoom !== "normal")
      || !sameCssPixelSize(renderedWidth, layoutWidth)
      || !sameCssPixelSize(renderedHeight, layoutHeight)) return null;
    return Object.freeze({ x, y, viewportWidth, viewportHeight });
  }

  async locallyActionable(backendNodeId: number, route: TargetRoute): Promise<boolean> {
    const vh = (await this.evalNumber("window.innerHeight", route)) || 0;
    const vw = (await this.evalNumber("window.innerWidth", route)) || 0;
    if (vh <= 0 || vw <= 0) return false;
    for (const point of await this.localCandidatePoints(backendNodeId, route)) {
      const x = Math.round(point.x);
      const y = Math.round(point.y);
      if (x < 0 || x > vw || y < 0 || y > vh) continue;
      if (await this.runtimeHitTestTarget(backendNodeId, x, y, route)) return true;
    }
    return false;
  }

  async localCandidatePoints(backendNodeId: number, route: TargetRoute): Promise<Point[]> {
    const objectId = await this.objectIdFor(backendNodeId, route);
    if (!objectId) return [];
    const result = await this.cdp("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: `function () {
        const out = [];
        const push = (r) => {
          if (r && r.width > 0 && r.height > 0) out.push({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
        };
        try { for (const r of this.getClientRects()) push(r); } catch (e) {}
        try { push(this.getBoundingClientRect()); } catch (e) {}
        return out;
      }`,
      returnByValue: true,
    }, route).catch(() => null);
    const points = result?.result?.value;
    return Array.isArray(points)
      ? points.filter((point) => Number.isFinite(point?.x) && Number.isFinite(point?.y))
      : [];
  }

  async localBoxFor(backendNodeId: number, route: TargetRoute): Promise<Box | null> {
    const objectId = await this.objectIdFor(backendNodeId, route);
    if (!objectId) return null;
    const result = await this.cdp("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: `function () {
        try {
          const rect = Element.prototype.getBoundingClientRect.call(this);
          return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
        } catch (e) { return null; }
      }`,
      returnByValue: true,
    }, route).catch(() => null);
    const value = result?.result?.value;
    if (!value || typeof value !== "object") return null;
    const x = finiteNumber(value.x);
    const y = finiteNumber(value.y);
    const width = finiteNumber(value.width);
    const height = finiteNumber(value.height);
    return x === null || y === null || width === null || height === null || width <= 0 || height <= 0
      ? null
      : { x, y, width, height };
  }

  // Viewport-relative click candidates for a node, ordered most-specific first:
  // the centre of each rendered line fragment (getClientRects — one rect per
  // wrapped line for inline content), then the bounding-box centre as a fallback.
  // This is what makes off-screen / multi-line inline links reliably clickable.
  async candidatePoints(backendNodeId: number, route: TargetRoute = {}): Promise<Point[]> {
    const quads = await this.cdp("DOM.getContentQuads", { backendNodeId }, route).catch(() => null);
    const cdpPoints = centersForQuads(quads?.quads);
    if (cdpPoints.length > 0) return cdpPoints;
    const objectId = await this.objectIdFor(backendNodeId, route);
    if (!objectId) return [];
    const res = await this.cdp("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: `function () {
        const out = [];
        const push = (r) => {
          if (r && r.width > 0 && r.height > 0) {
            out.push({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
          }
        };
        try { for (const r of this.getClientRects()) push(r); } catch (e) {}
        try { push(this.getBoundingClientRect()); } catch (e) {}
        return out;
      }`,
      returnByValue: true,
    }, route).catch(() => null);
    const pts = res?.result?.value;
    return Array.isArray(pts) ? pts.filter((p) => Number.isFinite(p?.x) && Number.isFinite(p?.y)) : [];
  }

  async scrollIntoView(backendNodeId: number, route: TargetRoute = {}): Promise<void> {
    const objectId = await this.objectIdFor(backendNodeId, route);
    if (!objectId) return;
    await this.cdp("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: `function () { try { this.scrollIntoView({ block: "center", inline: "center" }); } catch (e) {} }`,
    }, route).catch(() => {});
  }

  async boxFor(backendNodeId: number, route: TargetRoute = {}): Promise<Box | null> {
    const quads = await this.cdp("DOM.getContentQuads", { backendNodeId }, route).catch(() => null);
    const quadBox = boundsForQuads(quads?.quads);
    if (quadBox) return quadBox;
    const objectId = await this.objectIdFor(backendNodeId, route);
    if (objectId) {
      const rect = await this.cdp("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: `function () {
          const rect = this.getBoundingClientRect();
          return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        }`,
        returnByValue: true,
      }, route).catch(() => null);
      const value = rect?.result?.value;
      if (
        value
        && Number.isFinite(value.x)
        && Number.isFinite(value.y)
        && Number.isFinite(value.width)
        && Number.isFinite(value.height)
      ) {
        return { x: value.x, y: value.y, width: value.width, height: value.height };
      }
    }

    const model = await this.cdp("DOM.getBoxModel", { backendNodeId }, route).catch(() => null);
    const quad = model?.model?.content;
    if (!quad || quad.length < 8) return null;
    const xs = [quad[0], quad[2], quad[4], quad[6]];
    const ys = [quad[1], quad[3], quad[5], quad[7]];
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    const scrollX = await this.evalNumber("window.scrollX", route);
    const scrollY = await this.evalNumber("window.scrollY", route);
    return { x: x - scrollX, y: y - scrollY, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
  }

  async hitTestTarget(backendNodeId: number, x: number, y: number, route: TargetRoute = {}): Promise<boolean> {
    const hit = await this.cdp("DOM.getNodeForLocation", {
      x: Math.round(x),
      y: Math.round(y),
      includeUserAgentShadowDOM: true,
      ignorePointerEventsNone: false,
    }, route).catch(() => null);
    const hitBackendNodeId = hit?.backendNodeId;
    if (typeof hitBackendNodeId !== "number" || !Number.isInteger(hitBackendNodeId)) return this.runtimeHitTestTarget(backendNodeId, x, y, route);
    if (hitBackendNodeId === backendNodeId) return true;
    const objectId = await this.objectIdFor(backendNodeId, route);
    const hitObjectId = await this.objectIdFor(hitBackendNodeId, route);
    if (objectId && hitObjectId) {
      const result = await this.cdp("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: "function (hit) { return Boolean(hit && (hit === this || this.contains(hit))); }",
        arguments: [{ objectId: hitObjectId }],
        returnByValue: true,
      }, route).catch(() => null);
      if (result?.result?.value === true) return true;
    }
    return this.runtimeHitTestTarget(backendNodeId, x, y, route);
  }

  async runtimeHitTestTarget(backendNodeId: number, x: number, y: number, route: TargetRoute = {}): Promise<boolean> {
    const objectId = await this.objectIdFor(backendNodeId, route);
    if (!objectId) return false;
    const result = await this.cdp("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: `function (x, y) {
        const hit = document.elementFromPoint(x, y);
        return Boolean(hit && (hit === this || this.contains(hit)));
      }`,
      arguments: [{ value: x }, { value: y }],
      returnByValue: true,
    }, route).catch(() => null);
    return Boolean(result?.result?.value);
  }

  async blockingElementEvidence(point: Point, route: TargetRoute = {}): Promise<DriverRecord | null> {
    const hit = await this.cdp("DOM.getNodeForLocation", {
      x: Math.round(point.x),
      y: Math.round(point.y),
      includeUserAgentShadowDOM: true,
      ignorePointerEventsNone: false,
    }, route).catch(() => null);
    const backendNodeId = hit?.backendNodeId;
    if (!Number.isInteger(backendNodeId)) return null;
    const [facts, name, described] = await Promise.all([
      this.elementFacts(backendNodeId, route).catch((): CdpRecord => ({})),
      this.axNameFor(backendNodeId, route).catch(() => ""),
      this.cdp("DOM.describeNode", { backendNodeId }, route).catch(() => null),
    ]);
    const tag = String(described?.node?.localName || described?.node?.nodeName || "").toLowerCase().slice(0, 40);
    return {
      role: String(facts?.role || "").slice(0, 40),
      name: String(name || facts?.accessibleName || "").replace(/\s+/g, " ").trim().slice(0, 160),
      tag,
      point: { x: Math.round(point.x), y: Math.round(point.y) },
      frame: {
        ...(route?.targetId ? { targetId: String(route.targetId).slice(0, 160) } : {}),
        ...(route?.frameId ? { frameId: String(route.frameId).slice(0, 160) } : {}),
        ...(Number.isSafeInteger(route?.documentEpoch) ? { documentEpoch: route.documentEpoch } : {}),
      },
    };
  }

  async objectIdFor(backendNodeId: number, route: TargetRoute = {}): Promise<string | null> {
    const resolved = await this.cdp("DOM.resolveNode", { backendNodeId }, route).catch(() => null);
    return typeof resolved?.object?.objectId === "string" ? resolved.object.objectId : null;
  }

  async resolveMaskTargets(zones: NonNullable<BrowserAction["sensitiveZones"]>): Promise<TargetResolution[]> {
    if (!Array.isArray(zones) || zones.length === 0 || zones.length > 32) throw new Error("mask_application_failed");
    const targets: TargetResolution[] = [];
    const identities = new Set<string>();
    for (const zone of zones) {
      // Sensitive zones support an observed ref as well as semantic/configured
      // matching. Keep the discriminator on the action itself so a union spread
      // cannot widen the target into an invalid partial union.
      const target = await this.resolveTarget({ kind: "wait_for", ...zone, exact: true });
      if (!target || typeof target.backendNodeId !== "number" || !Number.isSafeInteger(target.backendNodeId)) {
        throw new Error("mask_target_unavailable");
      }
      const identity = `${target.targetId ?? "root"}:${target.frameId ?? "root"}:${target.backendNodeId}`;
      if (identities.has(identity)) continue;
      identities.add(identity);
      targets.push(target);
    }
    if (targets.length === 0) throw new Error("mask_target_unavailable");
    return targets;
  }

  async maskRegionsForTargets(targets: readonly TargetResolution[], rootScroll: Point): Promise<Box[]> {
    const regions: Box[] = [];
    for (const target of targets) {
      const backendNodeId = target.backendNodeId;
      if (typeof backendNodeId !== "number") throw new Error("mask_target_unavailable");
      const local = await this.viewportBoxForMask(backendNodeId, target);
      if (!local) throw new Error("mask_target_geometry_unavailable");
      let x = local.x;
      let y = local.y;
      if (target.frameId) {
        let owners: ReadonlyArray<IframeOwnerRoute>;
        try {
          owners = this.embeddingOwnerRoutes(target);
        } catch {
          throw new Error("mask_frame_topology_unavailable");
        }
        if (owners.length === 0) throw new Error("mask_frame_topology_unavailable");
        for (const owner of owners) {
          const ownerRoute: TargetRoute = { targetId: owner.targetId, sessionId: owner.sessionId, frameId: owner.frameId };
          const ownerBackendNodeId = await this.frameOwnerBackendNodeId(owner);
          if (ownerBackendNodeId === null) throw new Error("mask_frame_owner_unavailable");
          const geometry = await this.iframeOwnerGeometry(ownerBackendNodeId, ownerRoute);
          if (!geometry) throw new Error("mask_frame_geometry_unavailable");
          x += geometry.x;
          y += geometry.y;
        }
        if (!this.embeddingTopologyMatches(target, owners)) throw new Error("mask_frame_topology_changed");
      }
      const region = {
        x: x + rootScroll.x - MASK_REGION_PADDING_CSS,
        y: y + rootScroll.y - MASK_REGION_PADDING_CSS,
        width: local.width + MASK_REGION_PADDING_CSS * 2,
        height: local.height + MASK_REGION_PADDING_CSS * 2,
      };
      if (![region.x, region.y, region.width, region.height].every(Number.isFinite)
        || region.width <= 0 || region.height <= 0) {
        throw new Error("mask_target_geometry_unavailable");
      }
      regions.push(region);
    }
    return regions;
  }

  async viewportBoxForMask(backendNodeId: number, route: TargetRoute): Promise<Box | null> {
    const objectId = await this.objectIdFor(backendNodeId, route);
    if (!objectId) return null;
    const measured = await this.cdp("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: `function () {
        const rect = this.getBoundingClientRect();
        const style = getComputedStyle(this);
        return {
          x: rect.x, y: rect.y, width: rect.width, height: rect.height,
          visible: style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) > 0,
          connected: this.isConnected === true,
        };
      }`,
      returnByValue: true,
    }, route).catch(() => null);
    const value = measured?.result?.value;
    if (!value || value.visible !== true || value.connected !== true
      || ![value.x, value.y, value.width, value.height].every(Number.isFinite)
      || value.width <= 0 || value.height <= 0) return null;
    return { x: value.x, y: value.y, width: value.width, height: value.height };
  }

  async waitForSettle(timeoutMs = SETTLE_TIMEOUT_MS) {
    const boundedTimeout = Math.max(100, Math.min(Number(timeoutMs) || SETTLE_TIMEOUT_MS, SETTLE_TIMEOUT_MS));
    const deadline = Date.now() + boundedTimeout;
    let last = "";
    let stable = 0;
    while (Date.now() < deadline) {
      const fingerprint = await this.evalString(
        `(() => {
          return document.readyState + ":" + location.href + ":" + document.documentElement.childElementCount;
        })()`,
      );
      if (fingerprint.startsWith("complete") && this.networkInFlight.size === 0 && fingerprint === last) {
        stable += 1;
        if (stable >= 2) return;
      } else {
        stable = 0;
      }
      last = fingerprint;
      await delay(AUTO_WAIT_POLL_MS);
    }
  }

  async settleShort() {
    await this.waitForSettle(750);
  }

  async evalString(expression: string, route: TargetRoute = {}): Promise<string> {
    const result = await this.cdp("Runtime.evaluate", { expression, returnByValue: true }, route).catch(() => null);
    return typeof result?.result?.value === "string" ? result.result.value : "";
  }

  async evalNumber(expression: string, route: TargetRoute = {}): Promise<number> {
    const result = await this.cdp("Runtime.evaluate", { expression, returnByValue: true }, route).catch(() => null);
    return typeof result?.result?.value === "number" ? result.result.value : 0;
  }

  async evalBool(expression: string, route: TargetRoute = {}): Promise<boolean> {
    const result = await this.cdp("Runtime.evaluate", { expression, returnByValue: true }, route).catch(() => null);
    return Boolean(result?.result?.value);
  }

  async waitForCondition(waitFor: BrowserWaitFor | DriverAction | undefined, actionTimeoutMs?: number): Promise<WaitResult> {
    const timeoutMs = Math.max(100, Math.min(Number(waitFor?.timeoutMs ?? actionTimeoutMs ?? AUTO_WAIT_TIMEOUT_MS) || AUTO_WAIT_TIMEOUT_MS, 120000));
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.waitConditionMet(waitFor)) return { matched: true };
      await delay(AUTO_WAIT_POLL_MS);
    }
    return { matched: false, reason: "timed_out" };
  }

  async waitConditionMet(waitFor: BrowserWaitFor | DriverAction | undefined): Promise<boolean> {
    const wait = normalizedWaitFor(waitFor);
    if (!wait) {
      await this.waitForSettle();
      return true;
    }
    if (wait.url) {
      const href = await this.evalString("location.href");
      if (href.includes(wait.url)) return true;
    }
    if (wait.title) {
      const title = await this.evalString("document.title");
      if (title.toLowerCase().includes(wait.title.toLowerCase())) return true;
    }
    if (wait.text) {
      const found = await this.evalBool(textWaitExpression(wait.text));
      return wait.state === "hidden" || wait.state === "detached" ? !found : found;
    }
    if (wait.selector) {
      const selectorState = await this.selectorState(wait.selector);
      if (wait.state === "detached") return !selectorState.attached;
      if (wait.state === "hidden") return !selectorState.visible;
      if (wait.state === "attached") return selectorState.attached;
      if ((wait.state === undefined || wait.state === "visible") && wait.value === undefined) {
        return selectorState.visible;
      }
    }
    if (wait.ref || wait.role || wait.name || wait.selector) {
      const target = await this.resolveTarget({
        kind: "wait_for",
        ...(wait.selector ? { selector: wait.selector }
          : wait.ref ? { ref: wait.ref }
            : { role: wait.role ?? "", ...(wait.name !== undefined ? { name: wait.name } : {}) }),
      });
      if (target?.backendNodeId) {
        const state = await this.elementState(target.backendNodeId, target);
        if (wait.state === "checked") return state.checked === true;
        if (wait.state === "unchecked") return state.checked === false;
        if (wait.value !== undefined) return String(state.value ?? "").includes(wait.value);
        return true;
      }
    }
    return false;
  }

  async selectorState(selector: string): Promise<{ attached: boolean; visible: boolean }> {
    const result = await this.cdp("Runtime.evaluate", {
      expression: `(() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        if (!element) return { attached: false, visible: false };
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return {
          attached: element.isConnected === true,
          visible: style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) > 0 && rect.width > 0 && rect.height > 0,
        };
      })()`,
      returnByValue: true,
    });
    if (result?.exceptionDetails) {
      const detail = `${result.exceptionDetails.text ?? ""} ${result.exceptionDetails.exception?.description ?? ""}`;
      if (isInvalidSelectorError(detail)) throw typedDriverError("invalid_selector");
      throw typedDriverError("target_resolution_failed");
    }
    const value = result?.result?.value;
    return {
      attached: value?.attached === true,
      visible: value?.visible === true,
    };
  }

  async pageSignature(): Promise<PageSignature> {
    return {
      url: await this.evalString("location.href"),
      title: await this.evalString("document.title"),
    };
  }

  async elementState(backendNodeId: number, route: TargetRoute = {}): Promise<CdpRecord> {
    const objectId = await this.objectIdFor(backendNodeId, route);
    if (!objectId) return {};
    const state = await this.cdp("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: `function () {
        return {
          value: typeof this.value === "string" ? this.value : "",
          checked: Boolean(this.checked),
          ariaChecked: this.getAttribute("aria-checked") || "",
          ariaPressed: this.getAttribute("aria-pressed") || "",
          text: (this.innerText || this.textContent || "").slice(0, 160),
        };
      }`,
      returnByValue: true,
    }, route).catch(() => null);
    return state?.result?.value && typeof state.result.value === "object" ? state.result.value : {};
  }

  withObservationMeta(status: string, changed: ChangeRecord, observation: DriverObservation, reason?: string): DriverRecord {
    return {
      status,
      changed: changed ?? {},
      ...(reason ? { reason } : {}),
      observation: {
        ...observation,
        ...(reason ? { reason } : {}),
        ...(changed && Object.keys(changed).length > 0 ? { changed } : {}),
        // Surface a still-open dialog so the agent knows it must accept/dismiss
        // before the renderer will respond again.
        ...(this.pendingDialog ? { pendingDialog: this.pendingDialog } : {}),
      },
    };
  }

  async targetMoved(status = "stale_target", reason?: string): Promise<DriverRecord> {
    const observation = await this.observe({});
    return this.withObservationMeta(status, {}, observation, reason ?? (status === "not_found" ? "target_not_found" : "target_moved"));
  }

  async inputDispatchUncertain(): Promise<DriverRecord> {
    const observation = await this.observe({}).catch(() => ({
      kind: "observation",
      mode: "cdp",
      origin: safeOrigin(this.lastObserveUrl ?? ""),
      title: "",
      nodes: [],
      nodeCount: 0,
      truncated: false,
      capturedAt: new Date().toISOString(),
    }));
    return this.withObservationMeta("dispatched_unverified", {}, observation, "input_dispatch_uncertain");
  }

  refreshPendingDialog(): void {
    const latest = [...this.pendingDialogs.values()].at(-1) ?? null;
    this.pendingDialog = latest?.dialog ?? null;
    this.pendingDialogRoute = latest?.route ?? null;
  }

  beginActionSignals(): ActionSignalWindow {
    const previous = this.activeActionSignals;
    const signals: ActiveActionSignals = {};
    let finished = false;
    this.activeActionSignals = signals;
    return {
      finish: () => {
        if (!finished) {
          finished = true;
          if (this.activeActionSignals === signals) this.activeActionSignals = previous;
        }
        return { ...signals };
      },
    };
  }
}

function axObservationStates(axNode: CdpRecord): ChangeRecord {
  const properties = new Map<string, unknown>((axNode?.properties ?? []).map((property: CdpRecord) => [String(property?.name ?? ""), property?.value?.value]));
  const output: ChangeRecord = {};
  for (const name of ["disabled", "selected", "expanded", "required"]) {
    if (typeof properties.get(name) === "boolean") output[name] = properties.get(name);
  }
  const checked = properties.get("checked");
  if (typeof checked === "boolean" || checked === "mixed") output.checked = checked;
  const level = Number(properties.get("level"));
  if (Number.isSafeInteger(level) && level > 0 && level <= 9) output.level = level;
  return output;
}

function publicNodeFacts(facts: CdpRecord, routeOrigin?: string): DriverRecord {
  const localName = String(facts?.localName ?? "").slice(0, 80);
  const attributes: CdpRecord = facts?.attributes && typeof facts.attributes === "object" ? facts.attributes : {};
  const elementType = localName === "input" && attributes.type
    ? `input:${String(attributes.type).toLowerCase().slice(0, 40)}`
    : localName;
  let href: string | undefined;
  if (typeof attributes.href === "string" && routeOrigin) {
    try {
      const destination = new URL(attributes.href, `${routeOrigin}/`);
      if (destination.origin === routeOrigin) {
        destination.username = "";
        destination.password = "";
        destination.search = "";
        destination.hash = "";
        href = destination.toString();
      }
    } catch {}
  }
  return {
    ...(elementType ? { elementType } : {}),
    ...(href ? { href } : {}),
  };
}

// Compute a compact observation delta (D6). `added` are nodes whose ref is new
// (carry full node incl. bbox for targeting); `removed` are refs gone; `updated`
// are refs whose accessible name/value changed. bbox is deliberately NOT a change
// signal — it is viewport-relative and a scroll would make every node "changed".
function computeObservationDelta(baseline: Map<string, ObservationNodeSnapshot>, nodes: DriverObservationNode[]): { added: DriverObservationNode[]; removed: string[]; updated: DriverRecord[] } {
  const added: DriverObservationNode[] = [];
  const updated: DriverRecord[] = [];
  const seen = new Set<string>();
  for (const node of nodes) {
    seen.add(node.ref);
    const prev = baseline.get(node.ref);
    if (!prev) { added.push(node); continue; }
    const current = observationNodeSnapshot(node);
    if (JSON.stringify(current.state) !== JSON.stringify(prev.state)) {
      updated.push({ ref: node.ref, ...current.state });
    }
  }
  const removed: string[] = [];
  for (const ref of baseline.keys()) if (!seen.has(ref)) removed.push(ref);
  return { added, removed, updated };
}

function safeOrigin(url: unknown): string {
  try {
    const parsed = new URL(String(url));
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    return parsed.origin;
  } catch {
    return "";
  }
}

function requireHttpNavigationUrl(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 8192 || value !== value.trim()) {
    throw typedDriverError("invalid_navigation_url");
  }
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error();
    return parsed.href;
  } catch {
    throw typedDriverError("invalid_navigation_url");
  }
}

function safeLoaderId(value: unknown): string | null {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > 128
    || /[\u0000-\u0020\u007f]/.test(value)
  ) return null;
  return value;
}

function isSupportedTextMime(mimeType: string): boolean {
  return mimeType.startsWith("text/")
    || mimeType === "application/json"
    || mimeType.endsWith("+json")
    || mimeType === "application/xml"
    || mimeType.endsWith("+xml")
    || mimeType === "application/javascript"
    || mimeType === "application/x-www-form-urlencoded";
}

function bodyBytes(raw: string, base64Encoded: boolean): Uint8Array {
  if (!base64Encoded) return new TextEncoder().encode(raw);
  try {
    const decoded = atob(raw);
    return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  } catch {
    return new TextEncoder().encode(raw);
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const input = new Uint8Array(bytes.byteLength);
  input.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", input.buffer);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function normalizedTarget(action: DriverAction | undefined | null): NormalizedTarget | null {
  if (!action || typeof action !== "object") return null;
  if (action.ref) return { ref: String(action.ref) };
  if (action.role) return { role: String(action.role), ...(action.name ? { name: String(action.name) } : {}), ...(action.exact ? { exact: true } : {}) };
  if (action.name) return { name: String(action.name), ...(action.exact ? { exact: true } : {}) };
  if (action.label) return { label: String(action.label), ...(action.exact ? { exact: true } : {}) };
  if (action.placeholder) return { placeholder: String(action.placeholder), ...(action.exact ? { exact: true } : {}) };
  if (action.testId) return { testId: String(action.testId) };
  if (action.selector) return { selector: String(action.selector) };
  if (action.text) return { text: String(action.text), ...(action.exact ? { exact: true } : {}) };
  if (typeof action.x === "number" && Number.isFinite(action.x) && typeof action.y === "number" && Number.isFinite(action.y)) {
    return { coordinates: { x: Math.round(action.x), y: Math.round(action.y) } };
  }
  return null;
}

function observationNodeSnapshot(node: DriverObservationNode): ObservationNodeSnapshot {
  const state: DriverRecord = {
    role: node.role,
    ...(node.name !== undefined ? { name: node.name } : {}),
    ...(node.value !== undefined ? { value: node.value } : {}),
    ...(node.disabled !== undefined ? { disabled: node.disabled } : {}),
    ...(node.checked !== undefined ? { checked: node.checked } : {}),
    ...(node.selected !== undefined ? { selected: node.selected } : {}),
    ...(node.expanded !== undefined ? { expanded: node.expanded } : {}),
    ...(node.required !== undefined ? { required: node.required } : {}),
    ...(node.level !== undefined ? { level: node.level } : {}),
    ...(node.href !== undefined ? { href: node.href } : {}),
    ...(node.elementType !== undefined ? { elementType: node.elementType } : {}),
    ...(node.documentEpoch !== undefined ? { documentEpoch: node.documentEpoch } : {}),
    ...(node.frameId !== undefined ? { frameId: node.frameId } : {}),
    ...(node.frameOrigin !== undefined ? { frameOrigin: node.frameOrigin } : {}),
  };
  return { ...state, state, ...(node.bbox !== undefined ? { bbox: node.bbox } : {}) };
}

function selectorFromAction(action: DriverAction): string | null {
  const target = normalizedTarget(action);
  if (typeof target?.selector === "string" && target.selector) return target.selector;
  const wait = normalizedWaitFor(action?.waitFor ?? (action?.kind === "wait_for" ? action : null));
  return typeof wait?.selector === "string" && wait.selector ? wait.selector : null;
}

function normalizedWaitFor(waitFor: BrowserWaitFor | DriverAction | undefined | null): NormalizedWait | null {
  if (!waitFor || typeof waitFor !== "object") return null;
  const output: NormalizedWait = {};
  for (const key of ["url", "title", "text", "selector", "role", "name", "ref", "value"] as const) {
    const value = waitFor[key as keyof typeof waitFor];
    if (typeof value === "string" && value.trim()) Object.assign(output, { [key]: value });
  }
  if ("state" in waitFor && typeof waitFor.state === "string") output.state = waitFor.state;
  if (typeof waitFor.timeoutMs === "number") output.timeoutMs = waitFor.timeoutMs;
  return Object.keys(output).length > 0 ? output : null;
}

function childFrameRecords(frameTree: CdpRecord | undefined): Array<{ frameId: string; parentFrameId: string | null; origin: string }> {
  const frames: Array<{ frameId: string; parentFrameId: string | null; origin: string }> = [];
  const visit = (tree: CdpRecord | undefined): void => {
    for (const child of tree?.childFrames ?? []) {
      const frameId = child?.frame?.id;
      if (typeof frameId !== "string") continue;
      frames.push({ frameId, parentFrameId: child.frame.parentId ?? null, origin: safeOrigin(child.frame.url) });
      visit(child);
    }
  };
  visit(frameTree);
  return frames;
}

function centersForQuads(quads: unknown): Point[] {
  if (!Array.isArray(quads)) return [];
  return quads.flatMap((quad) => {
    if (!Array.isArray(quad) || quad.length < 8 || quad.some((value) => typeof value !== "number" || !Number.isFinite(value))) return [];
    const values = quad.map(Number);
    return [{
      x: (values[0]! + values[2]! + values[4]! + values[6]!) / 4,
      y: (values[1]! + values[3]! + values[5]! + values[7]!) / 4,
    }];
  });
}

function boundsForQuads(quads: unknown): Box | null {
  if (!Array.isArray(quads)) return null;
  const points = quads.flatMap((quad) => Array.isArray(quad) ? quad : []);
  if (points.length < 8 || points.some((value) => typeof value !== "number" || !Number.isFinite(value))) return null;
  const numericPoints = points.map(Number);
  const xs = numericPoints.filter((_value, index) => index % 2 === 0);
  const ys = numericPoints.filter((_value, index) => index % 2 === 1);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

function textWaitExpression(text: string): string {
  return `(() => {
    const body = document.body;
    if (!body) return false;
    const text = String(body.innerText || body.textContent || "");
    const needle = ${JSON.stringify(String(text))};
    const normalize = (value) => String(value).replace(/\\s+/g, " ").trim();
    return text.includes(needle) || normalize(text).includes(normalize(needle));
  })()`;
}

function nodeMatchesTarget(node: DriverObservationNode, target: NormalizedTarget): boolean {
  if (!node || !target) return false;
  if (target.ref) return node.ref === target.ref;
  if (target.role && String(node.role).toLowerCase() !== String(target.role).toLowerCase()) return false;
  const name = String(node.name ?? "");
  if (target.name) return matchText(name, target.name, target.exact);
  if (target.label) return matchText(name, target.label, target.exact);
  if (target.text) return matchText(name, target.text, target.exact) || matchText(String(node.value ?? ""), target.text, target.exact);
  return Boolean(target.role);
}

function matchText(value: unknown, expected: unknown, exact?: boolean): boolean {
  const left = String(value ?? "").trim().toLowerCase();
  const right = String(expected ?? "").trim().toLowerCase();
  if (!right) return false;
  return exact ? left === right : left.includes(right);
}

function diffPage(before: PageSignature, after: PageSignature): ChangeRecord {
  const changed: ChangeRecord = {};
  if (before.url !== after.url) changed.navigated = safeOrigin(after.url);
  if (before.title !== after.title) changed.title = after.title.slice(0, 160);
  return changed;
}

function diffElement(before: CdpRecord, after: CdpRecord): ChangeRecord {
  const changed: ChangeRecord = {};
  for (const key of ["value", "checked", "ariaChecked", "ariaPressed", "text"]) {
    if (before[key] !== after[key]) changed[key] = typeof after[key] === "string" ? after[key].slice(0, 160) : after[key];
  }
  return changed;
}

// Map a CDP console/log type to a bounded level enum.
function consoleLevelFor(type: unknown): string {
  const t = String(type ?? "log");
  if (t === "warning" || t === "warn") return "warn";
  if (t === "error" || t === "assert") return "error";
  if (t === "info") return "info";
  if (t === "debug" || t === "verbose") return "debug";
  return "log";
}

// Render Runtime.consoleAPICalled args into a single line without executing getters
// or pulling object internals. Only primitive previews and CDP descriptions are used.
function consoleArgsText(args: unknown): string {
  if (!Array.isArray(args)) return "";
  return args.map((arg) => {
    if (arg == null) return "";
    if (arg.value !== undefined) return String(arg.value);
    if (arg.description !== undefined) return String(arg.description);
    if (arg.unserializableValue !== undefined) return String(arg.unserializableValue);
    return arg.type ? `[${arg.type}]` : "";
  }).join(" ").trim().slice(0, 2000);
}

function inputTargetKey(route: CdpRoute | number | null | undefined = {}): string {
  return typeof route === "object" && typeof route?.sessionId === "string" && route.sessionId ? `session:${route.sessionId}` : "root";
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function sameCssPixelSize(left: number, right: number): boolean {
  return Number.isFinite(left) && Number.isFinite(right) && left > 0 && right > 0 && Math.abs(left - right) < 0.01;
}

function sameFrameGeometry(left: IframeOwnerGeometry, right: IframeOwnerGeometry): boolean {
  return Math.abs(left.x - right.x) < 0.01
    && Math.abs(left.y - right.y) < 0.01
    && sameCssPixelSize(left.viewportWidth, right.viewportWidth)
    && sameCssPixelSize(left.viewportHeight, right.viewportHeight);
}

function dialogRoute(dialog: PendingDialogRoute | null = null): CdpRoute {
  return typeof dialog?.sessionId === "string" && dialog.sessionId ? { sessionId: dialog.sessionId } : {};
}

function typedDriverError(code: string): DriverError {
  return Object.assign(new Error(code), { code });
}

async function attachStage<T>(code: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (isPreservedAttachFailure(error)) throw error;
    throw typedDriverError(code);
  }
}

function isPreservedAttachFailure(error: unknown): error is DriverError {
  if (!isTypedDriverError(error)) return false;
  return PRESERVED_ATTACH_FAILURE_CODES.has(error.code) || error.code.startsWith("cdp_timeout_");
}

function isTypedDriverError(error: unknown): error is DriverError {
  return error instanceof Error && typeof (error as Partial<DriverError>).code === "string";
}

function isInputReleaseAcknowledgementTimeout(error: unknown): error is DriverError {
  return isTypedDriverError(error)
    && error.code === "renderer_unresponsive"
    && error.detail === "cdp_timeout_Input.dispatchMouseEvent"
    && (error as DriverError & { inputReleaseUnacknowledged?: unknown }).inputReleaseUnacknowledged === true;
}

function isInvalidSelectorError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /invalid selector|not a valid selector|failed to execute ['\"]queryselector|syntaxerror/i.test(message);
}

function reconciliationChanges(signals: ActiveActionSignals | null | undefined): ChangeRecord {
  const changed: ChangeRecord = {};
  for (const key of ["navigation", "dialog", "download", "newTarget"] as const) {
    if (signals?.[key]) changed[key] = true;
  }
  return changed;
}

function hasDirectlyObservableEffect(signals: ActiveActionSignals | null | undefined): boolean {
  return Boolean(signals?.navigation || signals?.dialog || signals?.download || signals?.newTarget);
}

function findByTestIdSource(): string {
  return `function (testId) {
    const attrs = ["data-testid", "data-test-id", "data-test"];
    const matches = Array.from(document.querySelectorAll("[data-testid],[data-test-id],[data-test]"))
      .filter((node) => attrs.some((attr) => node.getAttribute(attr) === testId));
    if (matches.length > 1) throw new Error("ambiguous");
    return matches[0] || null;
  }`;
}

function findByAttributeTextSource(): string {
  return `function (attr, value, exact) {
    const expected = String(value || "").toLowerCase();
    const found = Array.from(document.querySelectorAll("input,textarea,[role='textbox'],[contenteditable='true']"))
      .filter((node) => {
        const actual = String(node.getAttribute(attr) || "").trim().toLowerCase();
        return exact ? actual === expected : actual.includes(expected);
      });
    if (found.length > 1) throw new Error("ambiguous");
    return found[0] || null;
  }`;
}

function findByLabelSource(): string {
  return `function (value, exact) {
    const expected = String(value || "").toLowerCase();
    const matches = (text) => {
      const actual = String(text || "").trim().toLowerCase();
      return exact ? actual === expected : actual.includes(expected);
    };
    const found = [];
    for (const label of Array.from(document.querySelectorAll("label"))) {
      if (!matches(label.innerText || label.textContent)) continue;
      if (label.control) { found.push(label.control); continue; }
      const nested = label.querySelector("input,textarea,select,[contenteditable='true']");
      if (nested) found.push(nested);
    }
    found.push(...Array.from(document.querySelectorAll("[aria-label]")).filter((node) => matches(node.getAttribute("aria-label"))));
    const unique = Array.from(new Set(found));
    if (unique.length > 1) throw new Error("ambiguous");
    return unique[0] || null;
  }`;
}

function findByVisibleTextSource(): string {
  return `function (value, exact) {
    const expected = String(value || "").toLowerCase();
    const matches = (text) => {
      const actual = String(text || "").trim().toLowerCase();
      return exact ? actual === expected : actual.includes(expected);
    };
    const candidates = Array.from(document.querySelectorAll("button,a,input,textarea,select,[role],[contenteditable='true']"));
    const found = candidates.filter((node) => {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      if (rect.width <= 0 || rect.height <= 0 || style.visibility === "hidden" || style.display === "none") return false;
      return matches(node.innerText || node.textContent || node.getAttribute("aria-label") || node.getAttribute("title") || node.value || "");
    });
    if (found.length > 1) throw new Error("ambiguous");
    return found[0] || null;
  }`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
