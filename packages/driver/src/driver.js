// @ts-check
// Newton Browser in-extension CDP driver.
//
// Runs in the MV3 service worker. Attaches chrome.debugger (CDP) to the ACTIVE
// tab on demand for the duration of a session, then detaches. Observing and
// acting are the same subsystem — an observation is the read half of an action.
//
// Trusted input only: CDP Input dispatches real events that land on SPAs that
// check isTrusted in event-driven applications. The model never gets raw CDP or raw JS;
// every action is funneled through the typed contract. The cursor overlay is
// fire-and-forget and NEVER gates execution (§5.1).

import { TargetRegistry } from "./target-registry.js";
import { compileOriginGrant, decidePausedRequest, decidePausedTarget } from "./origin-containment.js";
import { DialogTracker, InputDispatcher } from "./input-dispatcher.js";
import { RendererLiveness } from "./renderer-liveness.js";

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
const FULLPAGE_MAX_PX = 6000;         // cap full-page height so capture stays practical
const FULLPAGE_MAX_WIDTH = 1440;      // downscale wide full-page captures
const INLINE_IMAGE_MAX_CHARS = 23_000_000; // supports up to the 16 MiB decoded relay bound

export function createNewtonBrowserDriver(options = {}) {
  return new NewtonBrowserDriver(options);
}

class NewtonBrowserDriver {
  constructor(options = {}) {
    this.tabId = null;
    this.attached = false;
    this.refIndex = new Map(); // ref -> immutable target route
    this.devicePixelRatio = 1;
    this.zoom = 1;
    this.accent = typeof options.accent === "string" ? options.accent : null;
    this.ownerLabel = typeof options.ownerLabel === "string" && options.ownerLabel.trim() ? options.ownerLabel.trim().slice(0, 40) : "Newton";
    this.ownsTab = Boolean(options.ownsTab);
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
    this.containment = this.allowedOrigins.length
      ? compileOriginGrant(this.allowedOrigins[0], this.allowedOrigins.slice(1))
      : null;
    this.containmentReady = false;
    this.heldTargets = new Map();
    this.inputDispatcher = new InputDispatcher((method, params, route) => this.cdp(method, params, route));
    this.dialogTracker = new DialogTracker();
    this.rendererLiveness = new RendererLiveness();
    this.livenessEpoch = 1;
    this.rendererLiveness.register("root", this.livenessEpoch);
    this.activeCommandId = null;
  }

  isAttachedTo(tabId) {
    return this.attached && this.tabId === tabId;
  }

  async attach(tabId) {
    if (this.attached && this.tabId === tabId) return;
    if (this.attached) await this.detach();
    this.containment = compileOriginGrant(this.allowedOrigins[0], this.allowedOrigins.slice(1));
    await chrome.debugger.attach({ tabId }, CDP_VERSION);
    this.tabId = tabId;
    this.attached = true;
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
    // Child frames / popups attach to the same session (§7.5).
    await this.cdp("Target.setAutoAttach", { autoAttach: true, flatten: true, waitForDebuggerOnStart: true });
    await this.calibrate();
    // Re-apply a caller-chosen viewport (WS9.6) that a re-attach would otherwise drop.
    if (this.sessionViewport) {
      await this.cdp("Emulation.setDeviceMetricsOverride", { width: this.sessionViewport.width, height: this.sessionViewport.height, deviceScaleFactor: 1, mobile: false }).catch(() => {});
    }
    await this.reassertOverlay();
    this.containmentReady = true;
    this.reconcileRenderer("root");
  }

  // (Re)inject the overlay and re-announce the driving indicator. Called on attach
  // and again on every main-frame navigation (Proposal 28 §3) — the injected
  // overlay world is destroyed on navigation, so without this the cursor/outline
  // disappears on the first nav and never returns. Fire-and-forget; never gates.
  async reassertOverlay() {
    if (!this.attached || this.tabId == null) return;
    await this.injectOverlay();
    await this.sendToPage({ type: "NB_DRIVE_BEGIN", accent: this.accent ?? undefined, ownerLabel: this.ownerLabel });
  }

  async detach() {
    if (!this.attached || this.tabId == null) return;
    await this.sendToPage({ type: "NB_DRIVE_END" }).catch(() => {});
    await this.cdp("Emulation.setFocusEmulationEnabled", { enabled: false }).catch(() => {});
    await chrome.debugger.detach({ tabId: this.tabId }).catch(() => {});
    this.attached = false;
    this.tabId = null;
    this.refIndex.clear();
    this.targetRegistry = new TargetRegistry();
    this.mainTargetId = null;
    this.containment = null;
    this.containmentReady = false;
    this.heldTargets.clear();
    this.networkInFlight.clear();
    this.pendingDialogs.clear();
    this.pendingDialog = null;
    this.pendingDialogRoute = null;
    this.dialogTracker = new DialogTracker();
    this.rendererLiveness.remove("root", "driver_detached");
  }

  // Chrome detached the debugger underneath us (e.g. a cross-process navigation
  // closed the old target). Clear the stale in-memory flag so a follow-up
  // attach() actually re-establishes the CDP session instead of no-op'ing. We do
  // NOT call chrome.debugger.detach here — Chrome already did.
  markDetached(reason = "debugger_detached") {
    this.failRenderer("root", "debugger_detached", reason);
    this.attached = false;
    this.refIndex.clear();
    this.targetRegistry = new TargetRegistry();
    this.mainTargetId = null;
    this.containment = null;
    this.containmentReady = false;
    this.heldTargets.clear();
    this.networkInFlight.clear();
    this.pendingDialogs.clear();
    this.pendingDialog = null;
    this.pendingDialogRoute = null;
    this.dialogTracker = new DialogTracker();
  }

  ensureRenderer(targetKey) {
    const existing = this.rendererLiveness.snapshot(targetKey);
    if (existing) return existing;
    return this.rendererLiveness.register(targetKey, this.livenessEpoch);
  }

  failRenderer(targetKey, state, detail) {
    const snapshot = this.ensureRenderer(targetKey);
    if (snapshot.state === state || snapshot.state === "terminal") return snapshot;
    try {
      return this.rendererLiveness.transition(targetKey, state, { epoch: snapshot.epoch, detail });
    } catch {
      return snapshot;
    }
  }

  reconcileRenderer(targetKey) {
    let snapshot = this.ensureRenderer(targetKey);
    if (snapshot.state === "healthy") return snapshot;
    try {
      if (snapshot.state !== "reconciling") {
        snapshot = this.rendererLiveness.transition(targetKey, "reconciling", { epoch: snapshot.epoch });
      }
      return this.rendererLiveness.transition(targetKey, "healthy", { epoch: snapshot.epoch });
    } catch {
      this.livenessEpoch += 1;
      return this.rendererLiveness.register(targetKey, this.livenessEpoch);
    }
  }

  assertRendererLive(targetKey, actionKind) {
    const snapshot = this.ensureRenderer(targetKey);
    if (snapshot.state === "healthy" || snapshot.state === "reconciling") return;
    if (snapshot.state === "dialog_blocked" && (actionKind === "dialog_accept" || actionKind === "dialog_dismiss")) return;
    const code = snapshot.state === "discarded" ? "discarded"
      : snapshot.state === "debugger_detached" ? "debugger_conflict"
        : snapshot.state === "target_gone" || snapshot.state === "terminal" ? "target_gone"
          : snapshot.state === "dialog_blocked" ? "dialog_blocked" : "renderer_unresponsive";
    throw typedDriverError(code);
  }

