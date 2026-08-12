// Newton Browser strict TypeScript CDP driver. The owned-browser runtime injects
// its private transport; this module has no ambient browser-extension dependency.
//
// Observing and acting are bound to a Newton-owned Chromium target. The private
// CDP transport is injected by the direct session runtime. Observing and
// acting are the same subsystem — an observation is the read half of an action.
//
// Trusted input only: CDP Input dispatches real events that land on SPAs that
// check isTrusted in event-driven applications. The model never gets raw CDP or raw JS;
// every action is funneled through the typed contract. The cursor overlay is
// fire-and-forget and NEVER gates execution (§5.1).

import { TargetRegistry, TARGET_REGISTRY_ERROR_CODES } from "./target-registry.js";
import { compileOriginGrant, decidePausedRequest, decidePausedTarget } from "./origin-containment.js";
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
  HeldTarget,
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
  PageEffectsPort,
  ScreenshotOptions,
  TargetRoute,
  TargetResolution,
  TextObservation,
  Viewport,
  WaitResult,
} from "./types.js";

const CDP_VERSION = "1.3";
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
// WS9.1 readable-text observation defaults. The DOM expression prefers main/article
// content and falls back to body innerText; it reads nothing outside the live document.
const TEXT_OBSERVE_CHAR_CAP = 20_000;
const TEXT_OBSERVE_EXPRESSION =
  "(function(){var m=document.querySelector('main,article,[role=\"main\"]');var el=m||document.body;return (el&&el.innerText)||(document.body&&document.body.innerText)||'';})()";
const MAX_SCREENSHOT_WAIT_MS = 10000; // bound the pre-capture wait (D5)
const MAX_SHOT_PX = 20000;            // bound an explicit-clip capture (D5)
const CDP_TIMEOUT_MS = 20000;         // bound each CDP call so a hang can't wedge the pump
const SCROLL_DISPATCH_TIMEOUT_MS = 2000; // scroll verifies page state even if Chrome drops the wheel acknowledgement
const OWNED_ROOT_INPUT_TIMEOUT_MS = 2000; // Chromium can omit release ACK when a click synchronously creates a target.
const FULLPAGE_MAX_PX = 6000;         // cap full-page height so capture stays practical
const FULLPAGE_MAX_WIDTH = 1440;      // downscale wide full-page captures
const INLINE_IMAGE_MAX_CHARS = 23_000_000; // supports up to the 16 MiB decoded MCP bound
const MASK_REGION_PADDING_CSS = 3;
const INITIAL_NAVIGATION_COMMIT_CAP = 32;
const RELATED_LAUNCH_TICKET_CAP = 64;
const RELATED_PAGE_FILTER = [{ type: "page", exclude: false }, { exclude: true }];
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
  "origin_containment_unavailable",
  "containment_fence_failed",
  "debugger_conflict",
  "shutdown_detach_failed",
  "renderer_unresponsive",
]);

function unavailableDebuggerPort(): DebuggerPort {
  const unavailable = async (): Promise<never> => { throw new Error("direct_debugger_port_required"); };
  return {
    attach: unavailable,
    detach: unavailable,
    sendCommand: unavailable,
  };
}

function noOpPageEffectsPort(): PageEffectsPort {
  const noop = async (): Promise<void> => {};
  return {
    begin: noop, end: noop, scroll: noop, move: noop, click: noop, field: noop,
  };
}

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
type DriverObserveOptions = ObserveOptions & Pick<BrowserAction, "includeFrameRouting">;
type InitialNavigationCommit = Readonly<{ frameId: string; loaderId: string; url: string; origin: string }>;
type InitialNavigationState = {
  generation: number;
  expectedFrameId: string | null;
  expectedLoaderId: string | null;
  commits: InitialNavigationCommit[];
  commitOverflow: boolean;
  commitResolved: boolean;
  prevention: { frameId: string | null; reason: string } | null;
  resolve(value: InitialNavigationCommit): void;
  reject(error: unknown): void;
  promise: Promise<InitialNavigationCommit>;
  timer: ReturnType<typeof setTimeout>;
};
type RelatedLaunchPhase = "paused_setup" | "paused_unknown" | "waiting_document" | "closing" | "settled";
type RelatedLaunchTicket = {
  targetId: string;
  sessionId: string;
  browserSessionId: string;
  generation: number;
  commandToken: number | null;
  phase: RelatedLaunchPhase;
  documentContinued: boolean;
  prevention: string | null;
  closed: boolean;
  resolve(): void;
  reject(error: unknown): void;
  promise: Promise<void>;
  timer: ReturnType<typeof setTimeout> | null;
};

export function createNewtonBrowserDriver(options: BrowserDriverOptions = {}) {
  return new NewtonBrowserDriver(options);
}

class NewtonBrowserDriver {
  tabId: number | null;
  attached: boolean;
  refIndex: Map<string, TargetRoute>;
  devicePixelRatio: number;
  zoom: number;
  accent: string | null;
  ownerLabel: string;
  ownsTab: boolean;
  ownsBrowser: boolean;
  lastNodes: Map<string, ObservationNodeSnapshot>;
  lastObserveUrl: string | null;
  lastScrollY: number;
  ownedNodeCache: Map<string, boolean | CdpRecord>;
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
  allowedOrigins: string[];
  targetRegistry: TargetRegistry;
  mainTargetId: string | null;
  mainFrameId: string | null;
  mainLoaderId: string | null;
  actionabilityFailure: string | null;
  framedPointProof: FramedPointProof | null;
  containment: ReturnType<typeof compileOriginGrant> | null;
  containmentReady: boolean;
  heldTargets: Map<string, HeldTarget>;
  inputDispatcher: InputDispatcher;
  dialogTracker: DialogTracker;
  rendererLiveness: RendererLiveness;
  livenessEpoch: number;
  activeCommandId: string | null;
  browserControlSessionId: string | null;
  browserRootSessionId: string | null;
  protocolEventTail: Promise<void>;
  protocolGeneration: number;
  protocolEventFailure: unknown | null;
  commandContainmentPrevention: string | null;
  commandContainmentActive: boolean;
  activeCommandKind: DriverAction["kind"] | null;
  initialNavigation: InitialNavigationState | null;
  relatedLaunchTickets: Map<string, RelatedLaunchTicket>;
  proxyGuardedRelatedPages: Map<string, { sessionId: string; browserSessionId: string }>;
  pendingOwnedChildTargets: Map<string, { source: CdpRecord; params: CdpRecord; generation: number }>;
  processingOwnedChildTargets: boolean;
  relatedCommandFailures: Map<number, DriverError>;
  commandTokenCounter: number;
  activeCommandToken: number | null;
  closing: boolean;
  unresolvedRelatedClose: { targetId: string; browserSessionId: string } | null;
  unresolvedRelatedCloseOverflow: boolean;
  relationshipCleanupComplete: boolean;
  debuggerPort: DebuggerPort;
  pageEffectsPort: PageEffectsPort;
  debuggerEventUnsubscribe: (() => void) | null;
  attachingTabId: number | null;

  constructor(options: BrowserDriverOptions = {}) {
    this.tabId = null;
    this.attached = false;
    this.refIndex = new Map(); // ref -> immutable target route
    this.devicePixelRatio = 1;
    this.zoom = 1;
    this.accent = typeof options.accent === "string" ? options.accent : null;
    this.ownerLabel = typeof options.ownerLabel === "string" && options.ownerLabel.trim() ? options.ownerLabel.trim().slice(0, 40) : "Newton";
    this.ownsTab = Boolean(options.ownsTab);
    this.ownsBrowser = Boolean(options.ownsBrowser);
    // Diff-delta state (Proposal 29 / D6): baseline of the last full observation
    // and caches that cut per-action CDP round-trips.
    this.lastNodes = new Map(); // ref -> { role, name, value, bbox }
    this.lastObserveUrl = null;
    this.lastScrollY = 0;
    this.ownedNodeCache = new Map(); // backendNodeId -> isOwnedOverlayNode (per document)
    this.activeActionSignals = null;
    // A page-initiated JS dialog blocking the renderer (WS9.4), or null. Set on
    // Page.javascriptDialogOpening and cleared when handled/closed.
    this.pendingDialog = null;
    this.pendingDialogRoute = null;
    this.pendingDialogs = new Map();
    // Owned-tab viewport override requested via `resize` (WS9.6), or null. Re-applied
    // after a debugger re-attach so a cross-process navigation does not silently
    // revert the caller's chosen size.
    this.sessionViewport = null;
    // Read-only console (WS9.2) and network (WS9.3) ring buffers. Populated from CDP
    // events; bounded so a chatty page cannot grow them without bound. `dropped`
    // counts entries evicted since the last read. Network HEADERS are never buffered.
    this.consoleBuffer = [];
    this.consoleDropped = 0;
    this.networkBuffer = new Map(); // requestId -> entry (insertion-ordered)
    this.networkDropped = 0;
    this.networkInFlight = new Set();
    // Session origin grant, set by the controller. Gates network-body fetches.
    this.allowedOrigins = Array.isArray(options.allowedOrigins) ? options.allowedOrigins : [];
    this.targetRegistry = new TargetRegistry();
    this.mainTargetId = null;
    this.mainFrameId = null;
    this.mainLoaderId = null;
    this.actionabilityFailure = null;
    this.framedPointProof = null;
    this.containment = this.allowedOrigins.length
      ? compileOriginGrant(this.allowedOrigins[0], this.allowedOrigins.slice(1))
      : null;
    this.containmentReady = false;
    this.heldTargets = new Map();
    this.inputDispatcher = new InputDispatcher((method: string, params: CdpRecord, route: CdpRoute) => this.cdp(method, params, route));
    this.dialogTracker = new DialogTracker();
    this.rendererLiveness = new RendererLiveness();
    this.livenessEpoch = 1;
    this.rendererLiveness.register("root", this.livenessEpoch);
    this.activeCommandId = null;
    this.browserControlSessionId = null;
    this.browserRootSessionId = null;
    this.protocolEventTail = Promise.resolve();
    this.protocolGeneration = 0;
    this.protocolEventFailure = null;
    this.commandContainmentPrevention = null;
    this.commandContainmentActive = false;
    this.activeCommandKind = null;
    this.initialNavigation = null;
    this.relatedLaunchTickets = new Map();
    this.proxyGuardedRelatedPages = new Map();
    this.pendingOwnedChildTargets = new Map();
    this.processingOwnedChildTargets = false;
    this.relatedCommandFailures = new Map();
    this.commandTokenCounter = 0;
    this.activeCommandToken = null;
    this.closing = false;
    this.unresolvedRelatedClose = null;
    this.unresolvedRelatedCloseOverflow = false;
    this.relationshipCleanupComplete = false;
    this.debuggerPort = options.debuggerPort ?? unavailableDebuggerPort();
    this.pageEffectsPort = options.pageEffectsPort ?? noOpPageEffectsPort();
    this.debuggerEventUnsubscribe = null;
    this.attachingTabId = null;
  }

