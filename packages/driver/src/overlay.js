// Bridge "is driving" visual system (Proposal 26, §5). Injected into the page
// All nodes carry data-newton-browser-ui="1" so observations can exclude them. Fully decoupled from execution: the cursor never
// gates an action (§5.1) — hops queue and replay at ~100ms so a fast batch stays
// watchable, but if the overlay is slow/missing the action still proceeds.
(() => {
  if (window.__newtonBrowserDriveOverlayLoaded) return;
  window.__newtonBrowserDriveOverlayLoaded = true;

  const ROOT_ID = "newton-browser-drive-overlay";
  const HOP_MS = 100;
  let root = null;
  let cursor = null;
  let masks = [];
  const hopQueue = [];
  let hopping = false;

  function el(tag, opts = {}) {
    const node = document.createElement(tag);
    node.setAttribute("data-newton-browser-ui", "1");
    if (opts.id) node.id = opts.id;
    if (opts.class) node.className = opts.class;
    if (opts.text) node.textContent = opts.text;
    return node;
  }

  function ensureRoot() {
    if (root && document.documentElement.contains(root)) return root;
    root = el("div", { id: ROOT_ID });
    cursor = el("div", { class: "nb-cursor" });
    // Refined pointer: fill follows --nb-accent (currentColor), white stroke for
    // contrast on any background, rounded joins; the soft glow + drop-shadow come
    // from CSS. aria-hidden — it is decorative chrome (data-newton-browser-ui excluded).
    cursor.innerHTML = '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path d="M4.2 2.4l15 8.1c.8.45.6 1.65-.3 1.82l-6.1 1.2-2.5 5.9c-.36.85-1.6.78-1.86-.1L3.5 3.7c-.26-.86.6-1.6 1.4-1.3z" fill="currentColor" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg>';
    cursor.setAttribute("data-newton-browser-ui", "1");
    const tag = el("div", { class: "nb-cursor-tag", text: "Newton" });
    cursor.appendChild(tag);
    root.appendChild(cursor);
    document.documentElement.appendChild(root);
    return root;
  }

  // Idempotent: safe to call again after a re-injection (navigation / SW wake).
  // An optional accent ("r, g, b") lets a per-session tab-group color theme the
  // rim glow, cursor halo, ripple, and field ring (Proposal 28 §3b / D2).
  function begin(accent, ownerLabel = "Newton") {
    ensureRoot();
    if (typeof accent === "string" && /^\s*\d+\s*,\s*\d+\s*,\s*\d+\s*$/.test(accent)) {
      root.style.setProperty("--nb-accent", accent);
    }
    const label = typeof ownerLabel === "string" && ownerLabel.trim() ? ownerLabel.trim().slice(0, 40) : "Newton";
    const tag = cursor?.querySelector?.(".nb-cursor-tag");
    if (tag) tag.textContent = label;
    root.classList.add("nb-driving");
  }

  function end() {
    root?.remove();
    root = null;
    cursor = null;
    masks.forEach((node) => node.remove());
    masks = [];
    hopQueue.length = 0;
    hopping = false;
  }

  // Queue hops so a rapid batch replays watchably; fast-forward if far behind.
  function enqueueHop(x, y, after) {
    ensureRoot();
    hopQueue.push({ x, y, after });
    if (hopQueue.length > 24) hopQueue.splice(0, hopQueue.length - 8); // never mislead — snap forward
    if (!hopping) void drainHops();
  }

  async function drainHops() {
    hopping = true;
    while (hopQueue.length > 0) {
      const hop = hopQueue.shift();
      moveCursor(hop.x, hop.y);
      hop.after?.();
      await sleep(HOP_MS);
    }
    hopping = false;
  }

  function moveCursor(x, y) {
    if (!cursor) return;
    cursor.style.transform = `translate(${x}px, ${y}px)`;
  }

  function ripple(x, y) {
    ensureRoot();
    const node = el("div", { class: "nb-ripple" });
    node.style.left = `${x}px`;
    node.style.top = `${y}px`;
    root.appendChild(node);
    node.addEventListener("animationend", () => node.remove());
    setTimeout(() => node.remove(), 800);
  }

  function fieldRing(rect) {
    ensureRoot();
    const node = el("div", { class: "nb-field-ring" });
    node.style.left = `${rect.x}px`;
    node.style.top = `${rect.y}px`;
    node.style.width = `${rect.width}px`;
    node.style.height = `${rect.height}px`;
    root.appendChild(node);
    setTimeout(() => node.remove(), 1400);
  }

  function applyMasks(zones) {
    clearMasks();
    if (!Array.isArray(zones)) return;
    for (const zone of zones) {
      const selector = zone?.selector;
      if (!selector) continue;
      let targets = [];
      try { targets = Array.from(document.querySelectorAll(selector)); } catch { targets = []; }
      for (const target of targets) {
        const rect = target.getBoundingClientRect?.();
        if (!rect || rect.width <= 0) continue;
        const mask = el("div", { class: "nb-mask" });
        mask.style.left = `${rect.left}px`;
        mask.style.top = `${rect.top}px`;
        mask.style.width = `${rect.width}px`;
        mask.style.height = `${rect.height}px`;
        document.documentElement.appendChild(mask);
        masks.push(mask);
      }
    }
  }

  function clearMasks() {
    masks.forEach((node) => node.remove());
    masks = [];
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    switch (message?.type) {
      case "NB_DRIVE_BEGIN": begin(message.accent, message.ownerLabel); sendResponse?.({ ok: true }); return false;
      case "NB_DRIVE_END": end(); sendResponse?.({ ok: true }); return false;
      case "NB_DRIVE_MOVE": enqueueHop(message.x, message.y); sendResponse?.({ ok: true }); return false;
      case "NB_DRIVE_CLICK": enqueueHop(message.x, message.y, () => ripple(message.x, message.y)); sendResponse?.({ ok: true }); return false;
      case "NB_DRIVE_FIELD": if (message.rect) fieldRing(message.rect); sendResponse?.({ ok: true }); return false;
      case "NB_DRIVE_SCROLL": sendResponse?.({ ok: true }); return false;
      case "NB_DRIVE_MASK": applyMasks(message.zones); sendResponse?.({ ok: true }); return false;
      case "NB_DRIVE_UNMASK": clearMasks(); sendResponse?.({ ok: true }); return false;
      default: return false;
    }
  });
})();