  markDiscarded() {
    return this.failRenderer("root", "discarded", "tab_discarded");
  }

  markTargetGone(targetKey = "root") {
    return this.failRenderer(targetKey, "target_gone", "target_removed");
  }

  async dispatchInput(route, operation) {
    const targetKey = inputTargetKey(route);
    this.ensureRenderer(targetKey);
    const result = await this.dialogTracker.race(targetKey, this.activeCommandId, () => this.inputDispatcher.run(route, operation));
    if (result.kind === "dialog") throw typedDriverError("dialog_blocked");
    return result.value;
  }

  recordDebuggerEvent(sourceOrMethod, methodOrParams = {}, eventParams = {}) {
    const source = typeof sourceOrMethod === "string" ? {} : sourceOrMethod ?? {};
    const method = typeof sourceOrMethod === "string" ? sourceOrMethod : methodOrParams;
    const params = typeof sourceOrMethod === "string" ? methodOrParams : eventParams;
    const targetEvent = this.recordTargetEvent(source, method, params);
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
        this.networkInFlight.delete(this.networkInFlight.values().next().value);
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
    if (!signals) return targetEvent;
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
    return targetEvent;
  }

  cdp(method, params = {}, routeOrTimeout = {}) {
    const timeoutMs = typeof routeOrTimeout === "number"
      ? routeOrTimeout
      : routeOrTimeout?.timeoutMs ?? CDP_TIMEOUT_MS;
    const sessionId = typeof routeOrTimeout === "object" ? routeOrTimeout?.sessionId : null;
    return new Promise((resolve, reject) => {
      // Bound every CDP call: chrome.debugger.sendCommand can hang indefinitely
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
      chrome.debugger.sendCommand(debuggee, method, params, (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve(result ?? {});
      });
    });
  }

  async initializeTargetRegistry() {
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

  async recordTargetEvent(source, method, params) {
    const sourceSessionId = typeof source?.sessionId === "string" ? source.sessionId : null;
    if (method === "Target.attachedToTarget" && params?.targetInfo && typeof params.sessionId === "string") {
      const info = params.targetInfo;
      if (!["page", "iframe", "worker"].includes(info.type)) return;
      const type = info.type;
      const targetId = String(info.targetId ?? "");
      if (!targetId) return;
      const sourceTarget = sourceSessionId ? this.targetRegistry.targetForSession(sourceSessionId) : null;
      const parentTargetId = type === "page"
        ? (typeof info.openerId === "string" ? info.openerId : null)
        : type === "iframe" ? (sourceTarget?.targetId ?? this.mainTargetId) : null;
      const hostFrameId = type === "iframe"
        ? (typeof info.openerFrameId === "string" ? info.openerFrameId : targetId)
        : null;
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
        { autoAttach: true, flatten: true, waitForDebuggerOnStart: true },
        { sessionId: params.sessionId },
      );
      for (const domain of CDP_DOMAINS) await this.cdp(`${domain}.enable`, {}, { sessionId: params.sessionId });
      const route = { sessionId: params.sessionId };
      await this.installContainment(route);
      const parent = parentTargetId ? this.targetRegistry.listObservationRoutes().find((candidate) => candidate.targetId === parentTargetId) : null;
      const targetDecision = decidePausedTarget({ url: info.url, initiatorUrl: parent?.origin }, this.containment);
      if (targetDecision.action === "resume") {
        await this.cdp("Runtime.runIfWaitingForDebugger", {}, route);
      } else {
        this.heldTargets.set(targetId, { targetId, sessionId: params.sessionId, type, reason: targetDecision.reason });
        if (targetDecision.action === "block" && this.ownsTab && type !== "iframe") {
          await this.cdp("Target.closeTarget", { targetId });
        }
      }
      return;
    }
    if (method === "Target.targetInfoChanged" && params?.targetInfo?.targetId) {
      const held = this.heldTargets.get(params.targetInfo.targetId);
      if (!held) return;
      const targetDecision = decidePausedTarget({ url: params.targetInfo.url }, this.containment);
      if (targetDecision.action === "resume") {
        this.heldTargets.delete(held.targetId);
        await this.cdp("Runtime.runIfWaitingForDebugger", {}, { sessionId: held.sessionId });
      } else if (targetDecision.action === "block" && this.ownsTab && held.type !== "iframe") {
        this.heldTargets.delete(held.targetId);
        await this.cdp("Target.closeTarget", { targetId: held.targetId });
      }
      return;
    }
    if (method === "Fetch.requestPaused" && typeof params?.requestId === "string") {
      const decision = decidePausedRequest(params, this.containment);
      const route = sourceSessionId ? { sessionId: sourceSessionId } : {};
      if (decision.action === "fail") {
        if (this.activeActionSignals) this.activeActionSignals.containmentPrevention = decision.reason;
        await this.cdp("Fetch.failRequest", { requestId: params.requestId, errorReason: "BlockedByClient" }, route);
      } else {
        await this.cdp("Fetch.continueRequest", { requestId: params.requestId }, route);
      }
      return;
    }
    if (method === "Target.detachedFromTarget") {
      const target = typeof params?.sessionId === "string"
        ? this.targetRegistry.targetForSession(params.sessionId)
        : undefined;
      const targetId = typeof params?.targetId === "string" ? params.targetId : target?.targetId;
      if (targetId) {
        this.heldTargets.delete(targetId);
        this.targetRegistry.detachTarget(targetId);
      }
      return;
    }
    if (method === "Page.frameDetached" && typeof params?.frameId === "string") {
      this.targetRegistry.detachFrame(params.frameId);
      return;
    }
    if (method !== "Page.frameNavigated" || !params?.frame || typeof params.frame.id !== "string") return;
    const frame = params.frame;
    if (!frame.parentId && !sourceSessionId) {
      if (!this.mainTargetId) return;
      this.targetRegistry.commitTopLevelDocument(this.mainTargetId, safeOrigin(frame.url));
      this.refIndex.clear();
      return;
    }
    const target = sourceSessionId
      ? this.targetRegistry.targetForSession(sourceSessionId)
      : this.mainTargetId ? { targetId: this.mainTargetId } : undefined;
    if (!target?.targetId) return;
    this.targetRegistry.registerFrame({
      frameId: frame.id,
      targetId: target.targetId,
      ...(typeof frame.parentId === "string" ? { parentFrameId: frame.parentId } : {}),
      origin: safeOrigin(frame.url),
    });
  }

  installContainment(route) {
    return this.cdp("Fetch.enable", {
      patterns: [{ urlPattern: "*", requestStage: "Request" }],
      handleAuthRequests: false,
    }, route);
  }

  preflightAction(action) {
    if (!this.containmentReady || !this.containment) throw Object.assign(new Error("origin_containment_unavailable"), { code: "origin_containment_unavailable" });
    if (action?.kind === "navigate" && !this.containment.contains(action.url)) {
      throw Object.assign(new Error("ungranted_navigation"), { code: "ungranted_navigation" });
    }
    const selector = selectorFromAction(action);
    if (selector) return this.validateSelector(selector);
  }