  isAttachedTo(tabId: number): boolean {
    return this.attached && this.tabId === tabId;
  }

  async attach(tabId: number): Promise<void> {
    if (this.attached && this.tabId === tabId) return;
    if (this.attached) await this.detach();
    this.containment = compileOriginGrant(this.allowedOrigins[0], this.allowedOrigins.slice(1));
    this.protocolGeneration += 1;
    this.attachingTabId = tabId;
    try {
      await attachStage("root_debugger_attach_failed", async () => {
        this.subscribeDebuggerEvents();
        await this.debuggerPort.attach({ tabId }, CDP_VERSION);
      });
    } catch (error) {
      this.attachingTabId = null;
      this.protocolGeneration += 1;
      this.unsubscribeDebuggerEvents();
      this.protocolEventTail = Promise.resolve();
      this.protocolEventFailure = null;
      throw error;
    }
    this.tabId = tabId;
    this.attachingTabId = null;
    this.attached = true;
    this.relationshipCleanupComplete = false;
    this.protocolEventFailure = null;
    try {
      await attachStage("root_protocol_setup_failed", async () => {
        await this.initializeTargetRegistry();
        for (const domain of CDP_DOMAINS) {
          await this.cdp(`${domain}.enable`, {});
        }
        await this.installContainment({});
    // Owned tabs stay inactive so they never steal the user's focus. Chrome
    // otherwise accepts pointer/key CDP commands for a background tab while
    // dropping their press/release events. Focus emulation makes only this
    // debugger target behave as active without activating the visible tab.
        await this.cdp("Emulation.setFocusEmulationEnabled", { enabled: true });
      });
    // Child frames / popups attach to the same session (§7.5).
      const browserTarget = await attachStage("browser_control_attach_failed", () => this.cdp("Target.attachToBrowserTarget", {}));
      const browserSessionId = typeof browserTarget.sessionId === "string" && browserTarget.sessionId
        ? browserTarget.sessionId
        : null;
      if (!browserSessionId || !this.mainTargetId) throw typedDriverError("origin_containment_unavailable");
      this.browserControlSessionId = browserSessionId;
      await attachStage("related_autoattach_failed", () => this.ownsBrowser
        ? this.cdp("Target.setAutoAttach", {
          autoAttach: true,
          flatten: true,
          waitForDebuggerOnStart: false,
          filter: OWNED_BROWSER_TARGET_FILTER,
        }, { sessionId: browserSessionId })
        : this.cdp("Target.autoAttachRelated", {
          targetId: this.mainTargetId,
          waitForDebuggerOnStart: true,
          filter: RELATED_PAGE_FILTER,
        }, { sessionId: browserSessionId }));
      await this.fenceBrowserProtocolEvents("browser_control_fence_failed");
      await attachStage("root_autoattach_failed", () => this.cdp("Target.setAutoAttach", {
        autoAttach: true,
        flatten: true,
        waitForDebuggerOnStart: !this.ownsBrowser,
        filter: CHILD_TARGET_FILTER,
      }));
      await attachStage("calibration_failed", () => this.calibrate());
    // Re-apply a caller-chosen viewport (WS9.6) that a re-attach would otherwise drop.
      if (this.sessionViewport) {
        await this.cdp("Emulation.setDeviceMetricsOverride", { width: this.sessionViewport.width, height: this.sessionViewport.height, deviceScaleFactor: 1, mobile: false }).catch(() => {});
      }
      await attachStage("overlay_readiness_failed", () => this.reassertOverlay());
      this.containmentReady = true;
      this.reconcileRenderer("root");
    } catch (error) {
      await this.detach();
      throw error;
    }
  }

  // (Re)inject the overlay and re-announce the driving indicator. Called on attach
  // and again on every main-frame navigation (Proposal 28 §3) — the injected
  // overlay world is destroyed on navigation, so without this the cursor/outline
  // disappears on the first nav and never returns. Fire-and-forget; never gates.
  async reassertOverlay(): Promise<void> {
    if (!this.attached || this.tabId == null) return;
    await this.pageEffectsPort.begin(this.tabId, {
      ...(this.accent === null ? {} : { accent: this.accent }),
      ownerLabel: this.ownerLabel,
    }).catch(() => {});
  }

  async detach(): Promise<void> {
    if (!this.attached || this.tabId == null) return;
    this.closing = true;
    this.containmentReady = false;
    this.rejectInitialNavigation(typedDriverError("debugger_conflict"));
    if (!this.relationshipCleanupComplete) {
      const browserControlSessionId = this.browserControlSessionId;
      try {
        await this.drainProtocolEventQueue();
        await this.closeOutstandingRelatedLaunches();
        if (browserControlSessionId && this.mainTargetId) {
          await this.cdp("Target.getTargetInfo", { targetId: this.mainTargetId }, { sessionId: browserControlSessionId });
          await this.drainProtocolEventQueue();
          await this.closeOutstandingRelatedLaunches();
          await this.cdp("Target.setAutoAttach", {
            autoAttach: false,
            flatten: true,
            waitForDebuggerOnStart: false,
          }, { sessionId: browserControlSessionId });
          await this.drainProtocolEventQueue();
          await this.closeOutstandingRelatedLaunches();
          await this.cdp("Target.detachFromTarget", { sessionId: browserControlSessionId });
        }
      } catch {
        throw this.containmentFenceFailure("related_cleanup_failed");
      }
      this.relationshipCleanupComplete = true;
      this.protocolGeneration += 1;
      this.browserControlSessionId = null;
      this.browserRootSessionId = null;
    }
    await this.pageEffectsPort.end(this.tabId).catch(() => {});
    await this.cdp("Emulation.setFocusEmulationEnabled", { enabled: false }).catch(() => {});
    try {
      await this.debuggerPort.detach({ tabId: this.tabId });
    } catch {
      throw typedDriverError("shutdown_detach_failed");
    }
    this.unsubscribeDebuggerEvents();
    this.commandContainmentPrevention = null;
    this.commandContainmentActive = false;
    this.activeCommandKind = null;
    this.activeCommandToken = null;
    this.attached = false;
    this.tabId = null;
    this.refIndex.clear();
    this.targetRegistry = new TargetRegistry();
    this.mainTargetId = null;
    this.mainFrameId = null;
    this.mainLoaderId = null;
    this.containment = null;
    this.containmentReady = false;
    this.heldTargets.clear();
    this.networkInFlight.clear();
    this.pendingDialogs.clear();
    this.pendingDialog = null;
    this.pendingDialogRoute = null;
    this.dialogTracker = new DialogTracker();
    this.protocolEventTail = Promise.resolve();
    this.protocolEventFailure = null;
    for (const ticket of this.relatedLaunchTickets.values()) if (ticket.timer !== null) clearTimeout(ticket.timer);
    this.relatedLaunchTickets.clear();
    this.proxyGuardedRelatedPages.clear();
    this.pendingOwnedChildTargets.clear();
    this.processingOwnedChildTargets = false;
    this.relatedCommandFailures.clear();
    this.closing = false;
    this.unresolvedRelatedClose = null;
    this.unresolvedRelatedCloseOverflow = false;
    this.relationshipCleanupComplete = false;
    this.rendererLiveness.remove("root", "driver_detached");
  }

  // Chrome detached the debugger underneath us (e.g. a cross-process navigation
  // closed the old target). Clear the stale in-memory flag so a follow-up
  // attach() actually re-establishes the CDP session instead of no-op'ing. We do
  // Do not call the injected detach transport here: Chromium already detached it.
  markDetached(reason = "debugger_detached"): void {
    this.unsubscribeDebuggerEvents();
    this.attachingTabId = null;
    this.failRenderer("root", "debugger_detached", reason);
    this.attached = false;
    this.protocolGeneration += 1;
    this.browserControlSessionId = null;
    this.browserRootSessionId = null;
    this.commandContainmentPrevention = null;
    this.commandContainmentActive = false;
    this.activeCommandKind = null;
    this.rejectInitialNavigation(typedDriverError("debugger_conflict"));
    this.protocolEventTail = Promise.resolve();
    this.protocolEventFailure = null;
    for (const ticket of this.relatedLaunchTickets.values()) if (ticket.timer !== null) clearTimeout(ticket.timer);
    this.relatedLaunchTickets.clear();
    this.proxyGuardedRelatedPages.clear();
    this.pendingOwnedChildTargets.clear();
    this.processingOwnedChildTargets = false;
    this.relatedCommandFailures.clear();
    this.activeCommandToken = null;
    this.closing = false;
    this.unresolvedRelatedClose = null;
    this.unresolvedRelatedCloseOverflow = false;
    this.relationshipCleanupComplete = false;
    this.refIndex.clear();
    this.targetRegistry = new TargetRegistry();
    this.mainTargetId = null;
    this.mainFrameId = null;
    this.mainLoaderId = null;
    this.containment = null;
    this.containmentReady = false;
    this.heldTargets.clear();
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
      await this.recordTargetEventNow(source, method, params, generation);
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
    if (typeof source?.tabId === "number" && source.tabId !== this.tabId && source.tabId !== this.attachingTabId) return false;
    const sessionId = typeof source?.sessionId === "string" && source.sessionId ? source.sessionId : null;
    if (!sessionId) return true;
    return sessionId === this.browserControlSessionId
      || sessionId === this.browserRootSessionId
      || Boolean(this.targetRegistry.targetForSession(sessionId));
  }

