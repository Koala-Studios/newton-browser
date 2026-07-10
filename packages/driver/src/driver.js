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

const CDP_VERSION = "1.3";
const CDP_DOMAINS = ["DOM", "Accessibility", "Page", "Runtime", "Input", "Network"];
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
    this.refIndex = new Map(); // ref -> backendNodeId
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
  }

  isAttachedTo(tabId) {
    return this.attached && this.tabId === tabId;
  }

  async attach(tabId) {
    if (this.attached && this.tabId === tabId) return;
    if (this.attached) await this.detach();
    await chrome.debugger.attach({ tabId }, CDP_VERSION);
    this.tabId = tabId;
    this.attached = true;
    for (const domain of CDP_DOMAINS) {
      await this.cdp(`${domain}.enable`, {}).catch(() => {});
    }
    // Owned tabs stay inactive so they never steal the user's focus. Chrome
    // otherwise accepts pointer/key CDP commands for a background tab while
    // dropping their press/release events. Focus emulation makes only this
    // debugger target behave as active without activating the visible tab.
    await this.cdp("Emulation.setFocusEmulationEnabled", { enabled: true });
    // Child frames / popups attach to the same session (§7.5).
    await this.cdp("Target.setAutoAttach", { autoAttach: true, flatten: true, waitForDebuggerOnStart: false }).catch(() => {});
    await this.calibrate();
    await this.reassertOverlay();
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
  }

  // Chrome detached the debugger underneath us (e.g. a cross-process navigation
  // closed the old target). Clear the stale in-memory flag so a follow-up
  // attach() actually re-establishes the CDP session instead of no-op'ing. We do
  // NOT call chrome.debugger.detach here — Chrome already did.
  markDetached() {
    this.attached = false;
    this.refIndex.clear();
  }

  recordDebuggerEvent(method, params = {}) {
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

  cdp(method, params = {}, timeoutMs = CDP_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      // Bound every CDP call: chrome.debugger.sendCommand can hang indefinitely
      // (e.g. Page.captureScreenshot under device emulation on some pages). The
      // per-session command pump awaits each call, so one hung call would wedge
      // the whole session. A timeout turns a hang into a recoverable error.
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`cdp_timeout_${method}`));
      }, timeoutMs);
      chrome.debugger.sendCommand({ tabId: this.tabId }, method, params, (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve(result ?? {});
      });
    });
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
  async observe({ maxNodes = NODE_CAP, query, mode = "full", maxChars } = {}) {
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
    const trees = await this.accessibilityTreesForOrigin(safeOrigin(url));
    const filterText = typeof query === "string" ? query.toLowerCase() : "";
    const nodes = [];
    this.refIndex.clear();
    let truncated = false;
    for (const axNode of trees.flatMap((tree) => tree.nodes ?? [])) {
      if (nodes.length >= cap) { truncated = true; break; }
      const role = axNode.role?.value;
      if (!role || !ACTIONABLE_ROLES.has(role)) continue;
      if (axNode.ignored) continue;
      const backendNodeId = axNode.backendDOMNodeId;
      if (typeof backendNodeId !== "number") continue;
      if (await this.isOwnedOverlayNodeCached(backendNodeId)) continue;
      const name = String(axNode.name?.value ?? "").slice(0, 240);
      if (filterText && !name.toLowerCase().includes(filterText)) continue;
      const value = axNode.value?.value ? String(axNode.value.value).slice(0, 240) : undefined;
      // Stable, element-keyed ref (S21): the same element keeps the same ref
      // across observations. Reuse the prior bbox for an unchanged node when the
      // page has not scrolled — skipping the per-node measurement round-trips
      // (J45). Targeting still re-measures its own element before any click.
      const ref = `e${backendNodeId}`;
      const prev = this.lastNodes.get(ref);
      let bbox;
      if (reuseBboxes && prev && prev.bbox && prev.role === role && prev.name === name && prev.value === value) {
        bbox = prev.bbox;
      } else {
        const measured = await this.boxFor(backendNodeId);
        if (!measured) continue; // not laid out / not visible
        bbox = [Math.round(measured.x), Math.round(measured.y), Math.round(measured.width), Math.round(measured.height)];
      }
      this.refIndex.set(ref, backendNodeId);
      nodes.push({ ref, role, name, ...(value ? { value } : {}), bbox, target: { ref } });
    }
    for (const fileNode of await this.fileInputObservationNodes(cap - nodes.length)) {
      if (nodes.some((node) => node.ref === fileNode.ref)) continue;
      this.refIndex.set(fileNode.ref, fileNode.backendNodeId);
      const { backendNodeId: _backendNodeId, ...publicNode } = fileNode;
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
    this.lastNodes = new Map(nodes.map((node) => [node.ref, { role: node.role, name: node.name, value: node.value, bbox: node.bbox }]));
    if (canDiff) {
      const delta = computeObservationDelta(baseline, nodes);
      const churn = delta.added.length + delta.removed.length + delta.updated.length;
      if (churn <= Math.max(8, Math.round(nodes.length * 0.6))) {
        return { kind: "observation_delta", mode: "cdp", origin, title, added: delta.added, removed: delta.removed, updated: delta.updated, nodeCount: nodes.length, capturedAt };
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
    const main = await this.cdp("Accessibility.getFullAXTree", {}).catch(() => ({ nodes: [] }));
    if (!origin) return [main];
    const page = await this.cdp("Page.getFrameTree", {}).catch(() => null);
    const frameIds = sameOriginChildFrameIds(page?.frameTree, origin);
    const children = await Promise.all(frameIds.map((frameId) =>
      this.cdp("Accessibility.getFullAXTree", { frameId }).catch(() => ({ nodes: [] })),
    ));
    return [main, ...children];
  }

  // Post-action observation as a compact diff (D6). Used after in-place actions
  // (click/fill/scroll/…); navigations and the explicit observe stay full so the
  // diff baseline is re-established.
  observeDelta() {
    return this.observe({ mode: "diff" });
  }

  // describeNode is one CDP round-trip per node; owned-ness never changes for a
  // backendNodeId within a document, so cache it (cleared on navigation). (J45)
  async isOwnedOverlayNodeCached(backendNodeId) {
    if (this.ownedNodeCache.has(backendNodeId)) return this.ownedNodeCache.get(backendNodeId);
    const owned = await this.isOwnedOverlayNode(backendNodeId);
    this.ownedNodeCache.set(backendNodeId, owned);
    return owned;
  }

  // Vision capture (Proposal 29 / D5): viewport (default), full scroll-down page,
  // an optional pre-capture wait, and mobile/desktop device renders. Masks
  // sensitive zones before capture; returns an inline base64 image only when the
  // caller asked (bounded + stripped from persistence by redaction).
  async screenshot({ sensitiveZones = [], fullPage = false, waitMs, device, clip, inline = false } = {}) {
    const emulation = await this.applyDeviceEmulation(device);
    const restoreDevice = emulation.restore;
    try {
      const wait = Math.max(0, Math.min(Number(waitMs) || 0, MAX_SCREENSHOT_WAIT_MS));
      if (wait > 0) { await this.waitForSettle().catch(() => {}); await delay(wait); }
      await this.maskZones(sensitiveZones);
      const params = { format: "png" };
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
      const dataUrl = shot?.data ? `data:image/png;base64,${shot.data}` : null;
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
    await delay(200); // let the reflow settle before capture
    return {
      restore: async () => {
        await this.cdp("Emulation.clearDeviceMetricsOverride", {}).catch(() => {});
        await this.cdp("Emulation.setTouchEmulationEnabled", { enabled: false }).catch(() => {});
      },
      clip: { x: 0, y: 0, width: preset.width, height: preset.height },
    };
  }

  // ── Action execution (the write half) ──────────────────────────────────────
  async executeAction(action) {
    const kind = action?.kind;
    if (kind === "observe") return this.withObservationMeta("verified", {}, await this.observe({ maxNodes: action.maxNodes, query: action.query, mode: action.mode }));
    if (kind === "screenshot") return { status: "verified", verified: true, changed: {}, screenshot: await this.screenshot({ sensitiveZones: action.sensitiveZones, fullPage: action.fullPage, waitMs: action.waitMs, device: action.device, clip: action.clip, inline: action.inline }) };
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
    return this.withObservationMeta("failed", {}, await this.observe({}), "unsupported_action");
  }

  async navigate(action) {
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
    if (target.backendNodeId) await this.cdp("DOM.focus", { backendNodeId: target.backendNodeId }).catch(() => {});
    const point = target.point ?? await this.actionablePoint(target.backendNodeId);
    if (!point) return this.targetMoved();
    this.paintCursorClick(point.x, point.y); // fire-and-forget (§5.1)
    const before = await this.pageSignature();
    const beforeState = target.backendNodeId ? await this.elementState(target.backendNodeId) : {};
      const signalWindow = this.beginActionSignals();
      try {
        await this.moveMouse(point);
        if (target.backendNodeId && !(await this.hitTestTarget(target.backendNodeId, point.x, point.y))) {
          return this.targetMoved();
        }
        await this.pressMouse(point);
      await this.releaseMouse(point);
      await this.settleShort();
      const waitResult = action.waitFor ? await this.waitForCondition(action.waitFor, action.timeoutMs) : null;
      const signals = signalWindow.finish();
      const after = await this.pageSignature();
      const afterState = target.backendNodeId ? await this.elementState(target.backendNodeId).catch(() => ({})) : {};
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
    const point = await this.actionablePoint(target.backendNodeId);
    if (!point) return this.targetMoved();
    const beforeState = await this.elementState(target.backendNodeId);
    this.paintCursorField(point);
    await this.pressMouse(point);
    await this.releaseMouse(point);
    await this.cdp("DOM.focus", { backendNodeId: target.backendNodeId }).catch(() => {});
    await this.selectAll();
    if (action.kind === "type") {
      for (const ch of String(action.value ?? "")) {
        await this.cdp("Input.dispatchKeyEvent", { type: "keyDown", text: ch });
        await this.cdp("Input.dispatchKeyEvent", { type: "keyUp", text: ch });
      }
    } else {
      await this.cdp("Input.insertText", { text: String(action.value ?? "") });
    }
    const waitResult = action.waitFor ? await this.waitForCondition(action.waitFor, action.timeoutMs) : null;
    const afterState = await this.elementState(target.backendNodeId).catch(() => ({}));
    const changed = { ...diffElement(beforeState, afterState), ...(waitResult?.matched ? { waitedFor: true } : {}) };
    const observation = await this.observeDelta();
    return this.withObservationMeta(waitResult ? (waitResult.matched ? "verified" : "timed_out") : "verified", changed, observation, waitResult && !waitResult.matched ? waitResult.reason : undefined);
  }

  async select(action) {
    const target = await this.resolveTarget(action);
    if (!target?.backendNodeId) return this.targetMoved("not_found");
    const beforeState = await this.elementState(target.backendNodeId);
    // Native <select>: choose the option by value/label/text and fire input+change
    // so frameworks observe the change (S9). Plain insertText does not select an
    // <option> and is a no-op on real selects.
    let applied = false;
    const objectId = await this.objectIdFor(target.backendNodeId);
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
      }).catch(() => null);
      applied = Boolean(result?.result?.value);
    }
    if (!applied) {
      // Fallback for custom (non-native) selects: focus + trusted typing.
      await this.cdp("DOM.focus", { backendNodeId: target.backendNodeId }).catch(() => {});
      await this.cdp("Input.insertText", { text: String(action.value ?? "") }).catch(() => {});
    }
    const afterState = await this.elementState(target.backendNodeId).catch(() => ({}));
    const changed = diffElement(beforeState, afterState);
    const observation = await this.observeDelta();
    return this.withObservationMeta(applied || Object.keys(changed).length > 0 ? "verified" : "dispatched_unverified", changed, observation);
  }

  async clear(action) {
    const target = await this.resolveTarget(action);
    if (!target?.backendNodeId) return this.targetMoved("not_found");
    const beforeState = await this.elementState(target.backendNodeId);
    await this.cdp("DOM.focus", { backendNodeId: target.backendNodeId }).catch(() => {});
    await this.selectAll();
    await this.cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Delete", windowsVirtualKeyCode: 46 });
    await this.cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Delete", windowsVirtualKeyCode: 46 });
    const afterState = await this.elementState(target.backendNodeId).catch(() => ({}));
    const observation = await this.observeDelta();
    return this.withObservationMeta("verified", diffElement(beforeState, afterState), observation);
  }

  async fileInputObservationNodes(limit) {
    if (limit <= 0) return [];
    const document = await this.cdp("DOM.getDocument", { depth: 0, pierce: true }).catch(() => null);
    const nodeId = document?.root?.nodeId;
    if (!nodeId) return [];
    const queried = await this.cdp("DOM.querySelectorAll", { nodeId, selector: "input[type='file']" }).catch(() => null);
    const output = [];
    for (const candidateNodeId of (queried?.nodeIds ?? []).slice(0, limit)) {
      const described = await this.cdp("DOM.describeNode", { nodeId: candidateNodeId }).catch(() => null);
      const backendNodeId = described?.node?.backendNodeId;
      if (!Number.isInteger(backendNodeId)) continue;
      const facts = await this.fileInputDisplayFacts(backendNodeId);
      const ref = `e${backendNodeId}`;
      output.push({
        backendNodeId,
        ref,
        role: "file",
        name: facts.name || "File input",
        ...(facts.bbox ? { bbox: facts.bbox } : {}),
        target: { ref },
      });
    }
    return output;
  }

  async fileInputDisplayFacts(backendNodeId) {
    const objectId = await this.objectIdFor(backendNodeId);
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
    }).catch(() => null);
    return result?.result?.value ?? { name: "", bbox: null };
  }

  async setFiles(action) {
    const target = await this.resolveTarget(action);
    if (!target?.backendNodeId) return this.targetMoved("not_found");
    const facts = await this.fileInputFacts(target.backendNodeId);
    if (!facts.isFileInput) throw new Error("target_not_file_input");
    const explicitRef = Boolean(action?.target?.ref || action?.ref);
    if (!facts.visible && !explicitRef) throw new Error("hidden_file_input_requires_ref");
    const files = Array.isArray(action.files) ? action.files : [];
    if (files.length > 1 && !facts.multiple) throw new Error("file_input_not_multiple");
    await this.cdp("DOM.setFileInputFiles", { backendNodeId: target.backendNodeId, files });
    const accepted = await this.fileInputState(target.backendNodeId);
    const expectedNames = files.map((file) => String(file).split(/[\\/]/).at(-1) || "");
    if (accepted.length !== expectedNames.length || accepted.some((file, index) => file.filename !== expectedNames[index])) {
      throw new Error("file_input_acceptance_mismatch");
    }
    const observation = await this.observeDelta();
    return this.withObservationMeta("verified", { files: accepted, fileCount: accepted.length }, observation);
  }

  async fileInputFacts(backendNodeId) {
    const objectId = await this.objectIdFor(backendNodeId);
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
    }).catch(() => null);
    return result?.result?.value ?? { isFileInput: false, multiple: false, visible: false };
  }

  async fileInputState(backendNodeId) {
    const objectId = await this.objectIdFor(backendNodeId);
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
    }).catch(() => null);
    return Array.isArray(result?.result?.value) ? result.result.value : [];
  }

  async scroll(action) {
    const dy = Number(action.value) || 600;
    const beforeY = await this.evalNumber("window.scrollY");
    const acknowledged = await this.cdp(
      "Input.dispatchMouseEvent",
      { type: "mouseWheel", x: 10, y: 10, deltaX: 0, deltaY: dy },
      SCROLL_DISPATCH_TIMEOUT_MS,
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
    if (target?.backendNodeId) await this.cdp("DOM.focus", { backendNodeId: target.backendNodeId }).catch(() => {});
    const keys = Array.isArray(action.keys) && action.keys.length > 0 ? action.keys : [String(action.value ?? "Enter")];
    const signalWindow = this.beginActionSignals();
    try {
      for (const key of keys.slice(0, 8)) {
        await this.cdp("Input.dispatchKeyEvent", { type: "keyDown", key: String(key) });
        await this.cdp("Input.dispatchKeyEvent", { type: "keyUp", key: String(key) });
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

  async hover(action) {
    const target = await this.resolveTarget(action);
    if (!target) return this.targetMoved("not_found");
    const point = target.point ?? await this.actionablePoint(target.backendNodeId);
    if (!point) return this.targetMoved();
    await this.moveMouse(point);
    await this.sendToPage({ type: "NB_DRIVE_MOVE", x: point.x, y: point.y });
    await this.settleShort();
    const observation = await this.observeDelta();
    return this.withObservationMeta("verified", { hovered: true }, observation);
  }

  async moveMouse(point) {
    await this.cdp("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: point.x,
      y: point.y,
      button: "none",
      buttons: 0,
      pointerType: "mouse",
    });
  }

  async pressMouse(point) {
    await this.cdp("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: point.x,
      y: point.y,
      button: "left",
      buttons: 1,
      clickCount: 1,
      pointerType: "mouse",
    });
  }

  async releaseMouse(point) {
    await this.cdp("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: point.x,
      y: point.y,
      button: "left",
      buttons: 0,
      clickCount: 1,
      pointerType: "mouse",
    });
  }

  // Resolve the target element's structural facts so the SW can re-check the
  // floor with real evidence BEFORE dispatching a mutating action (§7, S3). The
  // accessible name lets host/structural commit rules gate a ref-targeted click.
  async resolveEvidence(action) {
    const origin = await this.evalString("location.origin");
    const target = await this.resolveTarget(action).catch(() => null);
    if (!target?.backendNodeId) {
      return { resolved: { origin }, signals: {} };
    }
    const facts = await this.elementFacts(target.backendNodeId);
    // Use the authoritative AX accessible name (same source as observe). The
    // naive aria-label/innerText read in elementFacts misses names computed by
    // the accessibility algorithm (labelledby, nested web components like the
    // YouTube Subscribe button) — without this the commit re-check under-reads
    // the name and fails to escalate.
    const axName = await this.axNameFor(target.backendNodeId);
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
  async axNameFor(backendNodeId) {
    const tree = await this.cdp("Accessibility.getPartialAXTree", { backendNodeId, fetchRelatives: false }).catch(() => null);
    const nodes = Array.isArray(tree?.nodes) ? tree.nodes : [];
    const node = nodes.find((n) => n.backendDOMNodeId === backendNodeId && n.name?.value) ?? nodes.find((n) => n.name?.value);
    return node?.name?.value ? String(node.name.value).slice(0, 240) : "";
  }

  async elementFacts(backendNodeId) {
    const objectId = await this.objectIdFor(backendNodeId);
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
          formSubmit: Boolean(isSubmit && form),
        };
      }`,
      returnByValue: true,
    }).catch(() => null);
    return result?.result?.value && typeof result.result.value === "object" ? result.result.value : {};
  }

  // ── Targeting + actionability (§7.5) ───────────────────────────────────────
  async resolveTarget(action) {
    const target = normalizedTarget(action);
    if (target) {
      if (target.coordinates) return { point: target.coordinates };
      if (target.ref && this.refIndex.has(target.ref)) return { backendNodeId: this.refIndex.get(target.ref) };
      // Stable element-keyed ref from an earlier observation: recover the exact
      // element by its backendNodeId if it still exists (S21) instead of falling
      // through to a positional/text re-match that could pick a different node.
      if (target.ref) {
        const recovered = await this.backendNodeForStableRef(target.ref);
        if (recovered) return { backendNodeId: recovered };
      }
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
        if (match && this.refIndex.has(match.ref)) return { backendNodeId: this.refIndex.get(match.ref) };
      }
      if (target.text) {
        const backendNodeId = await this.backendNodeIdFromElementExpression(findByVisibleTextSource(), [target.text, Boolean(target.exact)]);
        if (backendNodeId) return { backendNodeId };
      }
      return null;
    }
    // valid ref → role_name → text → selector. Never click a guess.
    if (action.ref && this.refIndex.has(action.ref)) {
      return { backendNodeId: this.refIndex.get(action.ref) };
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
      if (match && this.refIndex.has(match.ref)) return { backendNodeId: this.refIndex.get(match.ref) };
    }
    return null;
  }

  // Recover the element for a stable `e<backendNodeId>` ref from any prior
  // observation, if that exact node still exists in the live DOM (S21).
  async backendNodeForStableRef(ref) {
    const match = /^e(\d+)$/.exec(String(ref ?? ""));
    if (!match) return null;
    const backendNodeId = Number(match[1]);
    const described = await this.cdp("DOM.describeNode", { backendNodeId }).catch(() => null);
    return described?.node ? backendNodeId : null;
  }

  async backendNodeIdForSelector(selector) {
    const root = await this.cdp("DOM.getDocument", { depth: 0 }).catch(() => null);
    const nodeId = root?.root?.nodeId;
    if (!nodeId) return null;
    const found = await this.cdp("DOM.querySelectorAll", { nodeId, selector }).catch(() => null);
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

  async actionablePoint(backendNodeId) {
    // Bring off-screen / below-the-fold targets into view first — the single
    // biggest real-world reliability win. Without this, an element outside the
    // viewport never hit-tests and times out as stale_target (seen live on the
    // large dynamic catalog).
    await this.scrollIntoView(backendNodeId);
    const deadline = Date.now() + AUTO_WAIT_TIMEOUT_MS;
    const vh = (await this.evalNumber("window.innerHeight")) || 100000;
    const vw = (await this.evalNumber("window.innerWidth")) || 100000;
    let previous = null;
    let rescrolls = 0;
    while (Date.now() < deadline) {
      const box = await this.boxFor(backendNodeId);
      if (box && box.width > 0 && box.height > 0) {
        const cx = box.x + box.width / 2;
        const cy = box.y + box.height / 2;
        // If the bbox centre is outside the viewport, re-scroll (bounded) and re-measure.
        if ((cy < 0 || cy > vh || cx < 0 || cx > vw) && rescrolls < 3) {
          rescrolls += 1;
          await this.scrollIntoView(backendNodeId);
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
          for (const pt of await this.candidatePoints(backendNodeId)) {
            const x = Math.round(pt.x);
            const y = Math.round(pt.y);
            if (x < 0 || x > vw || y < 0 || y > vh) continue;
            if (await this.hitTestTarget(backendNodeId, x, y)) return { x, y };
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
  async candidatePoints(backendNodeId) {
    const quads = await this.cdp("DOM.getContentQuads", { backendNodeId }).catch(() => null);
    const cdpPoints = centersForQuads(quads?.quads);
    if (cdpPoints.length > 0) return cdpPoints;
    const objectId = await this.objectIdFor(backendNodeId);
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
    }).catch(() => null);
    const pts = res?.result?.value;
    return Array.isArray(pts) ? pts.filter((p) => Number.isFinite(p?.x) && Number.isFinite(p?.y)) : [];
  }

  async scrollIntoView(backendNodeId) {
    const objectId = await this.objectIdFor(backendNodeId);
    if (!objectId) return;
    await this.cdp("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: `function () { try { this.scrollIntoView({ block: "center", inline: "center" }); } catch (e) {} }`,
    }).catch(() => {});
  }

  async boxFor(backendNodeId) {
    const quads = await this.cdp("DOM.getContentQuads", { backendNodeId }).catch(() => null);
    const quadBox = boundsForQuads(quads?.quads);
    if (quadBox) return quadBox;
    const objectId = await this.objectIdFor(backendNodeId);
    if (objectId) {
      const rect = await this.cdp("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: `function () {
          const rect = this.getBoundingClientRect();
          return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        }`,
        returnByValue: true,
      }).catch(() => null);
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

    const model = await this.cdp("DOM.getBoxModel", { backendNodeId }).catch(() => null);
    const quad = model?.model?.content;
    if (!quad || quad.length < 8) return null;
    const xs = [quad[0], quad[2], quad[4], quad[6]];
    const ys = [quad[1], quad[3], quad[5], quad[7]];
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    const scrollX = await this.evalNumber("window.scrollX");
    const scrollY = await this.evalNumber("window.scrollY");
    return { x: x - scrollX, y: y - scrollY, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
  }

  async hitTestTarget(backendNodeId, x, y) {
    const hit = await this.cdp("DOM.getNodeForLocation", {
      x: Math.round(x),
      y: Math.round(y),
      includeUserAgentShadowDOM: true,
      ignorePointerEventsNone: false,
    }).catch(() => null);
    if (!Number.isInteger(hit?.backendNodeId)) return this.runtimeHitTestTarget(backendNodeId, x, y);
    if (hit.backendNodeId === backendNodeId) return true;
    const objectId = await this.objectIdFor(backendNodeId);
    const hitObjectId = await this.objectIdFor(hit.backendNodeId);
    if (objectId && hitObjectId) {
      const result = await this.cdp("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: "function (hit) { return Boolean(hit && (hit === this || this.contains(hit))); }",
        arguments: [{ objectId: hitObjectId }],
        returnByValue: true,
      }).catch(() => null);
      if (result?.result?.value === true) return true;
    }
    return this.runtimeHitTestTarget(backendNodeId, x, y);
  }

  async runtimeHitTestTarget(backendNodeId, x, y) {
    const objectId = await this.objectIdFor(backendNodeId);
    if (!objectId) return false;
    const result = await this.cdp("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: `function (x, y) {
        const hit = document.elementFromPoint(x, y);
        return Boolean(hit && (hit === this || this.contains(hit)));
      }`,
      arguments: [{ value: x }, { value: y }],
      returnByValue: true,
    }).catch(() => null);
    return Boolean(result?.result?.value);
  }

  async objectIdFor(backendNodeId) {
    const resolved = await this.cdp("DOM.resolveNode", { backendNodeId }).catch(() => null);
    return typeof resolved?.object?.objectId === "string" ? resolved.object.objectId : null;
  }

  async isOwnedOverlayNode(backendNodeId) {
    const described = await this.cdp("DOM.describeNode", { backendNodeId }).catch(() => null);
    const attrs = described?.node?.attributes ?? [];
    for (let i = 0; i < attrs.length; i += 2) {
      if (attrs[i] === "data-newton-browser-ui") return true;
    }
    return false;
  }

  async selectAll() {
    await this.cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", modifiers: 2 });
    await this.cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", modifiers: 2 });
  }

  async maskZones(zones) {
    if (!Array.isArray(zones) || zones.length === 0) return;
    await this.sendToPage({ type: "NB_DRIVE_MASK", zones });
  }

  async unmaskZones() {
    await this.sendToPage({ type: "NB_DRIVE_UNMASK" });
  }

  async waitForSettle() {
    const deadline = Date.now() + SETTLE_TIMEOUT_MS;
    let last = "";
    let stable = 0;
    while (Date.now() < deadline) {
      // Cheap settle fingerprint (S10): readyState + a structural counter + url.
      // Avoids serializing the whole DOM (innerHTML.length) every poll, which
      // janks large pages and is a weak signal anyway.
      const fingerprint = await this.evalString(
        "document.readyState + ':' + (document.body ? document.body.childElementCount : 0) + ':' + (document.querySelectorAll ? document.querySelectorAll('*').length : 0) + ':' + location.href",
      );
      if (fingerprint.startsWith("complete") && fingerprint === last) {
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
    await delay(180);
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

  async evalString(expression) {
    const result = await this.cdp("Runtime.evaluate", { expression, returnByValue: true }).catch(() => null);
    return typeof result?.result?.value === "string" ? result.result.value : "";
  }

  async evalNumber(expression) {
    const result = await this.cdp("Runtime.evaluate", { expression, returnByValue: true }).catch(() => null);
    return typeof result?.result?.value === "number" ? result.result.value : 0;
  }

  async evalBool(expression) {
    const result = await this.cdp("Runtime.evaluate", { expression, returnByValue: true }).catch(() => null);
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
        const state = await this.elementState(target.backendNodeId);
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
    }).catch(() => null);
    return Boolean(result?.result?.value);
  }

  async pageSignature() {
    return {
      url: await this.evalString("location.href"),
      title: await this.evalString("document.title"),
    };
  }

  async elementState(backendNodeId) {
    const objectId = await this.objectIdFor(backendNodeId);
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
    }).catch(() => null);
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
      },
    };
  }

  async targetMoved(status = "stale_target") {
    const observation = await this.observe({});
    return this.withObservationMeta(status, {}, observation, status === "not_found" ? "target_not_found" : "target_moved");
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
    if (prev.name !== node.name || prev.value !== node.value || prev.role !== node.role) {
      updated.push({
        ref: node.ref,
        ...(prev.name !== node.name ? { name: node.name } : {}),
        ...(prev.value !== node.value ? { value: node.value } : {}),
      });
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

function sameOriginChildFrameIds(frameTree, origin) {
  const ids = [];
  const visit = (tree) => {
    for (const child of tree?.childFrames ?? []) {
      if (safeOrigin(child?.frame?.url) !== origin) continue;
      if (typeof child?.frame?.id === "string") ids.push(child.frame.id);
      visit(child);
    }
  };
  visit(frameTree);
  return ids;
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

function reconciliationChanges(signals) {
  const changed = {};
  for (const key of ["navigation", "networkWrite", "dialog", "download", "newTarget"]) {
    if (signals?.[key]) changed[key] = true;
  }
  return changed;
}

function reconcilePostActionSignals(signals) {
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