  async validateSelector(selector) {
    const root = await this.cdp("DOM.getDocument", { depth: 0 });
    const nodeId = root?.root?.nodeId;
    if (!nodeId) throw typedDriverError("target_resolution_failed");
    try {
      await this.cdp("DOM.querySelectorAll", { nodeId, selector });
    } catch (error) {
      if (isInvalidSelectorError(error)) throw typedDriverError("invalid_selector");
      throw error;
    }
  }

  // CSS-pixel calibration (§5.2 note): CDP Input coordinates are layout-viewport
  // CSS pixels; the overlay uses position:fixed in the same space. Measure DPR /
  // zoom once so the cursor lands on the clicked element at non-100% zoom.
  async calibrate() {
    const metrics = await this.cdp("Page.getLayoutMetrics", {}).catch(() => null);
    const scale = metrics?.visualViewport?.scale;
    this.zoom = typeof scale === "number" && scale > 0 ? scale : 1;
    const dpr = await this.evalNumber("window.devicePixelRatio");
    this.devicePixelRatio = dpr && dpr > 0 ? dpr : 1;
  }

  async injectOverlay() {
    await chrome.scripting.insertCSS({ target: { tabId: this.tabId }, files: ["src/overlay.css"] }).catch(() => {});
    await chrome.scripting.executeScript({ target: { tabId: this.tabId }, files: ["src/overlay.js"] }).catch(() => {});
  }

  sendToPage(message) {
    return chrome.tabs.sendMessage(this.tabId, message).catch(() => {});
  }