  recordDebuggerSideEffects(source: CdpRecord, method: string, params: CdpRecord): void {
    this.noteInitialNavigationEvent(source, method, params);
    // Dialog open/close is tracked persistently (not just inside an action window)
    // because a JS dialog blocks the renderer until it is handled (WS9.4).
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
    // Console ring buffer (WS9.2).
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
    // Network ring buffer (WS9.3) — metadata only, never headers.
    if (method === "Network.requestWillBeSent" && params?.requestId) {
      while (this.networkInFlight.size >= NETWORK_BUFFER_MAX) {
        const oldest = this.networkInFlight.values().next().value;
        if (typeof oldest === "string") this.networkInFlight.delete(oldest);
      }
      this.networkInFlight.add(String(params.requestId));
      this.pushNetwork(params.requestId, { requestId: params.requestId, method: String(params.request?.method ?? "GET"), url: String(params.request?.url ?? ""), resourceType: params.type, at: new Date().toISOString() });
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
    if (method === "Network.requestWillBeSent" && isNetworkWrite(params?.request)) {
      signals.networkWrite = true;
    }
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
      const debuggee = sessionId ? { tabId: this.tabId, sessionId } : { tabId: this.tabId };
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
    const targetId = typeof info?.targetId === "string" && info.targetId ? info.targetId : `tab-${this.tabId}`;
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
      await this.recordTargetEventNow(source, method, params, generation);
    });
    this.protocolEventTail = work.catch((error: unknown) => {
      if (generation === this.protocolGeneration) this.protocolEventFailure = error;
    });
    return work;
  }

  async recordTargetEventNow(source: CdpRecord, method: string, params: CdpRecord, generation: number): Promise<void> {
    const sourceSessionId = typeof source?.sessionId === "string" ? source.sessionId : null;
    if (typeof source?.tabId === "number" && source.tabId !== this.tabId) return;
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
      if (this.ownsBrowser && type === "worker" && params.waitingForDebugger !== true) {
        // The owned runtime's launch-time proxy is already the pre-network
        // boundary. Workers are not exposed as actionable/observable targets,
        // and retrofitting domains after an unpaused worker starts races its
        // short lifecycle without adding agent capability.
        return;
      }
      if (fromBrowserControl && params.waitingForDebugger !== true) {
        if (this.ownsBrowser) {
          await this.trackProxyGuardedRelatedPage(info, params.sessionId, sourceSessionId!, generation);
          return;
        }
        await this.closeUntrackedRelatedTarget(targetId, sourceSessionId!, "related_page_not_paused_close_failed");
        throw this.containmentFenceFailure("related_page_not_paused");
      }
      if (this.ownsBrowser
        && !fromBrowserControl
        && params.waitingForDebugger !== true
        && this.activeCommandToken !== null
        && !this.processingOwnedChildTargets) {
        if (!this.pendingOwnedChildTargets.has(params.sessionId)
          && this.pendingOwnedChildTargets.size >= RELATED_LAUNCH_TICKET_CAP) {
          throw this.containmentFenceFailure("owned_child_target_capacity_exceeded");
        }
        this.pendingOwnedChildTargets.set(params.sessionId, { source, params, generation });
        return;
      }
      if (sourceSessionId && !fromBrowserControl && !this.targetRegistry.targetForSession(sourceSessionId)) return;
      const sourceTarget = sourceSessionId ? this.targetRegistry.targetForSession(sourceSessionId) : null;
      const parentTargetId = type === "page"
        ? (typeof info.openerId === "string" ? info.openerId : null)
        : type === "iframe" || type === "worker" ? (sourceTarget?.targetId ?? this.mainTargetId) : null;
      const hostFrameId = type === "iframe"
        ? (typeof info.openerFrameId === "string" ? info.openerFrameId : targetId)
        : null;
      const commandScopedWorker = this.ownsBrowser
        && type === "worker"
        && this.activeCommandToken !== null
        && this.browserControlSessionId !== null;
      const relatedTicket = fromBrowserControl || commandScopedWorker
        ? await this.createRelatedLaunchTicket(
            targetId,
            params.sessionId,
            fromBrowserControl ? sourceSessionId! : this.browserControlSessionId!,
            generation,
            fromBrowserControl
              ? (typeof info.openerId === "string" ? info.openerId : null)
              : parentTargetId,
          )
        : null;
      let relatedSetupStage: "admission" | "registry" | "autoattach" | "domains" | "fetch" | "resume" = "admission";
      try {
        if (relatedTicket && this.closing) {
          await this.closeRelatedLaunchTicket(relatedTicket);
          this.settleRelatedLaunchTicket(relatedTicket, null);
          return;
        }
        const parent = parentTargetId
          ? this.targetRegistry.listObservationRoutes().find((candidate) => candidate.targetId === parentTargetId)
          : null;
        const targetDecision = !safeOrigin(info.url)
          ? { action: "hold" as const, reason: "target_origin_pending", granted: false }
          : decidePausedTarget({ url: info.url, initiatorUrl: parent?.origin }, this.containment!);
        if (targetDecision.action === "block" && relatedTicket) {
          await this.closeRelatedLaunchTicket(relatedTicket);
          this.settleRelatedLaunchTicket(relatedTicket, "ungranted_target");
          return;
        }
        if (targetDecision.action === "block" && type === "worker" && this.browserControlSessionId) {
          await this.closeUntrackedRelatedTarget(targetId, this.browserControlSessionId, "worker_close_not_acknowledged");
          return;
        }
        relatedSetupStage = "registry";
        this.targetRegistry.registerTarget({
          targetId,
          type,
          ...(parentTargetId ? { parentTargetId } : {}),
          ...(hostFrameId ? { hostFrameId } : {}),
          sessionId: params.sessionId,
          origin: safeOrigin(info.url),
        });
        relatedSetupStage = "autoattach";
        await this.cdp(
          "Target.setAutoAttach",
          { autoAttach: true, flatten: true, waitForDebuggerOnStart: true, filter: CHILD_TARGET_FILTER },
          { sessionId: params.sessionId },
        );
        const domains = type === "worker"
          ? ["Runtime", "Network", "Log"]
          : relatedTicket && type === "page" ? ["Runtime"] : CDP_DOMAINS;
        relatedSetupStage = "domains";
        for (const domain of domains) await this.cdp(`${domain}.enable`, {}, { sessionId: params.sessionId });
        const route = { sessionId: params.sessionId };
        relatedSetupStage = "fetch";
        await this.installContainment(route);
        if (relatedTicket && isInheritedBlankTarget(info.url)) {
          // Chromium commonly reports a newly opened page as about:blank while
          // the triggering Input.dispatchMouseEvent is still in flight. Closing
          // that paused target can deadlock the input acknowledgement. Resume it
          // only after recursive target controls and request-stage Fetch are
          // installed, then keep the originating command open until its first
          // Document is either granted+committed or denied+closed with ACK.
          relatedSetupStage = "resume";
          await this.cdp("Runtime.runIfWaitingForDebugger", {}, route);
          relatedTicket.phase = "waiting_document";
          this.armRelatedLaunchDeadline(relatedTicket);
          return;
        }
        if (targetDecision.action === "resume") {
          this.heldTargets.delete(targetId);
          if (params.waitingForDebugger === true) {
            relatedSetupStage = "resume";
            await this.cdp("Runtime.runIfWaitingForDebugger", {}, route);
          }
          if (relatedTicket) {
            if (type === "worker") this.settleRelatedLaunchTicket(relatedTicket, null);
            else {
              relatedTicket.phase = "waiting_document";
              this.armRelatedLaunchDeadline(relatedTicket);
            }
          }
        } else {
          this.heldTargets.set(targetId, { targetId, sessionId: params.sessionId, type, reason: targetDecision.reason });
          if (relatedTicket) {
            relatedTicket.phase = "paused_unknown";
            this.armRelatedLaunchDeadline(relatedTicket);
          }
        }
      } catch (error) {
        if (this.ownsBrowser && params.waitingForDebugger !== true && !relatedTicket && this.browserControlSessionId) {
          // An unpaused OOPIF/worker can disappear while its recursive domains
          // are being installed (common on production pages with short-lived ad
          // and analytics frames). The launch-time proxy remains the preventive
          // network boundary for the owned process. Retire this unactionable
          // route and detach its exact transient session instead of poisoning the
          // main page's containment fence. A later attachment is admitted as a
          // fresh route and must complete the normal setup before observation.
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
        if (!relatedTicket || relatedTicket.phase === "settled") throw error;
        if (relatedTicket.phase !== "closing") {
          try {
            await this.closeRelatedLaunchTicket(relatedTicket);
            relatedTicket.phase = "settled";
          } catch {
            throw this.failRelatedLaunchTicket(relatedTicket, "related_setup_close_failed");
          }
        }
        throw this.failRelatedLaunchTicket(relatedTicket, `related_target_setup_failed_${relatedSetupStage}`);
      }
      return;
    }
    if (method === "Target.targetInfoChanged" && params?.targetInfo?.targetId) {
      const proxyGuarded = sourceSessionId === this.browserControlSessionId
        ? this.proxyGuardedRelatedPages.get(params.targetInfo.targetId)
        : undefined;
      if (proxyGuarded) {
        const guardedOrigin = safeOrigin(params.targetInfo.url);
        if (guardedOrigin) {
          const guardedDecision = decidePausedTarget({ url: params.targetInfo.url }, this.containment!);
          if (guardedDecision.action === "block") {
            await this.closeUntrackedRelatedTarget(
              params.targetInfo.targetId,
              proxyGuarded.browserSessionId,
              "proxy_guarded_page_close_failed",
            );
            this.proxyGuardedRelatedPages.delete(params.targetInfo.targetId);
            this.recordAuthoritativePrevention("ungranted_target", generation);
          }
        }
        return;
      }
      const relatedPageTicket = sourceSessionId === this.browserControlSessionId
        ? this.relatedLaunchTickets.get(params.targetInfo.targetId)
        : undefined;
      if (relatedPageTicket?.phase === "waiting_document" && relatedPageTicket.documentContinued) {
        const committedOrigin = safeOrigin(params.targetInfo.url);
        if (committedOrigin && this.containment?.contains(params.targetInfo.url)) {
          this.settleRelatedLaunchTicket(relatedPageTicket, null);
          return;
        }
      }
      const held = this.heldTargets.get(params.targetInfo.targetId);
      if (!held) return;
      if (held.type === "page" && sourceSessionId !== this.browserControlSessionId) return;
      const ticket = this.relatedLaunchTickets.get(held.targetId);
      const targetDecision = decidePausedTarget({ url: params.targetInfo.url }, this.containment!);
      if (targetDecision.action === "resume") {
        this.heldTargets.delete(held.targetId);
        if (!this.ownsBrowser) {
          await this.cdp("Runtime.runIfWaitingForDebugger", {}, { sessionId: held.sessionId });
        }
        if (ticket) {
          ticket.phase = "waiting_document";
          this.armRelatedLaunchDeadline(ticket);
        }
      } else if (targetDecision.action === "block" && held.type === "page" && this.browserControlSessionId) {
        if (!ticket) throw this.containmentFenceFailure("related_ticket_missing");
        await this.closeRelatedLaunchTicket(ticket);
        this.heldTargets.delete(held.targetId);
        this.settleRelatedLaunchTicket(ticket, "ungranted_target");
      }
      return;
    }
    if (method === "Fetch.requestPaused" && typeof params?.requestId === "string") {
      if (sourceSessionId && !this.targetRegistry.targetForSession(sourceSessionId)) return;
      const decision = decidePausedRequest(params, this.containment!);
      const route = sourceSessionId ? { sessionId: sourceSessionId } : {};
      const relatedTicket = sourceSessionId ? this.relatedLaunchTicketForSession(sourceSessionId) : undefined;
      if (decision.action === "fail") {
        if (params.resourceType === "Document" && typeof params.frameId === "string" && params.frameId !== this.mainFrameId) {
          const sourceTargetId = sourceSessionId
            ? this.targetRegistry.targetForSession(sourceSessionId)?.targetId
            : this.mainTargetId;
          const blockedOrigin = safeOrigin(params.request?.url);
          if (sourceTargetId && blockedOrigin) {
            try {
              this.targetRegistry.recordBlockedFrameOrigin({
                frameId: params.frameId,
                sourceTargetId,
                sourceSessionId,
                origin: blockedOrigin,
              });
            } catch {
              // Provenance is optional metadata. Containment remains fail-closed
              // and the request is still failed when registry identity rejects it.
            }
          }
        }
        try {
          await this.cdp("Fetch.failRequest", { requestId: params.requestId, errorReason: "BlockedByClient" }, route);
        } catch (error) {
          // A production page can cancel a paused request before CDP acknowledges
          // fail/continue. The owned runtime's launch-time proxy remains the
          // authoritative origin boundary, so a vanished request cannot escape
          // the grant. Do not author a driver prevention without an ACK. Legacy
          // A missing independent proxy is never treated as preventive evidence.
          if (this.ownsBrowser) return;
          throw error;
        }
        this.noteInitialNavigationPrevention(sourceSessionId, params, decision.reason);
        if (relatedTicket && params.resourceType === "Document") {
          const launchPending = relatedTicket.phase !== "settled";
          await this.closeRelatedLaunchTicket(relatedTicket);
          if (launchPending) this.settleRelatedLaunchTicket(relatedTicket, decision.reason);
          else this.relatedLaunchTickets.delete(relatedTicket.targetId);
        } else if (!relatedTicket && this.activeCommandKind === "navigate"
          && params.resourceType === "Document"
          && typeof params.frameId === "string"
          && typeof this.mainFrameId === "string"
          && params.frameId === this.mainFrameId) {
          // Fetch interception proves prevention, but it does not prove that an
          // arbitrary page-owned request was caused by the temporally overlapping
          // input command. Attribute only the exact main-frame Document navigation
          // (or a related-target ticket above). Background requests remain denied
          // and visible in containment diagnostics without poisoning an unrelated
          // click, scroll, wait, or observation.
          this.recordAuthoritativePrevention(decision.reason, generation);
        }
      } else {
        try {
          await this.cdp("Fetch.continueRequest", { requestId: params.requestId }, route);
        } catch (error) {
          if (this.ownsBrowser) return;
          throw error;
        }
        if (relatedTicket && params.resourceType === "Document") relatedTicket.documentContinued = true;
      }
      return;
    }
    if (method === "Target.detachedFromTarget") {
      if (typeof params?.sessionId === "string" && params.sessionId === this.browserControlSessionId) {
        this.browserControlSessionId = null;
        this.browserRootSessionId = null;
        this.containmentReady = false;
        this.protocolEventFailure = typedDriverError("containment_fence_failed");
        return;
      }
      if (sourceSessionId === this.browserControlSessionId && params?.sessionId === this.browserRootSessionId) {
        this.browserRootSessionId = null;
        return;
      }
      const target = typeof params?.sessionId === "string"
        ? this.targetRegistry.targetForSession(params.sessionId)
        : undefined;
      const guardedTargetId = typeof params?.sessionId === "string"
        ? [...this.proxyGuardedRelatedPages.entries()].find(([, guarded]) => guarded.sessionId === params.sessionId)?.[0]
        : undefined;
      const targetId = typeof params?.targetId === "string" ? params.targetId : target?.targetId ?? guardedTargetId;
      if (targetId) {
        this.proxyGuardedRelatedPages.delete(targetId);
        const relatedTicket = this.relatedLaunchTickets.get(targetId);
        if (relatedTicket && (typeof params?.sessionId !== "string" || relatedTicket.sessionId === params.sessionId)) {
          relatedTicket.closed = true;
          if (relatedTicket.phase !== "settled") {
            this.failRelatedLaunchTicket(relatedTicket, "related_target_detached_before_commit");
          } else {
            this.relatedLaunchTickets.delete(targetId);
          }
        }
        const held = this.heldTargets.get(targetId);
        if (held && (typeof params?.sessionId !== "string" || held.sessionId === params.sessionId)) {
          this.heldTargets.delete(targetId);
        }
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
    if (sourceSessionId && !frame.parentId) {
      const ticket = [...this.relatedLaunchTickets.values()].find((candidate) => candidate.sessionId === sourceSessionId && candidate.phase === "waiting_document");
      const committedOrigin = safeOrigin(frame.url);
      if (ticket && ticket.documentContinued && committedOrigin && this.containment?.contains(frame.url)) {
        this.settleRelatedLaunchTicket(ticket, null);
      }
    }
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

  installContainment(route: CdpRoute): Promise<CdpRecord> {
    return this.cdp("Fetch.enable", {
      patterns: [{ urlPattern: "*", requestStage: "Request" }],
      handleAuthRequests: false,
    }, route);
  }

  async trackProxyGuardedRelatedPage(
    info: CdpRecord,
    sessionId: string,
    browserSessionId: string,
    generation: number,
  ): Promise<void> {
    const targetId = typeof info.targetId === "string" ? info.targetId : "";
    if (!targetId || !this.ownsBrowser) return;
    if (!this.proxyGuardedRelatedPages.has(targetId) && this.proxyGuardedRelatedPages.size >= RELATED_LAUNCH_TICKET_CAP) {
      await this.closeUntrackedRelatedTarget(targetId, browserSessionId, "proxy_guarded_page_capacity_close_failed");
      throw this.containmentFenceFailure("proxy_guarded_page_capacity_exceeded");
    }
    const origin = safeOrigin(info.url);
    if (origin) {
      const decision = decidePausedTarget({ url: info.url }, this.containment!);
      if (decision.action === "block") {
        await this.closeUntrackedRelatedTarget(targetId, browserSessionId, "proxy_guarded_page_close_failed");
        this.proxyGuardedRelatedPages.delete(targetId);
        this.recordAuthoritativePrevention("ungranted_target", generation);
        return;
      }
    }
    this.proxyGuardedRelatedPages.set(targetId, { sessionId, browserSessionId });
  }

  async flushPendingOwnedChildTargets(): Promise<void> {
    if (this.processingOwnedChildTargets || this.pendingOwnedChildTargets.size === 0) return;
    this.processingOwnedChildTargets = true;
    try {
      while (this.pendingOwnedChildTargets.size > 0) {
        const pending = [...this.pendingOwnedChildTargets.values()];
        this.pendingOwnedChildTargets.clear();
        for (const entry of pending) {
          if (entry.generation !== this.protocolGeneration) continue;
          await this.recordTargetEventNow(entry.source, "Target.attachedToTarget", entry.params, entry.generation);
        }
      }
    } finally {
      this.processingOwnedChildTargets = false;
    }
  }

  async createRelatedLaunchTicket(targetId: string, sessionId: string, browserSessionId: string, generation: number, openerId: string | null): Promise<RelatedLaunchTicket> {
    if (this.relatedLaunchTickets.size >= RELATED_LAUNCH_TICKET_CAP) {
      await this.closeUntrackedRelatedTarget(targetId, browserSessionId, "related_ticket_capacity_close_failed");
      throw this.containmentFenceFailure("related_ticket_capacity_exceeded");
    }
    const parentTicket = openerId ? this.relatedLaunchTickets.get(openerId) : undefined;
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    promise.catch(() => {});
    const ticket: RelatedLaunchTicket = {
      targetId,
      sessionId,
      browserSessionId,
      generation,
      commandToken: parentTicket?.commandToken ?? this.activeCommandToken ?? null,
      phase: "paused_setup",
      documentContinued: false,
      prevention: null,
      closed: false,
      resolve,
      reject,
      promise,
      timer: null,
    };
    this.relatedLaunchTickets.set(targetId, ticket);
    return ticket;
  }

  relatedLaunchTicketForSession(sessionId: string): RelatedLaunchTicket | undefined {
    const direct = [...this.relatedLaunchTickets.values()].find((ticket) => ticket.sessionId === sessionId);
    if (direct) return direct;
    const ancestor = this.targetRegistry.relatedPageAncestorForSession(sessionId);
    return ancestor ? this.relatedLaunchTickets.get(ancestor.targetId) : undefined;
  }

  async closeUntrackedRelatedTarget(targetId: string, browserSessionId: string, detail: string): Promise<void> {
    try {
      const closed = await this.cdp("Target.closeTarget", { targetId }, { sessionId: browserSessionId });
      if (closed.success === true) return;
    } catch {
      // Retain exact cleanup identity below.
    }
    if (this.unresolvedRelatedClose && (
      this.unresolvedRelatedClose.targetId !== targetId
      || this.unresolvedRelatedClose.browserSessionId !== browserSessionId
    )) {
      this.unresolvedRelatedCloseOverflow = true;
    } else {
      this.unresolvedRelatedClose = { targetId, browserSessionId };
    }
    throw this.containmentFenceFailure(detail);
  }

  async expireRelatedLaunchTicket(ticket: RelatedLaunchTicket): Promise<void> {
    if (ticket.phase === "settled" || this.relatedLaunchTickets.get(ticket.targetId) !== ticket) return;
    try {
      await this.closeRelatedLaunchTicket(ticket);
    } catch {
      // The unresolved ticket remains durable and blocks teardown.
    }
    this.failRelatedLaunchTicket(ticket, "related_ticket_deadline");
  }

  armRelatedLaunchDeadline(ticket: RelatedLaunchTicket): void {
    if (ticket.timer !== null || ticket.phase === "settled") return;
    ticket.timer = setTimeout(() => {
      void this.expireRelatedLaunchTicket(ticket);
    }, CDP_TIMEOUT_MS);
  }

  async closeRelatedLaunchTicket(ticket: RelatedLaunchTicket): Promise<void> {
    ticket.phase = "closing";
    const closed = await this.cdp("Target.closeTarget", { targetId: ticket.targetId }, { sessionId: ticket.browserSessionId });
    if (closed.success !== true) throw this.containmentFenceFailure("popup_close_not_acknowledged");
    ticket.closed = true;
    try {
      this.targetRegistry.detachTarget(ticket.targetId, ticket.sessionId);
    } catch {
      // The target may have detached concurrently after the affirmative close.
    }
  }

  settleRelatedLaunchTicket(ticket: RelatedLaunchTicket, prevention: string | null): void {
    if (ticket.phase === "settled") return;
    if (ticket.timer !== null) clearTimeout(ticket.timer);
    ticket.timer = null;
    ticket.phase = "settled";
    ticket.prevention = prevention;
    ticket.resolve();
    if (ticket.commandToken === null && ticket.closed) this.relatedLaunchTickets.delete(ticket.targetId);
  }

  failRelatedLaunchTicket(ticket: RelatedLaunchTicket, detail: string): DriverError {
    if (ticket.timer !== null) clearTimeout(ticket.timer);
    ticket.timer = null;
    const error = this.containmentFenceFailure(detail);
    if (ticket.commandToken !== null && !this.relatedCommandFailures.has(ticket.commandToken)) {
      this.relatedCommandFailures.set(ticket.commandToken, error);
    }
    ticket.reject(error);
    if (ticket.closed) this.relatedLaunchTickets.delete(ticket.targetId);
    return error;
  }

  async awaitRelatedLaunches(commandToken: number): Promise<string | null> {
    while (true) {
      this.consumeRelatedCommandFailure(commandToken);
      await this.fenceBrowserProtocolEvents();
      this.consumeRelatedCommandFailure(commandToken);
      const tickets = [...this.relatedLaunchTickets.values()].filter((ticket) => ticket.commandToken === commandToken);
      await Promise.all(tickets.map((ticket) => ticket.promise));
      this.consumeRelatedCommandFailure(commandToken);
      await this.fenceBrowserProtocolEvents();
      this.consumeRelatedCommandFailure(commandToken);
      const stable = [...this.relatedLaunchTickets.values()].filter((ticket) => ticket.commandToken === commandToken);
      if (stable.length !== tickets.length || stable.some((ticket, index) => ticket !== tickets[index])) continue;
      const prevention = stable.map((ticket) => ticket.prevention).find((reason): reason is string => typeof reason === "string") ?? null;
      for (const ticket of stable) if (ticket.closed) this.relatedLaunchTickets.delete(ticket.targetId);
      return prevention;
    }
  }

  async settleRelatedEffectsBeforePostAction(): Promise<string | null> {
    const commandToken = this.activeCommandToken;
    if (!this.containmentReady || commandToken === null) return null;
    await this.fenceBrowserProtocolEvents();
    const ticketPrevention = await this.awaitRelatedLaunches(commandToken);
    return ticketPrevention ?? this.commandContainmentPrevention;
  }

  consumeRelatedCommandFailure(commandToken: number): void {
    const error = this.relatedCommandFailures.get(commandToken);
    if (error) {
      this.relatedCommandFailures.delete(commandToken);
      throw error;
    }
  }

  async drainProtocolEventQueue(): Promise<void> {
    while (true) {
      const tail = this.protocolEventTail;
      await tail;
      if (tail === this.protocolEventTail) return;
    }
  }

  async closeOutstandingRelatedLaunches(): Promise<void> {
    if (this.unresolvedRelatedClose) {
      const pending = this.unresolvedRelatedClose;
      await this.closeUntrackedRelatedTarget(pending.targetId, pending.browserSessionId, "related_cleanup_close_failed");
      this.unresolvedRelatedClose = null;
    }
    if (this.unresolvedRelatedCloseOverflow) throw this.containmentFenceFailure("related_cleanup_identity_overflow");
    for (const ticket of [...this.relatedLaunchTickets.values()]) {
      if (!ticket.closed) {
        await this.closeRelatedLaunchTicket(ticket);
      }
      if (ticket.phase !== "settled") this.settleRelatedLaunchTicket(ticket, ticket.prevention);
      this.relatedLaunchTickets.delete(ticket.targetId);
    }
  }

  recordAuthoritativePrevention(reason: string, generation: number): void {
    if (generation !== this.protocolGeneration) return;
    if (this.activeActionSignals) this.activeActionSignals.containmentPrevention = reason;
    if (this.commandContainmentActive) this.commandContainmentPrevention = reason;
  }

  async fenceBrowserProtocolEvents(attachFailureCode: string | null = null): Promise<void> {
    const sessionId = this.browserControlSessionId;
    if (this.protocolEventFailure) {
      if (isPreservedAttachFailure(this.protocolEventFailure)) throw this.protocolEventFailure;
      throw this.containmentFenceFailure("popup_protocol_event_failed");
    }
    if (!sessionId || !this.mainTargetId) {
      if (this.commandContainmentActive || this.containmentReady) {
        throw this.containmentFenceFailure("browser_control_session_missing");
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
        this.containmentReady = false;
        throw typedDriverError(attachFailureCode);
      }
      throw this.containmentFenceFailure("popup_protocol_fence_failed");
    }
  }

  containmentFenceFailure(detail: string): DriverError {
    this.containmentReady = false;
    const error = typedDriverError("containment_fence_failed");
    error.detail = detail;
    return error;
  }

  async navigateInitialGranted(url: string): Promise<InitialNavigationCommit> {
    if (!this.ownsTab || !this.attached || !this.containmentReady || !this.containment) {
      throw typedDriverError("origin_containment_unavailable");
    }
    if (!this.containment.contains(url)) throw typedDriverError("ungranted_navigation");
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
      prevention: null,
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
        || !this.containmentReady
        || !browserSessionId
        || this.browserControlSessionId !== browserSessionId
      ) throw typedDriverError("debugger_conflict");
      if (state.commitOverflow) throw typedDriverError("initial_navigation_event_overflow");
      if (state.prevention && (!state.prevention.frameId || state.prevention.frameId === state.expectedFrameId)) {
        throw typedDriverError(state.prevention.reason);
      }
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

  noteInitialNavigationPrevention(sourceSessionId: string | null, params: CdpRecord, reason: string): void {
    const state = this.initialNavigation;
    if (!state || state.generation !== this.protocolGeneration || sourceSessionId) return;
    if (params?.resourceType !== "Document" || reason !== "ungranted_navigation") return;
    state.prevention = { frameId: typeof params.frameId === "string" ? params.frameId : null, reason };
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
    if (state.prevention && (!state.prevention.frameId || state.prevention.frameId === state.expectedFrameId)) {
      if (state.commitResolved) return;
      this.initialNavigation = null;
      clearTimeout(state.timer);
      state.reject(typedDriverError(state.prevention.reason));
      return;
    }
    const commit = state.commits.find((candidate) =>
      candidate.frameId === state.expectedFrameId && candidate.loaderId === state.expectedLoaderId);
    if (!commit) return;
    if (!this.containment?.contains(commit.url)) {
      this.initialNavigation = null;
      clearTimeout(state.timer);
      state.reject(typedDriverError("ungranted_navigation"));
      return;
    }
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
    if (!this.containmentReady || !this.containment) throw Object.assign(new Error("origin_containment_unavailable"), { code: "origin_containment_unavailable" });
    if (action?.kind === "navigate" && !this.containment.contains(action.url)) {
      throw Object.assign(new Error("ungranted_navigation"), { code: "ungranted_navigation" });
    }
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

  // CSS-pixel calibration (§5.2 note): CDP Input coordinates are layout-viewport
  // CSS pixels; the overlay uses position:fixed in the same space. Measure DPR /
  // zoom once so the cursor lands on the clicked element at non-100% zoom.
  async calibrate(): Promise<void> {
    const metrics = await this.cdp("Page.getLayoutMetrics", {}).catch(() => null);
    const scale = metrics?.visualViewport?.scale;
    this.zoom = typeof scale === "number" && scale > 0 ? scale : 1;
    const dpr = await this.evalNumber("window.devicePixelRatio");
    this.devicePixelRatio = dpr && dpr > 0 ? dpr : 1;
  }

  // ── Observation (the read half) ───────────────────────────────────────────
  // Compact AX observation with backendNodeId-keyed refs (§7.5). Excludes
  // any Newton-owned UI marker so the agent never targets product chrome.
  async observe(options?: DriverObserveOptions & { mode?: "full" }): Promise<FullObservation>;
  async observe(options: DriverObserveOptions & { mode: "text" }): Promise<TextObservation>;
  async observe(options: DriverObserveOptions & { mode: "diff" }): Promise<FullObservation | DeltaObservation>;
  async observe(options?: DriverObserveOptions): Promise<DriverObservation>;
  async observe({ maxNodes = NODE_CAP, query, roles, includeInteractive = false, includeFrameRouting = false, mode = "full", maxChars }: DriverObserveOptions = {}): Promise<DriverObservation> {
    if (mode === "text") return this.observeText(maxChars === undefined ? {} : { maxChars });
    const cap = Math.max(1, Math.min(Number(maxNodes) || NODE_CAP, 250));
    const url = await this.evalString("location.href");
    // A navigation invalidates the diff baseline and the per-document owned-node
    // cache (backendNodeIds are document-scoped). Reset both on URL change.
    if (url !== this.lastObserveUrl) {
      this.lastNodes.clear();
      this.ownedNodeCache.clear();
      this.lastObserveUrl = url;
    }
    // Only reuse cached bboxes when the page has not scrolled since the last
    // observe (bbox is viewport-relative — a scroll moves every node).
    const scrollY = (await this.evalNumber("window.scrollY")) || 0;
    const reuseBboxes = Math.abs(scrollY - (this.lastScrollY || 0)) < 1;
    const frameObservation = await this.accessibilityTreesForOrigin(safeOrigin(url));
    const trees = Array.isArray(frameObservation) ? frameObservation : frameObservation.trees;
    const excludedFrames = Array.isArray(frameObservation) ? [] : frameObservation.excludedFrames;
    const filterText = typeof query === "string" ? query.toLowerCase() : "";
    const requestedRoles = new Set(Array.isArray(roles) ? roles.map((value) => String(value).toLowerCase()).slice(0, 12) : []);
    const nodes = [];
    this.refIndex.clear();
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
      if (await this.isOwnedOverlayNodeCached(backendNodeId, route)) continue;
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
      nodes.push({
        ref, role, name, ...(value ? { value } : {}), ...states, ...publicNodeFacts(nodeFacts, route.origin), bbox, target: { ref },
        documentEpoch: resolvedRoute.documentEpoch,
        ...(resolvedRoute.frameId ? { frameId: resolvedRoute.frameId, frameOrigin: resolvedRoute.origin } : {}),
      });
    }
    if (includeInteractive && nodes.length < cap) {
      const discovered = await this.interactiveObservationNodes(cap - nodes.length, new Set(nodes.map((node) => node.ref)), { requestedRoles, filterText });
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
    const frameRouting = includeFrameRouting ? this.targetRegistry.frameRoutingSummary() : undefined;
    const full = { kind: "observation", mode: "cdp", origin, title, nodes, nodeCount: nodes.length, truncated, ...(excludedFrames.length ? { excludedFrames } : {}), ...(frameRouting ? { frameRouting } : {}), capturedAt };
    // D6: emit a compact diff when asked (and a baseline exists, and the read is
    // not query-filtered). If the page churned heavily, fall back to a full snapshot.
    const canDiff = mode === "diff" && !filterText && this.lastNodes.size > 0;
    const baseline = this.lastNodes;
    this.lastNodes = new Map(nodes.map((node) => [node.ref, observationNodeSnapshot(node)]));
    if (canDiff) {
      const delta = computeObservationDelta(baseline, nodes);
      const churn = delta.added.length + delta.removed.length + delta.updated.length;
      if (churn <= Math.max(8, Math.round(nodes.length * 0.6))) {
        return { kind: "observation_delta", mode: "cdp", origin, title, added: delta.added, removed: delta.removed, updated: delta.updated, nodeCount: nodes.length, ...(excludedFrames.length ? { excludedFrames } : {}), ...(frameRouting ? { frameRouting } : {}), capturedAt };
      }
    }
    return full;
  }

  // WS9.1: readable-text observation. Prefer main/article content, fall back to body
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
    const allowed = new Set([...this.allowedOrigins, origin].filter(Boolean));
    const trees = [];
    const excludedFrames = [];
    for (const route of this.targetRegistry.listObservationRoutes()) {
      if (route.frameId && (!route.origin || !allowed.has(route.origin))) {
        excludedFrames.push({ frameId: route.frameId, frameOrigin: route.origin || null, reason: "origin_not_granted" });
        continue;
      }
      const params = route.frameId ? { frameId: route.frameId } : {};
      const tree = await this.cdp("Accessibility.getFullAXTree", params, route).catch(() => ({ nodes: [] }));
      trees.push({ ...tree, route });
    }
    return { trees, excludedFrames: excludedFrames.slice(0, 64) };
  }

  reconcileFrameTree(frameTree: CdpRecord | undefined, origin: string): void {
    let initialized = false;
    if (!this.mainTargetId) {
      this.mainTargetId = `tab-${this.tabId ?? "unattached"}`;
      this.targetRegistry.registerTarget({ targetId: this.mainTargetId, type: "page", origin });
      this.targetRegistry.commitTopLevelDocument(this.mainTargetId);
      initialized = true;
    }
    const topFrame = frameTree?.frame;
    if (initialized) {
      if (typeof topFrame?.id === "string") this.mainFrameId = topFrame.id;
      this.mainLoaderId = safeLoaderId(topFrame?.loaderId);
    } else if (topFrame) {
      this.reconcileTopLevelDocument(topFrame, origin, false);
    }
    const known = new Set(this.targetRegistry.listObservationRoutes().map((route) => route.frameId).filter(Boolean));
    const blocked = new Set<string>();
    for (const frame of childFrameRecords(frameTree)) {
      if (frame.parentFrameId && blocked.has(frame.parentFrameId)) {
        blocked.add(frame.frameId);
        continue;
      }
      const identity = this.targetRegistry.frameIdentity(frame.frameId);
      if (identity) {
        if ((identity.state === "active" || identity.state === "pending") && identity.targetId === this.mainTargetId) {
          known.add(frame.frameId);
        } else {
          blocked.add(frame.frameId);
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

  // describeNode is one CDP round-trip per node; owned-ness never changes for a
  // backendNodeId within a document, so cache it (cleared on navigation). (J45)
  async isOwnedOverlayNodeCached(backendNodeId: number, route: TargetRoute = {}): Promise<boolean> {
    const key = `${route.sessionId ?? "root"}:${backendNodeId}`;
    const cached = this.ownedNodeCache.get(key);
    if (typeof cached === "boolean") return cached;
    const owned = await this.isOwnedOverlayNode(backendNodeId, route);
    this.ownedNodeCache.set(key, owned);
    return owned;
  }

  async describedNodeFactsCached(backendNodeId: number, route: TargetRoute = {}): Promise<CdpRecord> {
    const key = `${route.sessionId ?? "root"}:${backendNodeId}:facts`;
    const cached = this.ownedNodeCache.get(key);
    if (cached && typeof cached === "object") return cached;
    const described = await this.cdp("DOM.describeNode", { backendNodeId }, route).catch(() => null);
    const node = described?.node ?? {};
    const attributes: CdpRecord = {};
    for (let index = 0; index < (node.attributes ?? []).length; index += 2) {
      attributes[String(node.attributes[index]).toLowerCase()] = String(node.attributes[index + 1] ?? "");
    }
    const facts = { localName: String(node.localName || node.nodeName || "").toLowerCase(), attributes };
    this.ownedNodeCache.set(key, facts);
    return facts;
  }

  // Vision capture (Proposal 29 / D5): viewport (default), full scroll-down page,
  // an optional pre-capture wait, and mobile/desktop device renders. Masks
  // sensitive zones before capture; returns an inline base64 image only when the
  // caller asked (bounded + stripped from persistence by redaction).
  async screenshot({ sensitiveZones = [], fullPage = false, waitMs, device, clip, inline = false, format = "png", quality }: ScreenshotOptions = {}): Promise<DriverRecord> {
    const emulation = await this.applyDeviceEmulation(device);
    const restoreDevice = emulation.restore;
    const masksConfigured = Array.isArray(sensitiveZones) && sensitiveZones.length > 0;
    // Trusted post-capture masking operates on Chromium's bounded lossless PNG.
    // A masked JPEG request is safely upgraded to PNG rather than returning pixels
    // that would need a lossy decoder/encoder in the security boundary.
    const requestedFormat = format === "jpeg" ? "jpeg" : "png";
    const imageFormat = masksConfigured ? "png" : requestedFormat;
    let maskDisposition: "mask_applied" | "mask_not_configured" | "mask_not_applicable" = masksConfigured
      ? "mask_applied"
      : "mask_not_configured";
    let resumeRasterMask: (() => Promise<void>) | null = null;
    try {
      const wait = Math.max(0, Math.min(Number(waitMs) || 0, MAX_SCREENSHOT_WAIT_MS));
      if (wait > 0) { await this.waitForSettle().catch(() => {}); await delay(wait); }
      let targets: TargetResolution[] = [];
      if (masksConfigured) {
        targets = await this.resolveMaskTargets(sensitiveZones);
        // Freeze every actionable target before deriving scroll, clip, or geometry.
        // Otherwise an untrusted page could move a sensitive element between the
        // measurement and the trusted raster operation.
        resumeRasterMask = await this.pauseForRasterMask();
      }
      const { params, truncated } = await this.screenshotCapturePlan({
        imageFormat,
        quality,
        fullPage,
        clip,
        emulationClip: emulation.clip,
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
      if (resumeRasterMask) {
        const resume = resumeRasterMask;
        resumeRasterMask = null;
        await resume();
      }
      const url = await this.evalString("location.href");
      const title = await this.evalString("document.title");
      const scale = captureClip?.scale || 1;
      const width = rasterWidth ?? (captureClip ? Math.round(captureClip.width * scale) : undefined);
      const height = rasterHeight ?? (captureClip ? Math.round(captureClip.height * scale) : undefined);
      // Carry the image ONLY when the caller asked for it inline — otherwise a
      // multi-MB base64 would be POSTed across the network just to be stripped by
      // redaction. Drop an over-cap inline image here too (before the POST) so it
      // never wastes a slow round-trip; the caller sees truncated.
      const dataUrl = screenshotData ? `data:image/${imageFormat};base64,${screenshotData}` : null;
      const inlineTooBig = Boolean(inline && dataUrl && dataUrl.length > INLINE_IMAGE_MAX_CHARS);
      const includeInline = Boolean(inline && dataUrl && !inlineTooBig);
      return {
        kind: "screenshot",
        mode: "cdp",
        origin: safeOrigin(url),
        title,
        device: device === "mobile" || device === "desktop" ? device : "viewport",
        fullPage: Boolean(fullPage),
        truncated: truncated || inlineTooBig,
        maskDisposition,
        format: imageFormat,
        ...(requestedFormat !== imageFormat ? { requestedFormat } : {}),
        ...(width ? { width } : {}),
        ...(height ? { height } : {}),
        ...(includeInline ? { dataUrl, inline: true } : {}),
        capturedAt: new Date().toISOString(),
      };
    } finally {
      try {
        if (resumeRasterMask) await resumeRasterMask();
      } finally {
        await restoreDevice().catch(() => {});
      }
    }
  }

  async screenshotCapturePlan(input: {
    imageFormat: "png" | "jpeg";
    quality: number | undefined;
    fullPage: boolean;
    clip: Box | undefined;
    emulationClip: Box | null;
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
    } else if (!input.fullPage && input.emulationClip) {
      params.clip = { ...input.emulationClip, scale: 1 };
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

  // Apply a mobile/desktop device render (D5). It visibly reflows only the
  // session's isolated browser. Returns { restore, clip } — the clip is the device viewport so
  // the capture can target an explicit region (see screenshot()).
  async applyDeviceEmulation(device?: "mobile" | "desktop"): Promise<{ restore: () => Promise<void>; clip: Box | null }> {
    if (device !== "mobile" && device !== "desktop") return { restore: async () => {}, clip: null };
    if (!this.ownsTab) throw new Error("device_emulation_needs_owned_tab");
    // Mobile render via viewport width + mobile:true (responsive sites switch on
    // viewport, not UA). We deliberately do NOT spoof the user agent: a UA override
    // makes UA-sniffing sites (e.g. Wikipedia) redirect to their mobile domain
    // mid-capture, which leaves the granted origin and hangs the screenshot.
    // deviceScaleFactor stays 2 (not 3) to keep the image light for the serial pump.
    const preset = device === "mobile"
      ? { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }
      : { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false };
    await this.cdp("Emulation.setDeviceMetricsOverride", { width: preset.width, height: preset.height, deviceScaleFactor: preset.deviceScaleFactor, mobile: preset.mobile }).catch(() => {});
    await this.cdp("Emulation.setTouchEmulationEnabled", { enabled: preset.mobile }).catch(() => {});
    await this.waitForSettle(1_000);
    return {
      restore: async () => {
        await this.cdp("Emulation.clearDeviceMetricsOverride", {}).catch(() => {});
        await this.cdp("Emulation.setTouchEmulationEnabled", { enabled: false }).catch(() => {});
      },
      clip: { x: 0, y: 0, width: preset.width, height: preset.height },
    };
  }

  // ── Action execution (the write half) ──────────────────────────────────────
  async executeAction(action: DriverAction, context: DriverContext = {}): Promise<DriverRecord> {
    const kind = action.kind;
    this.assertRendererLive("root", kind);
    this.activeCommandId = typeof context?.commandId === "string" ? context.commandId : null;
    this.commandContainmentPrevention = null;
    this.commandContainmentActive = isContainmentAttributableAction(action);
    this.activeCommandKind = kind;
    const requiresProtocolFence = this.containmentReady;
    this.commandTokenCounter = this.commandTokenCounter >= Number.MAX_SAFE_INTEGER ? 1 : this.commandTokenCounter + 1;
    const commandToken = this.commandTokenCounter;
    this.activeCommandToken = commandToken;
    try {
      const result = await this.executeActionNow(action);
      await this.flushPendingOwnedChildTargets();
      let ticketPrevention: string | null = null;
      if (this.commandContainmentActive && requiresProtocolFence) {
        await this.fenceBrowserProtocolEvents();
        ticketPrevention = await this.awaitRelatedLaunches(commandToken);
      }
      const prevention = ticketPrevention ?? this.commandContainmentPrevention;
      if (!prevention) return result;
      const changed = isRecord(result.changed) ? result.changed : {};
      return { ...result, status: "blocked", verified: false, reason: prevention, changed: { ...changed, containmentPrevention: prevention } };
    } finally {
      this.relatedCommandFailures.delete(commandToken);
      this.commandContainmentPrevention = null;
      this.commandContainmentActive = false;
      this.activeCommandKind = null;
      this.activeCommandToken = null;
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
            ...(action.includeFrameRouting !== undefined ? { includeFrameRouting: action.includeFrameRouting } : {}),
            ...(action.mode !== undefined ? { mode: action.mode } : {}),
          }));
        case "screenshot":
          return { status: "verified", verified: true, changed: {}, screenshot: await this.screenshot({
            ...(action.sensitiveZones !== undefined ? { sensitiveZones: action.sensitiveZones } : {}),
            ...(action.fullPage !== undefined ? { fullPage: action.fullPage } : {}),
            ...(action.waitMs !== undefined ? { waitMs: action.waitMs } : {}),
            ...(action.device !== undefined ? { device: action.device } : {}),
            ...(action.clip !== undefined ? { clip: action.clip } : {}),
            ...(action.inline !== undefined ? { inline: action.inline } : {}),
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
        case "console": return { status: "verified", verified: true, changed: {}, observation: this.getConsole(action) };
        case "network": return { status: "verified", verified: true, changed: {}, observation: await this.getNetwork(action) };
        case "fill_form": return this.withObservationMeta("failed", {}, await this.observe({}), "unsupported_action");
        default: {
          const unhandled: never = kind;
          void unhandled;
          return this.withObservationMeta("failed", {}, await this.observe({}), "unsupported_action");
        }
      }
  }

  // ── Console / network read-only buffers (WS9.2 / WS9.3) ─────────────────────
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
    const dropped = this.consoleDropped;
    if (action.clear) { this.consoleBuffer = []; this.consoleDropped = 0; }
    return { kind: "console_log", origin: safeOrigin(this.lastObserveUrl || ""), entries, count: entries.length, dropped, capturedAt: new Date().toISOString() };
  }

  async getNetwork(action: DriverAction = { kind: "network" }): Promise<DriverRecord> {
    if (typeof action.requestId === "string" && action.requestId) return this.getNetworkBody(action.requestId);
    const urlPattern = typeof action.urlPattern === "string" ? action.urlPattern.toLowerCase() : null;
    const limit = typeof action.limit === "number" && Number.isInteger(action.limit) ? action.limit : 100;
    let entries = [...this.networkBuffer.values()].filter((entry) => !urlPattern || String(entry.url).toLowerCase().includes(urlPattern));
    entries = entries.slice(-limit);
    return { kind: "network_log", origin: safeOrigin(this.lastObserveUrl || ""), entries, count: entries.length, dropped: this.networkDropped, capturedAt: new Date().toISOString() };
  }

  // Fetch one response body — only when its URL origin is within the session grant.
  // Response HEADERS are never returned. Bodies are capped; over-cap is truncated.
  async getNetworkBody(requestId: string): Promise<DriverRecord> {
    const entry = this.networkBuffer.get(requestId);
    const base = { kind: "network_log", origin: safeOrigin(this.lastObserveUrl || ""), entries: [], count: 0, dropped: this.networkDropped, capturedAt: new Date().toISOString() };
    if (!entry) return { ...base, body: null, reason: "unknown_request_id" };
    if (this.allowedOrigins.length > 0 && !this.allowedOrigins.includes(safeOrigin(entry.url))) {
      return { ...base, body: null, bodyDisposition: "origin_not_granted", reason: "origin_not_granted" };
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

  // Set the isolated session viewport (WS9.6). Resizing affects only the
  // session's owned browser. The
  // override persists on the driver and is re-applied on re-attach.
  async resizeViewport(action: DriverAction): Promise<DriverRecord> {
    if (!this.ownsTab) return this.withObservationMeta("failed", {}, await this.observe({}), "resize_needs_owned_tab");
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

  // Accept or dismiss a page-initiated JavaScript dialog (WS9.4). The renderer is
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
    this.paintCursorClick(point.x, point.y); // fire-and-forget (§5.1)
    const before = await this.pageSignature();
    const beforeState = target.backendNodeId ? await this.elementState(target.backendNodeId, target) : {};
      const signalWindow = this.beginActionSignals();
      try {
        let dispatched: boolean;
        let committingInputStarted = false;
        let releaseAcknowledgementUncertain = false;
        try {
          const inputTarget = this.ownsBrowser && pointerRoute.mode === "root"
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
        await this.flushPendingOwnedChildTargets();
        if (!dispatched) {
          if (framedTarget) return this.targetMoved("stale_target", this.actionabilityFailure ?? undefined);
          const blocker = await this.blockingElementEvidence(point, target);
          if (!blocker) return this.targetMoved();
          const observation = await this.observe({});
          return this.withObservationMeta("stale_target", { blocker }, observation, "click_intercepted");
        }
      const relatedPrevention = await this.settleRelatedEffectsBeforePostAction();
      if (relatedPrevention) {
        const signals = signalWindow.finish();
        return {
          status: "blocked",
          verified: false,
          reason: relatedPrevention,
          changed: {
            ...reconciliationChanges(signals),
            containmentPrevention: relatedPrevention,
          },
        };
      }
      await this.settleShort();
      if (releaseAcknowledgementUncertain) this.reconcileRenderer(inputTargetKey(target));
      const waitResult = action.waitFor ? await this.waitForCondition(action.waitFor, action.timeoutMs) : null;
      const signals = signalWindow.finish();
      const after = await this.pageSignature();
      const afterState = target.backendNodeId ? await this.elementState(target.backendNodeId, target).catch(() => ({})) : {};
      const changed = { ...diffPage(before, after), ...diffElement(beforeState, afterState), ...reconciliationChanges(signals), ...(waitResult?.matched ? { waitedFor: true } : {}), ...(releaseAcknowledgementUncertain ? { inputReleaseAcknowledgement: "unacknowledged" } : {}) };
      const observation = await this.observeDelta();
      const reconciliation = reconcilePostActionSignals(signals);
      if (reconciliation) return this.withObservationMeta("blocked", changed, observation, reconciliation);
      const verified = waitResult ? waitResult.matched : Object.keys(changed).length > 0;
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
    const target = await this.resolveTarget(action);
    if (!target?.backendNodeId) return this.targetMoved("not_found");
    const backendNodeId = target.backendNodeId;
    const framedTarget = typeof target.frameId === "string" && target.frameId.length > 0;
    await this.cdp("DOM.focus", { backendNodeId }, target).catch(() => {});
    const point = await this.actionablePoint(backendNodeId, target);
    if (!point) return this.targetMoved("stale_target", this.actionabilityFailure ?? undefined);
    const pointerRoute = this.pointerInputRoute(target, point);
    if (!pointerRoute) return this.targetMoved("stale_target", this.actionabilityFailure ?? "frame_input_route_unavailable");
    const beforeState = await this.elementState(backendNodeId, target);
    this.paintCursorField(point);
    let dispatched: boolean;
    let committingInputStarted = false;
    try {
      dispatched = await this.dispatchInput(target, async (input) => {
        await input.pointerMove(pointerRoute.point);
        if (framedTarget && !(await this.verifyFramedPoint(backendNodeId, target, point))) return false;
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
    const allowed = new Set(this.allowedOrigins);
    const selector = "a[href],button,input,select,textarea,[role],[tabindex]";
    for (const route of this.targetRegistry.listObservationRoutes()) {
      if (output.length >= limit) break;
      if (route.origin && !allowed.has(route.origin)) continue;
      const document = await this.cdp("DOM.getDocument", { depth: 0, pierce: true }, route).catch(() => null);
      if (!document?.root?.nodeId) continue;
      const queried = await this.cdp("DOM.querySelectorAll", { nodeId: document.root.nodeId, selector }, route).catch(() => null);
      for (const nodeId of (queried?.nodeIds ?? []).slice(0, Math.min(500, Math.max(50, limit * 10)))) {
        if (output.length >= limit) break;
        const described = await this.cdp("DOM.describeNode", { nodeId }, route).catch(() => null);
        const backendNodeId = described?.node?.backendNodeId;
        if (!Number.isInteger(backendNodeId) || await this.isOwnedOverlayNodeCached(backendNodeId, route)) continue;
        const ref = this.targetRegistry.createRef(route.targetId, backendNodeId, route.frameId ? { frameId: route.frameId } : {});
        if (existingRefs.has(ref)) continue;
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
          target: { ref },
          documentEpoch: resolvedRoute.documentEpoch,
          ...(resolvedRoute.frameId ? { frameId: resolvedRoute.frameId, frameOrigin: resolvedRoute.origin } : {}),
          route: resolvedRoute,
        });
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
        target: { ref },
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
    const explicitRef = Boolean((action.target && "ref" in action.target && action.target.ref) || action.ref);
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
    await this.pageEffectsPort.scroll(this.tabId, dy).catch(() => {});
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
    const waitResult = await this.waitForCondition(action.waitFor ?? action, action.timeoutMs);
    const observation = await this.observeDelta();
    return this.withObservationMeta(waitResult.matched ? "verified" : "timed_out", waitResult.matched ? { waitedFor: true } : {}, observation, waitResult.reason);
  }

  async press(action: DriverAction): Promise<DriverRecord> {
    const target = await this.resolveTarget(action);
    if (target?.backendNodeId) await this.cdp("DOM.focus", { backendNodeId: target.backendNodeId }, target).catch(() => {});
    const keys = Array.isArray(action.keys) && action.keys.length > 0 ? action.keys : [String(action.value ?? "Enter")];
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
      const reconciliation = reconcilePostActionSignals(signals);
      if (reconciliation) return this.withObservationMeta("blocked", changed, observation, reconciliation);
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
    await this.pageEffectsPort.move(this.tabId, point).catch(() => {});
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
    if (nodeIds.length > 1) throw new Error("ambiguous");
    if (nodeIds.length === 0) return null;
    const described = await this.cdp("DOM.describeNode", { nodeId: nodeIds[0] }).catch(() => null);
    return described?.node?.backendNodeId ?? null;
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

  async isOwnedOverlayNode(backendNodeId: number, route: TargetRoute = {}): Promise<boolean> {
    const described = await this.cdp("DOM.describeNode", { backendNodeId }, route).catch(() => null);
    const attrs = described?.node?.attributes ?? [];
    for (let i = 0; i < attrs.length; i += 2) {
      if (attrs[i] === "data-newton-browser-ui") return true;
    }
    return false;
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

  async pauseForRasterMask(): Promise<() => Promise<void>> {
    const routes: CdpRoute[] = [{}];
    const sessionIds = new Set<string>();
    for (const route of this.targetRegistry.listObservationRoutes()) {
      if (!route.sessionId || sessionIds.has(route.sessionId)) continue;
      sessionIds.add(route.sessionId);
      routes.push({ sessionId: route.sessionId });
    }
    const prepared: CdpRoute[] = [];
    try {
      for (const route of routes) {
        prepared.push(route);
        await this.cdp("Animation.enable", {}, route);
        await this.cdp("Animation.setPlaybackRate", { playbackRate: 0 }, route);
        // Disabling script execution freezes page-authored DOM movement without putting
        // the renderer into Debugger.paused, a state in which Chromium can refuse or
        // hang Page.captureScreenshot. Animation playback is frozen separately above.
        await this.cdp("Emulation.setScriptExecutionDisabled", { value: true }, route);
      }
    } catch {
      await this.resumeRasterMaskRoutes(prepared).catch(() => {});
      throw new Error("mask_page_freeze_failed");
    }
    let resumed = false;
    return async () => {
      if (resumed) return;
      resumed = true;
      await this.resumeRasterMaskRoutes(prepared);
    };
  }

  async resumeRasterMaskRoutes(routes: readonly CdpRoute[]): Promise<void> {
    let failed = false;
    for (const route of [...routes].reverse()) {
      for (const [method, params] of [
        ["Emulation.setScriptExecutionDisabled", { value: false }],
        ["Animation.setPlaybackRate", { playbackRate: 1 }],
        ["Animation.disable", {}],
      ] as const) {
        try { await this.cdp(method, params, route); } catch { failed = true; }
      }
    }
    if (failed) throw new Error("mask_page_resume_failed");
  }

  async waitForSettle(timeoutMs = SETTLE_TIMEOUT_MS) {
    const boundedTimeout = Math.max(100, Math.min(Number(timeoutMs) || SETTLE_TIMEOUT_MS, SETTLE_TIMEOUT_MS));
    const deadline = Date.now() + boundedTimeout;
    let last = "";
    let stable = 0;
    while (Date.now() < deadline) {
      const fingerprint = await this.evalString(
        `(() => {
          const key = "__newtonBrowserDocumentSignal";
          let signal = globalThis[key];
          if (!signal || signal.document !== document) {
            signal = { document, revision: 0 };
            const bump = () => { signal.revision = Math.min(Number.MAX_SAFE_INTEGER, signal.revision + 1); };
            new MutationObserver(bump).observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
            document.addEventListener("input", bump, true);
            document.addEventListener("change", bump, true);
            globalThis[key] = signal;
          }
          return document.readyState + ":" + signal.revision + ":" + location.href;
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

  paintCursorClick(x: number, y: number): void {
    // fire-and-forget, never awaited, errors swallowed (§5.1).
    this.pageEffectsPort.move(this.tabId, { x, y }).catch(() => {});
    this.pageEffectsPort.click(this.tabId, { x, y }).catch(() => {});
  }

  paintCursorField(point: Point): void {
    this.pageEffectsPort.move(this.tabId, point).catch(() => {});
    this.pageEffectsPort.field(this.tabId, { x: point.x - 12, y: point.y - 12, width: 24, height: 24 }).catch(() => {});
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
      const visible = await this.selectorVisible(wait.selector);
      if (wait.state === "hidden" || wait.state === "detached") return !visible;
      if (visible) return true;
    }
    if (wait.ref || wait.role || wait.name) {
      const target = await this.resolveTarget({
        kind: "wait_for",
        target: wait.ref ? { ref: wait.ref } : { role: wait.role ?? "", ...(wait.name !== undefined ? { name: wait.name } : {}) },
      });
      if (target) return true;
    }
    if (wait.value) {
      const waitTarget = wait.selector ? { selector: wait.selector }
        : wait.ref ? { ref: wait.ref }
          : wait.role ? { role: wait.role, ...(wait.name !== undefined ? { name: wait.name } : {}) }
            : undefined;
      const target = await this.resolveTarget({ kind: "wait_for", ...(waitTarget ? { target: waitTarget } : {}) });
      if (target?.backendNodeId) {
        const state = await this.elementState(target.backendNodeId, target);
        if (String(state.value ?? "").includes(wait.value)) return true;
      }
    }
    return false;
  }

  async selectorVisible(selector: string): Promise<boolean> {
    const result = await this.cdp("Runtime.evaluate", {
      expression: `(() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        if (!element) return false;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
      })()`,
      returnByValue: true,
    });
    if (result?.exceptionDetails) {
      const detail = `${result.exceptionDetails.text ?? ""} ${result.exceptionDetails.exception?.description ?? ""}`;
      if (isInvalidSelectorError(detail)) throw typedDriverError("invalid_selector");
      throw typedDriverError("target_resolution_failed");
    }
    return Boolean(result?.result?.value);
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
    const verified = status === "verified";
    return {
      status,
      verified,
      changed: changed ?? {},
      ...(reason ? { reason } : {}),
      observation: {
        ...observation,
        actionStatus: status,
        verified,
        ...(reason ? { reason } : {}),
        ...(changed && Object.keys(changed).length > 0 ? { changed } : {}),
        // Surface a still-open dialog so the agent knows it must accept/dismiss
        // before the renderer will respond again (WS9.4).
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

function isInheritedBlankTarget(url: unknown): boolean {
  return url === "" || url === "about:blank";
}

function isRecord(value: unknown): value is CdpRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMutatingAction(kind: DriverAction["kind"]): boolean {
  return !["observe", "screenshot", "wait_for", "console", "network", "fill_form"].includes(kind);
}

function isContainmentAttributableAction(action: DriverAction): boolean {
  if (!isMutatingAction(action.kind)) return false;
  if (["scroll", "hover", "move", "resize"].includes(action.kind)) return false;
  if (action.kind === "press") {
    const targeted = typeof action.ref === "string"
      || action.target !== undefined
      || typeof action.role === "string"
      || typeof action.name === "string"
      || typeof action.label === "string"
      || typeof action.placeholder === "string"
      || typeof action.testId === "string"
      || typeof action.selector === "string";
    if (!targeted && Array.isArray(action.keys)
      && action.keys.every((key) => ["PAGEDOWN", "PAGEUP", "HOME", "END", "ARROWDOWN", "ARROWUP", "ARROWLEFT", "ARROWRIGHT"].includes(key.toUpperCase()))) return false;
  }
  return true;
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
  if (action.target && typeof action.target === "object") return action.target;
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

function isNetworkWrite(request: CdpRecord | undefined): boolean {
  const method = String(request?.method ?? "").toUpperCase();
  return Boolean(method && !["GET", "HEAD", "OPTIONS"].includes(method));
}

// Map a CDP console/log type to a bounded level enum (WS9.2).
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
  for (const key of ["navigation", "networkWrite", "dialog", "download", "newTarget"] as const) {
    if (signals?.[key]) changed[key] = true;
  }
  if (signals?.containmentPrevention) changed.containmentPrevention = signals.containmentPrevention;
  return changed;
}

function reconcilePostActionSignals(signals: ActiveActionSignals | null | undefined): string | null {
  if (signals?.containmentPrevention) return signals.containmentPrevention;
  if (signals?.networkWrite) return "post_action_network_write";
  if (signals?.download) return "post_action_download";
  if (signals?.newTarget) return "post_action_new_target";
  if (signals?.dialog) return "post_action_dialog";
  return null;
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