  // ── Observation (the read half) ───────────────────────────────────────────
  // Compact AX observation with backendNodeId-keyed refs (§7.5). Excludes
  // the bridge overlay UI so the agent never targets the bubble.
  async observe({ maxNodes = NODE_CAP, query, roles, includeInteractive = false, mode = "full", maxChars } = {}) {
    if (mode === "text") return this.observeText({ maxChars });
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
        this.refIndex.set(node.ref, node.route);
        const { route: _route, ...publicNode } = node;
        nodes.push(publicNode);
      }
    }
    for (const fileNode of await this.fileInputObservationNodes(cap - nodes.length)) {
      if (nodes.some((node) => node.ref === fileNode.ref)) continue;
      this.refIndex.set(fileNode.ref, fileNode.route);
      const { backendNodeId: _backendNodeId, route: _route, ...publicNode } = fileNode;
      nodes.push(publicNode);
      if (nodes.length >= cap) { truncated = true; break; }
    }
    this.lastScrollY = scrollY;
    const title = await this.evalString("document.title");
    const origin = safeOrigin(url);
    const capturedAt = new Date().toISOString();
    const full = { kind: "observation", mode: "cdp", origin, title, nodes, nodeCount: nodes.length, truncated, ...(excludedFrames.length ? { excludedFrames } : {}), capturedAt };
    // D6: emit a compact diff when asked (and a baseline exists, and the read is
    // not query-filtered). If the page churned heavily, fall back to a full snapshot.
    const canDiff = mode === "diff" && !filterText && this.lastNodes.size > 0;
    const baseline = this.lastNodes;
    this.lastNodes = new Map(nodes.map((node) => [node.ref, observationNodeSnapshot(node)]));
    if (canDiff) {
      const delta = computeObservationDelta(baseline, nodes);
      const churn = delta.added.length + delta.removed.length + delta.updated.length;
      if (churn <= Math.max(8, Math.round(nodes.length * 0.6))) {
        return { kind: "observation_delta", mode: "cdp", origin, title, added: delta.added, removed: delta.removed, updated: delta.updated, nodeCount: nodes.length, ...(excludedFrames.length ? { excludedFrames } : {}), capturedAt };
      }
    }
    return full;
  }

  // WS9.1: readable-text observation. Prefer main/article content, fall back to body
  // innerText. Raw text crosses the loopback relay and is secret-redacted host-side by
  // redactBrowserResult before it reaches the client, exactly like accessible names.
  async observeText({ maxChars = TEXT_OBSERVE_CHAR_CAP } = {}) {
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

  async accessibilityTreesForOrigin(origin) {
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

  reconcileFrameTree(frameTree, origin) {
    if (!this.mainTargetId) {
      this.mainTargetId = `tab-${this.tabId ?? "unattached"}`;
      this.targetRegistry.registerTarget({ targetId: this.mainTargetId, type: "page", origin });
      this.targetRegistry.commitTopLevelDocument(this.mainTargetId);
    }
    const known = new Set(this.targetRegistry.listObservationRoutes().map((route) => route.frameId).filter(Boolean));
    for (const frame of childFrameRecords(frameTree)) {
      if (known.has(frame.frameId)) continue;
      this.targetRegistry.registerFrame({
        frameId: frame.frameId,
        targetId: this.mainTargetId,
        ...(frame.parentFrameId && known.has(frame.parentFrameId) ? { parentFrameId: frame.parentFrameId } : {}),
        origin: frame.origin,
      });
      known.add(frame.frameId);
    }
  }

  // Post-action observation as a compact diff (D6). Used after in-place actions
  // (click/fill/scroll/…); navigations and the explicit observe stay full so the
  // diff baseline is re-established.
  observeDelta() {
    return this.observe({ mode: "diff" });
  }

  // describeNode is one CDP round-trip per node; owned-ness never changes for a
  // backendNodeId within a document, so cache it (cleared on navigation). (J45)
  async isOwnedOverlayNodeCached(backendNodeId, route = {}) {
    const key = `${route.sessionId ?? "root"}:${backendNodeId}`;
    if (this.ownedNodeCache.has(key)) return this.ownedNodeCache.get(key);
    const owned = await this.isOwnedOverlayNode(backendNodeId, route);
    this.ownedNodeCache.set(key, owned);
    return owned;
  }

  async describedNodeFactsCached(backendNodeId, route = {}) {
    const key = `${route.sessionId ?? "root"}:${backendNodeId}:facts`;
    if (this.ownedNodeCache.has(key)) return this.ownedNodeCache.get(key);
    const described = await this.cdp("DOM.describeNode", { backendNodeId }, route).catch(() => null);
    const node = described?.node ?? {};
    const attributes = {};
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
  async screenshot({ sensitiveZones = [], fullPage = false, waitMs, device, clip, inline = false, format = "png", quality } = {}) {
    const emulation = await this.applyDeviceEmulation(device);
    const restoreDevice = emulation.restore;
    const imageFormat = format === "jpeg" ? "jpeg" : "png";
    const masksConfigured = Array.isArray(sensitiveZones) && sensitiveZones.length > 0;
    const maskDisposition = masksConfigured ? "mask_applied" : "mask_not_configured";
    try {
      const wait = Math.max(0, Math.min(Number(waitMs) || 0, MAX_SCREENSHOT_WAIT_MS));
      if (wait > 0) { await this.waitForSettle().catch(() => {}); await delay(wait); }
      if (masksConfigured && !await this.maskZones(sensitiveZones)) throw new Error("mask_application_failed");
      const params = { format: imageFormat };
      if (imageFormat === "jpeg") params.quality = Math.max(1, Math.min(Number.isFinite(quality) ? Math.trunc(quality) : 70, 100));
      let truncated = false;
      if (clip && Number.isFinite(clip.width) && Number.isFinite(clip.height) && clip.width > 0 && clip.height > 0) {
        params.clip = { x: Math.max(0, clip.x || 0), y: Math.max(0, clip.y || 0), width: Math.min(clip.width, MAX_SHOT_PX), height: Math.min(clip.height, MAX_SHOT_PX), scale: 1 };
        params.captureBeyondViewport = true;
      } else if (!fullPage && emulation.clip) {
        // Device emulation: capture an explicit region. Without a clip, mobile
        // emulation (mobile:true) can hang captureScreenshot waiting on the visual
        // viewport; an explicit clip + captureBeyondViewport makes it deterministic.
        params.clip = { ...emulation.clip, scale: 1 };
        params.captureBeyondViewport = true;
      } else if (fullPage) {
        const metrics = await this.cdp("Page.getLayoutMetrics", {}).catch(() => null);
        const size = metrics?.cssContentSize || metrics?.contentSize;
        const width = Math.round(size?.width || 0);
        let height = Math.round(size?.height || 0);
        // Bound a long page so the capture/encode stays practical, and downscale
        // wide pages so the output image (and any inline transfer) is bounded.
        if (height > FULLPAGE_MAX_PX) { height = FULLPAGE_MAX_PX; truncated = true; }
        if (width > 0 && height > 0) {
          const scale = width > FULLPAGE_MAX_WIDTH ? FULLPAGE_MAX_WIDTH / width : 1;
          params.clip = { x: 0, y: 0, width, height, scale };
          params.captureBeyondViewport = true;
        } else {
          params.captureBeyondViewport = true;
        }
      } else {
        // Plain viewport capture via an explicit clip of the current visual
        // viewport. captureBeyondViewport:false with no clip can hang after a
        // prior device-emulation capture (emulation residue); an explicit clip is
        // reliable and keeps every capture mode on the same code path.
        const vw = (await this.evalNumber("window.innerWidth")) || 1280;
        const vh = (await this.evalNumber("window.innerHeight")) || 800;
        const sx = (await this.evalNumber("window.scrollX")) || 0;
        const sy = (await this.evalNumber("window.scrollY")) || 0;
        params.clip = { x: sx, y: sy, width: Math.min(vw, MAX_SHOT_PX), height: Math.min(vh, MAX_SHOT_PX), scale: 1 };
        params.captureBeyondViewport = true;
      }
      const shot = await this.cdp("Page.captureScreenshot", params).catch(() => null);
      await this.unmaskZones();
      const url = await this.evalString("location.href");
      const title = await this.evalString("document.title");
      const scale = params.clip?.scale || 1;
      const width = params.clip ? Math.round(params.clip.width * scale) : undefined;
      const height = params.clip ? Math.round(params.clip.height * scale) : undefined;
      // Carry the image ONLY when the caller asked for it inline — otherwise a
      // multi-MB base64 would be POSTed across the network just to be stripped by
      // redaction. Drop an over-cap inline image here too (before the POST) so it
      // never wastes a slow round-trip; the caller sees truncated.
      const dataUrl = shot?.data ? `data:image/${imageFormat};base64,${shot.data}` : null;
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
        ...(width ? { width } : {}),
        ...(height ? { height } : {}),
        ...(includeInline ? { dataUrl, inline: true } : {}),
        capturedAt: new Date().toISOString(),
      };
    } finally {
      await restoreDevice().catch(() => {});
      await this.unmaskZones().catch(() => {});
    }
  }

  // Apply a mobile/desktop device render (D5). Owned-tab only by default — it
  // visibly reflows the page, so we never silently distort the user's own
  // current tab. Returns { restore, clip } — the clip is the device viewport so
  // the capture can target an explicit region (see screenshot()).
  async applyDeviceEmulation(device) {
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
  async executeAction(action, context = {}) {
    const kind = action?.kind;
    this.assertRendererLive("root", kind);
    this.activeCommandId = typeof context?.commandId === "string" ? context.commandId : null;
    try {
      if (kind === "observe") return this.withObservationMeta("verified", {}, await this.observe({ maxNodes: action.maxNodes, query: action.query, roles: action.roles, includeInteractive: action.includeInteractive, mode: action.mode }));
      if (kind === "screenshot") return { status: "verified", verified: true, changed: {}, screenshot: await this.screenshot({ sensitiveZones: action.sensitiveZones, fullPage: action.fullPage, waitMs: action.waitMs, device: action.device, clip: action.clip, inline: action.inline, format: action.format, quality: action.quality }) };
      if (kind === "navigate") return this.navigate(action);
      if (kind === "back" || kind === "forward" || kind === "reload") return this.historyAction(kind);
      if (kind === "scroll") return this.scroll(action);
      if (kind === "wait_for") return this.waitFor(action);
      if (kind === "click") return this.click(action);
      if (kind === "press") return this.press(action);
      if (kind === "hover" || kind === "move") return this.hover(action);
      if (kind === "fill" || kind === "type") return this.fill(action);
      if (kind === "select") return this.select(action);
      if (kind === "clear") return this.clear(action);
      if (kind === "set_files") return this.setFiles(action);
      if (kind === "dialog_accept" || kind === "dialog_dismiss") return this.handleDialog(kind, action);
      if (kind === "resize") return this.resizeViewport(action);
      if (kind === "console") return { status: "verified", verified: true, changed: {}, observation: this.getConsole(action) };
      if (kind === "network") return { status: "verified", verified: true, changed: {}, observation: await this.getNetwork(action) };
      return this.withObservationMeta("failed", {}, await this.observe({}), "unsupported_action");
    } finally {
      this.activeCommandId = null;
    }
  }

  // ── Console / network read-only buffers (WS9.2 / WS9.3) ─────────────────────
  pushConsole(entry) {
    if (!entry.text) return;
    entry.text = String(entry.text).slice(0, 2000);
    this.consoleBuffer.push(entry);
    while (this.consoleBuffer.length > CONSOLE_BUFFER_MAX) { this.consoleBuffer.shift(); this.consoleDropped += 1; }
  }

  pushNetwork(requestId, entry) {
    if (!this.networkBuffer.has(requestId)) {
      while (this.networkBuffer.size >= NETWORK_BUFFER_MAX) {
        const oldest = this.networkBuffer.keys().next().value;
        this.networkBuffer.delete(oldest);
        this.networkDropped += 1;
      }
    }
    this.networkBuffer.set(requestId, { ...this.networkBuffer.get(requestId), ...entry });
  }

  updateNetwork(requestId, patch) {
    const existing = this.networkBuffer.get(requestId);
    if (existing) this.networkBuffer.set(requestId, { ...existing, ...patch });
  }

  getConsole(action = {}) {
    const level = typeof action.level === "string" ? action.level : null;
    const pattern = typeof action.pattern === "string" ? action.pattern.toLowerCase() : null;
    const limit = Number.isInteger(action.limit) ? action.limit : 100;
    let entries = this.consoleBuffer.filter((entry) =>
      (!level || entry.level === level) && (!pattern || String(entry.text).toLowerCase().includes(pattern)));
    entries = entries.slice(-limit);
    const dropped = this.consoleDropped;
    if (action.clear) { this.consoleBuffer = []; this.consoleDropped = 0; }
    return { kind: "console_log", origin: safeOrigin(this.lastObserveUrl || ""), entries, count: entries.length, dropped, capturedAt: new Date().toISOString() };
  }

  async getNetwork(action = {}) {
    if (typeof action.requestId === "string" && action.requestId) return this.getNetworkBody(action.requestId);
    const urlPattern = typeof action.urlPattern === "string" ? action.urlPattern.toLowerCase() : null;
    const limit = Number.isInteger(action.limit) ? action.limit : 100;
    let entries = [...this.networkBuffer.values()].filter((entry) => !urlPattern || String(entry.url).toLowerCase().includes(urlPattern));
    entries = entries.slice(-limit);
    return { kind: "network_log", origin: safeOrigin(this.lastObserveUrl || ""), entries, count: entries.length, dropped: this.networkDropped, capturedAt: new Date().toISOString() };
  }

  // Fetch one response body — only when its URL origin is within the session grant.
  // Response HEADERS are never returned. Bodies are capped; over-cap is truncated.
  async getNetworkBody(requestId) {
    const entry = this.networkBuffer.get(requestId);
    const base = { kind: "network_log", origin: safeOrigin(this.lastObserveUrl || ""), entries: [], count: 0, dropped: this.networkDropped, capturedAt: new Date().toISOString() };
    if (!entry) return { ...base, body: null, reason: "unknown_request_id" };
    if (this.allowedOrigins.length > 0 && !this.allowedOrigins.includes(safeOrigin(entry.url))) {
      return { ...base, body: null, bodyDisposition: "origin_not_granted", reason: "origin_not_granted" };
    }
    const response = await this.cdp("Network.getResponseBody", { requestId }).catch(() => null);
    if (!response) return { ...base, body: null, bodyDisposition: "body_unavailable", reason: "body_unavailable" };
    const raw = String(response.body ?? "");
    const mimeType = String(entry.mimeType || "").toLowerCase().split(";", 1)[0];
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

  // Set the owned tab's viewport (WS9.6). Owned-tab only — resizing distorts the
  // page layout, so we never silently reflow the user's own current tab. The
  // override persists on the driver and is re-applied on re-attach.
  async resizeViewport(action) {
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
  async handleDialog(kind, action) {
    if (!this.pendingDialog) {
      return this.withObservationMeta("failed", {}, await this.observe({}), "no_dialog_open");
    }
    const accept = kind === "dialog_accept";
    const dialog = this.pendingDialog;
    const pendingRoute = this.pendingDialogRoute;
    const params = { accept };
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

  async navigate(action) {
    await this.preflightAction(action);
    const startUrl = await this.evalString("location.href");
    await this.cdp("Page.navigate", { url: action.url });
    await this.waitForSettle();
    const observation = await this.observe({});
    return this.withObservationMeta("verified", { navigated: action.url ?? observation.origin, ...(observation.origin !== safeOrigin(startUrl) ? { newTarget: false } : {}) }, observation);
  }

  async historyAction(kind) {
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

  async click(action) {
    const target = await this.resolveTarget(action);
    if (!target) return this.targetMoved("not_found");
    if (target.backendNodeId) await this.cdp("DOM.focus", { backendNodeId: target.backendNodeId }, target).catch(() => {});
    const point = target.point ?? await this.actionablePoint(target.backendNodeId, target);
    if (!point) return this.targetMoved();
    this.paintCursorClick(point.x, point.y); // fire-and-forget (§5.1)
    const before = await this.pageSignature();
    const beforeState = target.backendNodeId ? await this.elementState(target.backendNodeId, target) : {};
      const signalWindow = this.beginActionSignals();
      try {
        const dispatched = await this.dispatchInput(target, async (input) => {
          await input.pointerMove(point);
          if (target.backendNodeId && !(await this.hitTestTarget(target.backendNodeId, point.x, point.y, target))) return false;
          await input.mouseDown("left");
          await input.mouseUp("left");
          return true;
        });
        if (!dispatched) {
          const blocker = await this.blockingElementEvidence(point, target);
          if (!blocker) return this.targetMoved();
          const observation = await this.observe({});
          return this.withObservationMeta("stale_target", { blocker }, observation, "click_intercepted");
        }
      await this.settleShort();
      const waitResult = action.waitFor ? await this.waitForCondition(action.waitFor, action.timeoutMs) : null;
      const signals = signalWindow.finish();
      const after = await this.pageSignature();
      const afterState = target.backendNodeId ? await this.elementState(target.backendNodeId, target).catch(() => ({})) : {};
      const changed = { ...diffPage(before, after), ...diffElement(beforeState, afterState), ...reconciliationChanges(signals), ...(waitResult?.matched ? { waitedFor: true } : {}) };
      const observation = await this.observeDelta();
      const reconciliation = reconcilePostActionSignals(signals);
      if (reconciliation) return this.withObservationMeta("blocked", changed, observation, reconciliation);
      const verified = waitResult ? waitResult.matched : Object.keys(changed).length > 0;
      return this.withObservationMeta(verified ? "verified" : "dispatched_unverified", changed, observation, waitResult && !waitResult.matched ? waitResult.reason : undefined);
    } finally {
      signalWindow.finish();
    }
  }

  async fill(action) {
    const target = await this.resolveTarget(action);
    if (!target?.backendNodeId) return this.targetMoved("not_found");
    const point = await this.actionablePoint(target.backendNodeId, target);
    if (!point) return this.targetMoved();
    const beforeState = await this.elementState(target.backendNodeId, target);
    this.paintCursorField(point);
    await this.cdp("DOM.focus", { backendNodeId: target.backendNodeId }, target).catch(() => {});
    await this.dispatchInput(target, async (input) => {
      await input.pointerMove(point);
      await input.mouseDown("left");
      await input.mouseUp("left");
      await input.chord(["Control", "a"]);
      await input.insertText(String(action.value ?? ""));
    });
    const waitResult = action.waitFor ? await this.waitForCondition(action.waitFor, action.timeoutMs) : null;
    const afterState = await this.elementState(target.backendNodeId, target).catch(() => ({}));
    const changed = { ...diffElement(beforeState, afterState), ...(waitResult?.matched ? { waitedFor: true } : {}) };
    const observation = await this.observeDelta();
    return this.withObservationMeta(waitResult ? (waitResult.matched ? "verified" : "timed_out") : "verified", changed, observation, waitResult && !waitResult.matched ? waitResult.reason : undefined);
  }

  async select(action) {
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
      await this.dispatchInput(target, (input) => input.insertText(String(action.value ?? "")));
    }
    const afterState = await this.elementState(target.backendNodeId, target).catch(() => ({}));
    const changed = diffElement(beforeState, afterState);
    const observation = await this.observeDelta();
    return this.withObservationMeta(applied || Object.keys(changed).length > 0 ? "verified" : "dispatched_unverified", changed, observation);
  }

  async clear(action) {
    const target = await this.resolveTarget(action);
    if (!target?.backendNodeId) return this.targetMoved("not_found");
    const beforeState = await this.elementState(target.backendNodeId, target);
    await this.cdp("DOM.focus", { backendNodeId: target.backendNodeId }, target).catch(() => {});
    await this.dispatchInput(target, async (input) => {
      await input.chord(["Control", "a"]);
      await input.keyPress("Delete");
    });
    const afterState = await this.elementState(target.backendNodeId, target).catch(() => ({}));
    const observation = await this.observeDelta();
    return this.withObservationMeta("verified", diffElement(beforeState, afterState), observation);
  }

  async interactiveObservationNodes(limit, existingRefs = new Set(), filters = {}) {
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
        if (filters.requestedRoles?.size > 0 && !filters.requestedRoles.has(role)) continue;
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

  async fileInputObservationNodes(limit) {
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

  async fileInputDisplayFacts(backendNodeId, route = {}) {
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

  async setFiles(action) {
    const target = await this.resolveTarget(action);
    if (!target?.backendNodeId) return this.targetMoved("not_found");
    const facts = await this.fileInputFacts(target.backendNodeId, target);
    if (!facts.isFileInput) throw new Error("target_not_file_input");
    const explicitRef = Boolean(action?.target?.ref || action?.ref);
    if (!facts.visible && !explicitRef) throw new Error("hidden_file_input_requires_ref");
    const files = Array.isArray(action.files) ? action.files : [];
    if (files.length > 1 && !facts.multiple) throw new Error("file_input_not_multiple");
    await this.cdp("DOM.setFileInputFiles", { backendNodeId: target.backendNodeId, files }, target);
    const accepted = await this.fileInputState(target.backendNodeId, target);
    const expectedNames = files.map((file) => String(file).split(/[\\/]/).at(-1) || "");
    if (accepted.length !== expectedNames.length || accepted.some((file, index) => file.filename !== expectedNames[index])) {
      throw new Error("file_input_acceptance_mismatch");
    }
    const observation = await this.observeDelta();
    return this.withObservationMeta("verified", { files: accepted, fileCount: accepted.length }, observation);
  }

  async fileInputFacts(backendNodeId, route = {}) {
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

  async fileInputState(backendNodeId, route = {}) {
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

  async scroll(action) {
    const dy = Number(action.value) || 600;
    const beforeY = await this.evalNumber("window.scrollY");
    const acknowledged = await this.dispatchInput(
      { timeoutMs: SCROLL_DISPATCH_TIMEOUT_MS },
      (input) => input.wheel({ x: 10, y: 10 }, { x: 0, y: dy }),
    ).then(() => true).catch(() => false);
    await this.sendToPage({ type: "NB_DRIVE_SCROLL", dy });
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

  async waitForScrollPositionChange(beforeY, timeoutMs = 1200) {
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
  async waitFor(action) {
    const waitResult = await this.waitForCondition(action.waitFor ?? action, action.timeoutMs);
    const observation = await this.observeDelta();
    return this.withObservationMeta(waitResult.matched ? "verified" : "timed_out", waitResult.matched ? { waitedFor: true } : {}, observation, waitResult.reason);
  }

  async press(action) {
    const target = await this.resolveTarget(action);
    if (target?.backendNodeId) await this.cdp("DOM.focus", { backendNodeId: target.backendNodeId }, target).catch(() => {});
    const keys = Array.isArray(action.keys) && action.keys.length > 0 ? action.keys : [String(action.value ?? "Enter")];
    const signalWindow = this.beginActionSignals();
    try {
      await this.dispatchInput(target ?? {}, (input) => input.chord(keys.slice(0, 8)));
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

  async hover(action) {
    const target = await this.resolveTarget(action);
    if (!target) return this.targetMoved("not_found");
    const point = target.point ?? await this.actionablePoint(target.backendNodeId, target);
    if (!point) return this.targetMoved();
    await this.dispatchInput(target, (input) => input.pointerMove(point));
    await this.sendToPage({ type: "NB_DRIVE_MOVE", x: point.x, y: point.y });
    await this.settleShort();
    const observation = await this.observeDelta();
    return this.withObservationMeta("verified", { hovered: true }, observation);
  }

  // Resolve the target element's structural facts so the SW can re-check the
  // floor with real evidence BEFORE dispatching a mutating action (§7, S3). The
  // accessible name lets host/structural commit rules gate a ref-targeted click.
  async resolveEvidence(action) {
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
  async axNameFor(backendNodeId, route = {}) {
    const tree = await this.cdp("Accessibility.getPartialAXTree", { backendNodeId, fetchRelatives: false }, route).catch(() => null);
    const nodes = Array.isArray(tree?.nodes) ? tree.nodes : [];
    const node = nodes.find((n) => n.backendDOMNodeId === backendNodeId && n.name?.value) ?? nodes.find((n) => n.name?.value);
    return node?.name?.value ? String(node.name.value).slice(0, 240) : "";
  }

  async elementFacts(backendNodeId, route = {}) {
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
  async resolveTarget(action) {
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
        if (match && this.refIndex.has(match.ref)) return this.refIndex.get(match.ref);
      }
      if (target.text) {
        const backendNodeId = await this.backendNodeIdFromElementExpression(findByVisibleTextSource(), [target.text, Boolean(target.exact)]);
        if (backendNodeId) return { backendNodeId };
      }
      return null;
    }
    // valid ref → role_name → text → selector. Never click a guess.
    if (action.ref && this.refIndex.has(action.ref)) {
      return this.targetRegistry.resolveRef(action.ref);
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
      if (match && this.refIndex.has(match.ref)) return this.refIndex.get(match.ref);
    }
    return null;
  }

  async backendNodeIdForSelector(selector) {
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

  async backendNodeIdFromElementExpression(functionDeclaration, args) {
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

  async actionablePoint(backendNodeId, route = {}) {
    // Bring off-screen / below-the-fold targets into view first — the single
    // biggest real-world reliability win. Without this, an element outside the
    // viewport never hit-tests and times out as stale_target (seen live on the
    // large dynamic catalog).
    await this.scrollIntoView(backendNodeId, route);
    const deadline = Date.now() + AUTO_WAIT_TIMEOUT_MS;
    const vh = (await this.evalNumber("window.innerHeight", route)) || 100000;
    const vw = (await this.evalNumber("window.innerWidth", route)) || 100000;
    let previous = null;
    let rescrolls = 0;
    while (Date.now() < deadline) {
      const box = await this.boxFor(backendNodeId, route);
      if (box && box.width > 0 && box.height > 0) {
        const cx = box.x + box.width / 2;
        const cy = box.y + box.height / 2;
        // If the bbox centre is outside the viewport, re-scroll (bounded) and re-measure.
        if ((cy < 0 || cy > vh || cx < 0 || cx > vw) && rescrolls < 3) {
          rescrolls += 1;
          await this.scrollIntoView(backendNodeId, route);
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
          for (const pt of await this.candidatePoints(backendNodeId, route)) {
            const x = Math.round(pt.x);
            const y = Math.round(pt.y);
            if (x < 0 || x > vw || y < 0 || y > vh) continue;
            if (await this.hitTestTarget(backendNodeId, x, y, route)) return { x, y };
          }
        }
        previous = box;
      }
      await delay(AUTO_WAIT_POLL_MS);
    }
    return null;
  }

  // Viewport-relative click candidates for a node, ordered most-specific first:
  // the centre of each rendered line fragment (getClientRects — one rect per
  // wrapped line for inline content), then the bounding-box centre as a fallback.
  // This is what makes off-screen / multi-line inline links reliably clickable.
  async candidatePoints(backendNodeId, route = {}) {
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

  async scrollIntoView(backendNodeId, route = {}) {
    const objectId = await this.objectIdFor(backendNodeId, route);
    if (!objectId) return;
    await this.cdp("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: `function () { try { this.scrollIntoView({ block: "center", inline: "center" }); } catch (e) {} }`,
    }, route).catch(() => {});
  }

  async boxFor(backendNodeId, route = {}) {
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

  async hitTestTarget(backendNodeId, x, y, route = {}) {
    const hit = await this.cdp("DOM.getNodeForLocation", {
      x: Math.round(x),
      y: Math.round(y),
      includeUserAgentShadowDOM: true,
      ignorePointerEventsNone: false,
    }, route).catch(() => null);
    if (!Number.isInteger(hit?.backendNodeId)) return this.runtimeHitTestTarget(backendNodeId, x, y, route);
    if (hit.backendNodeId === backendNodeId) return true;
    const objectId = await this.objectIdFor(backendNodeId, route);
    const hitObjectId = await this.objectIdFor(hit.backendNodeId, route);
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

  async runtimeHitTestTarget(backendNodeId, x, y, route = {}) {
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

  async blockingElementEvidence(point, route = {}) {
    const hit = await this.cdp("DOM.getNodeForLocation", {
      x: Math.round(point.x),
      y: Math.round(point.y),
      includeUserAgentShadowDOM: true,
      ignorePointerEventsNone: false,
    }, route).catch(() => null);
    const backendNodeId = hit?.backendNodeId;
    if (!Number.isInteger(backendNodeId)) return null;
    const [facts, name, described] = await Promise.all([
      this.elementFacts(backendNodeId, route).catch(() => ({})),
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

  async objectIdFor(backendNodeId, route = {}) {
    const resolved = await this.cdp("DOM.resolveNode", { backendNodeId }, route).catch(() => null);
    return typeof resolved?.object?.objectId === "string" ? resolved.object.objectId : null;
  }

  async isOwnedOverlayNode(backendNodeId, route = {}) {
    const described = await this.cdp("DOM.describeNode", { backendNodeId }, route).catch(() => null);
    const attrs = described?.node?.attributes ?? [];
    for (let i = 0; i < attrs.length; i += 2) {
      if (attrs[i] === "data-newton-browser-ui") return true;
    }
    return false;
  }

  async maskZones(zones) {
    if (!Array.isArray(zones) || zones.length === 0) return;
    const response = await this.sendToPage({ type: "NB_DRIVE_MASK", zones });
    return response?.ok === true;
  }

  async unmaskZones() {
    await this.sendToPage({ type: "NB_DRIVE_UNMASK" });
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

  paintCursorClick(x, y) {
    // fire-and-forget, never awaited, errors swallowed (§5.1).
    this.sendToPage({ type: "NB_DRIVE_MOVE", x, y });
    this.sendToPage({ type: "NB_DRIVE_CLICK", x, y });
  }

  paintCursorField(point) {
    this.sendToPage({ type: "NB_DRIVE_MOVE", x: point.x, y: point.y });
    this.sendToPage({ type: "NB_DRIVE_FIELD", rect: { x: point.x - 12, y: point.y - 12, width: 24, height: 24 } });
  }

  async evalString(expression, route = {}) {
    const result = await this.cdp("Runtime.evaluate", { expression, returnByValue: true }, route).catch(() => null);
    return typeof result?.result?.value === "string" ? result.result.value : "";
  }

  async evalNumber(expression, route = {}) {
    const result = await this.cdp("Runtime.evaluate", { expression, returnByValue: true }, route).catch(() => null);
    return typeof result?.result?.value === "number" ? result.result.value : 0;
  }

  async evalBool(expression, route = {}) {
    const result = await this.cdp("Runtime.evaluate", { expression, returnByValue: true }, route).catch(() => null);
    return Boolean(result?.result?.value);
  }

  async waitForCondition(waitFor, actionTimeoutMs) {
    const timeoutMs = Math.max(100, Math.min(Number(waitFor?.timeoutMs ?? actionTimeoutMs ?? AUTO_WAIT_TIMEOUT_MS) || AUTO_WAIT_TIMEOUT_MS, 120000));
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.waitConditionMet(waitFor)) return { matched: true };
      await delay(AUTO_WAIT_POLL_MS);
    }
    return { matched: false, reason: "timed_out" };
  }

  async waitConditionMet(waitFor) {
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
      const target = await this.resolveTarget({ target: wait.ref ? { ref: wait.ref } : { role: wait.role ?? "", name: wait.name } });
      if (target) return true;
    }
    if (wait.value) {
      const target = await this.resolveTarget({ target: wait.selector ? { selector: wait.selector } : wait.ref ? { ref: wait.ref } : wait.role ? { role: wait.role, name: wait.name } : undefined });
      if (target?.backendNodeId) {
        const state = await this.elementState(target.backendNodeId, target);
        if (String(state.value ?? "").includes(wait.value)) return true;
      }
    }
    return false;
  }

  async selectorVisible(selector) {
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

  async pageSignature() {
    return {
      url: await this.evalString("location.href"),
      title: await this.evalString("document.title"),
    };
  }

  async elementState(backendNodeId, route = {}) {
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

  withObservationMeta(status, changed, observation, reason) {
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

  async targetMoved(status = "stale_target") {
    const observation = await this.observe({});
    return this.withObservationMeta(status, {}, observation, status === "not_found" ? "target_not_found" : "target_moved");
  }

  refreshPendingDialog() {
    const latest = [...this.pendingDialogs.values()].at(-1) ?? null;
    this.pendingDialog = latest?.dialog ?? null;
    this.pendingDialogRoute = latest?.route ?? null;
  }

  beginActionSignals() {
    const previous = this.activeActionSignals;
    const signals = {};
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

function axObservationStates(axNode) {
  const properties = new Map((axNode?.properties ?? []).map((property) => [property?.name, property?.value?.value]));
  const output = {};
  for (const name of ["disabled", "selected", "expanded", "required"]) {
    if (typeof properties.get(name) === "boolean") output[name] = properties.get(name);
  }
  const checked = properties.get("checked");
  if (typeof checked === "boolean" || checked === "mixed") output.checked = checked;
  const level = Number(properties.get("level"));
  if (Number.isSafeInteger(level) && level > 0 && level <= 9) output.level = level;
  return output;
}

function publicNodeFacts(facts, routeOrigin) {
  const localName = String(facts?.localName ?? "").slice(0, 80);
  const attributes = facts?.attributes ?? {};
  const elementType = localName === "input" && attributes.type
    ? `input:${String(attributes.type).toLowerCase().slice(0, 40)}`
    : localName;
  let href;
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
function computeObservationDelta(baseline, nodes) {
  const added = [];
  const updated = [];
  const seen = new Set();
  for (const node of nodes) {
    seen.add(node.ref);
    const prev = baseline.get(node.ref);
    if (!prev) { added.push(node); continue; }
    const current = observationNodeSnapshot(node);
    if (JSON.stringify(current.state) !== JSON.stringify(prev.state)) {
      updated.push({ ref: node.ref, ...current.state });
    }
  }
  const removed = [];
  for (const ref of baseline.keys()) if (!seen.has(ref)) removed.push(ref);
  return { added, removed, updated };
}

function safeOrigin(url) {
  try {
    return new URL(String(url)).origin;
  } catch {
    return "";
  }
}

function isSupportedTextMime(mimeType) {
  return mimeType.startsWith("text/")
    || mimeType === "application/json"
    || mimeType.endsWith("+json")
    || mimeType === "application/xml"
    || mimeType.endsWith("+xml")
    || mimeType === "application/javascript"
    || mimeType === "application/x-www-form-urlencoded";
}

function bodyBytes(raw, base64Encoded) {
  if (!base64Encoded) return new TextEncoder().encode(raw);
  try {
    const decoded = atob(raw);
    return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  } catch {
    return new TextEncoder().encode(raw);
  }
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function normalizedTarget(action) {
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
  if (Number.isFinite(action.x) && Number.isFinite(action.y)) return { coordinates: { x: Math.round(action.x), y: Math.round(action.y) } };
  return null;
}

function observationNodeSnapshot(node) {
  const state = {
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
  return { ...state, state, bbox: node.bbox };
}

function selectorFromAction(action) {
  const target = normalizedTarget(action);
  if (typeof target?.selector === "string" && target.selector) return target.selector;
  const wait = normalizedWaitFor(action?.waitFor ?? (action?.kind === "wait_for" ? action : null));
  return typeof wait?.selector === "string" && wait.selector ? wait.selector : null;
}

function normalizedWaitFor(waitFor) {
  if (!waitFor || typeof waitFor !== "object") return null;
  const output = {};
  for (const key of ["url", "title", "text", "selector", "role", "name", "ref", "value"]) {
    if (typeof waitFor[key] === "string" && waitFor[key].trim()) output[key] = waitFor[key];
  }
  if (typeof waitFor.state === "string") output.state = waitFor.state;
  if (typeof waitFor.timeoutMs === "number") output.timeoutMs = waitFor.timeoutMs;
  return Object.keys(output).length > 0 ? output : null;
}

function childFrameRecords(frameTree) {
  const frames = [];
  const visit = (tree) => {
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

function centersForQuads(quads) {
  if (!Array.isArray(quads)) return [];
  return quads.flatMap((quad) => {
    if (!Array.isArray(quad) || quad.length < 8 || quad.some((value) => !Number.isFinite(value))) return [];
    return [{
      x: (quad[0] + quad[2] + quad[4] + quad[6]) / 4,
      y: (quad[1] + quad[3] + quad[5] + quad[7]) / 4,
    }];
  });
}

function boundsForQuads(quads) {
  if (!Array.isArray(quads)) return null;
  const points = quads.flatMap((quad) => Array.isArray(quad) ? quad : []);
  if (points.length < 8 || points.some((value) => !Number.isFinite(value))) return null;
  const xs = points.filter((_value, index) => index % 2 === 0);
  const ys = points.filter((_value, index) => index % 2 === 1);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

function textWaitExpression(text) {
  return `(() => {
    const body = document.body;
    if (!body) return false;
    const text = String(body.innerText || body.textContent || "");
    const needle = ${JSON.stringify(String(text))};
    const normalize = (value) => String(value).replace(/\\s+/g, " ").trim();
    return text.includes(needle) || normalize(text).includes(normalize(needle));
  })()`;
}

function nodeMatchesTarget(node, target) {
  if (!node || !target) return false;
  if (target.ref) return node.ref === target.ref;
  if (target.role && String(node.role).toLowerCase() !== String(target.role).toLowerCase()) return false;
  const name = String(node.name ?? "");
  if (target.name) return matchText(name, target.name, target.exact);
  if (target.label) return matchText(name, target.label, target.exact);
  if (target.text) return matchText(name, target.text, target.exact) || matchText(String(node.value ?? ""), target.text, target.exact);
  return Boolean(target.role);
}

function matchText(value, expected, exact) {
  const left = String(value ?? "").trim().toLowerCase();
  const right = String(expected ?? "").trim().toLowerCase();
  if (!right) return false;
  return exact ? left === right : left.includes(right);
}

function diffPage(before, after) {
  const changed = {};
  if (before.url !== after.url) changed.navigated = safeOrigin(after.url);
  if (before.title !== after.title) changed.title = after.title.slice(0, 160);
  return changed;
}

function diffElement(before, after) {
  const changed = {};
  for (const key of ["value", "checked", "ariaChecked", "ariaPressed", "text"]) {
    if (before[key] !== after[key]) changed[key] = typeof after[key] === "string" ? after[key].slice(0, 160) : after[key];
  }
  return changed;
}

function isNetworkWrite(request) {
  const method = String(request?.method ?? "").toUpperCase();
  return Boolean(method && !["GET", "HEAD", "OPTIONS"].includes(method));
}

// Map a CDP console/log type to a bounded level enum (WS9.2).
function consoleLevelFor(type) {
  const t = String(type ?? "log");
  if (t === "warning" || t === "warn") return "warn";
  if (t === "error" || t === "assert") return "error";
  if (t === "info") return "info";
  if (t === "debug" || t === "verbose") return "debug";
  return "log";
}

// Render Runtime.consoleAPICalled args into a single line without executing getters
// or pulling object internals. Only primitive previews and CDP descriptions are used.
function consoleArgsText(args) {
  if (!Array.isArray(args)) return "";
  return args.map((arg) => {
    if (arg == null) return "";
    if (arg.value !== undefined) return String(arg.value);
    if (arg.description !== undefined) return String(arg.description);
    if (arg.unserializableValue !== undefined) return String(arg.unserializableValue);
    return arg.type ? `[${arg.type}]` : "";
  }).join(" ").trim().slice(0, 2000);
}

function inputTargetKey(route = {}) {
  return typeof route?.sessionId === "string" && route.sessionId ? `session:${route.sessionId}` : "root";
}

function dialogRoute(dialog = {}) {
  return typeof dialog?.sessionId === "string" && dialog.sessionId ? { sessionId: dialog.sessionId } : {};
}

function typedDriverError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function isInvalidSelectorError(error) {
  const message = String(error?.message ?? error ?? "");
  return /invalid selector|not a valid selector|failed to execute ['\"]queryselector|syntaxerror/i.test(message);
}

function reconciliationChanges(signals) {
  const changed = {};
  for (const key of ["navigation", "networkWrite", "dialog", "download", "newTarget"]) {
    if (signals?.[key]) changed[key] = true;
  }
  if (signals?.containmentPrevention) changed.containmentPrevention = signals.containmentPrevention;
  return changed;
}

function reconcilePostActionSignals(signals) {
  if (signals?.containmentPrevention) return signals.containmentPrevention;
  if (signals?.networkWrite) return "post_action_network_write";
  if (signals?.download) return "post_action_download";
  if (signals?.newTarget) return "post_action_new_target";
  if (signals?.dialog) return "post_action_dialog";
  return null;
}

function findByTestIdSource() {
  return `function (testId) {
    const attrs = ["data-testid", "data-test-id", "data-test"];
    const matches = Array.from(document.querySelectorAll("[data-testid],[data-test-id],[data-test]"))
      .filter((node) => attrs.some((attr) => node.getAttribute(attr) === testId));
    if (matches.length > 1) throw new Error("ambiguous");
    return matches[0] || null;
  }`;
}

function findByAttributeTextSource() {
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

function findByLabelSource() {
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

function findByVisibleTextSource() {
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
