import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const appRoot = "apps/extension";

test("standalone extension source has no forbidden product coupling", () => {
  const files = [
    "manifest.json",
    "package.json",
    "panel.html",
    "onboarding.html",
    "icons/icon-generated-v2.png",
    "src/config.js",
    "src/local-transport.js",
    "src/onboarding-lifecycle.js",
    "src/onboarding.js",
    "src/onboarding.css",
    "src/panel.css",
    "src/panel.js",
    "src/panel-session-summary.js",
    "src/service-worker.js",
    "src/toolbar-icon.js",
  ];
  for (const file of files) {
    const text = fs.readFileSync(path.join(appRoot, file), "utf8");
    const forbidden = new RegExp(["shi" + "re", "her" + "mes", "com" + "panion", "shared" + "\\.mjs"].join("|"), "i");
    assert.doesNotMatch(text, forbidden, file);
  }
});

test("standalone extension root manifest points at generated runtime", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(appRoot, "manifest.json"), "utf8"));
  assert.equal(manifest.action.default_popup, "dist/panel.html");
  assert.equal(manifest.background.service_worker, "dist/src/service-worker.js");
  assert.deepEqual(manifest.icons, {
    16: "icons/icon-16.png",
    32: "icons/icon-32.png",
    48: "icons/icon-48.png",
    128: "icons/icon-128.png",
  });
  assert.deepEqual(manifest.action.default_icon, {
    16: "icons/action-disconnected-16.png",
    32: "icons/action-disconnected-32.png",
  });
  assert.deepEqual(
    manifest.web_accessible_resources[0].resources,
    ["dist/src/overlay.js", "dist/src/overlay.css"],
  );
  assert.match(fs.readFileSync(path.join(appRoot, "onboarding.html"), "utf8"), /dist\/src\/onboarding\.js/);
});

test("standalone extension build materializes package runtime into dist", () => {
  const result = spawnSync(process.execPath, ["scripts/build-extension.mjs"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const distRoot = path.join(appRoot, "dist");
  for (const file of [
    "panel.html",
    "src/service-worker.js",
    "src/vendor/newton-browser-core/risk.js",
    "src/vendor/newton-browser-driver/controller.js",
    "src/vendor/newton-browser-driver/chrome-tabs-port.js",
    "src/vendor/newton-browser-driver/driver.js",
    "src/vendor/newton-browser-driver/session-command-pump.js",
    "src/vendor/newton-browser-driver/session-transaction.js",
    "src/vendor/newton-browser-driver/target-registry.js",
    "src/vendor/newton-browser-driver/origin-containment.js",
    "src/vendor/newton-browser-driver/input-dispatcher.js",
    "src/vendor/newton-browser-driver/renderer-liveness.js",
    "src/overlay.js",
    "src/overlay.css",
    "src/onboarding.js",
    "src/onboarding.css",
  ]) {
    assert.ok(fs.existsSync(path.join(distRoot, file)), file);
  }
  const risk = fs.readFileSync(path.join(distRoot, "src/vendor/newton-browser-core/risk.js"), "utf8");
  assert.doesNotMatch(risk, /import type|export type|\.ts["']/);
  assert.match(risk, /export function evaluateBrowserFloor/);
  const driver = fs.readFileSync(path.join(distRoot, "src/vendor/newton-browser-driver/driver.js"), "utf8");
  assert.match(driver, /"dist\/src\/overlay\.css"/);
  assert.match(driver, /"dist\/src\/overlay\.js"/);
  assertRelativeImportClosure(distRoot, "src/service-worker.js");
  const panel = fs.readFileSync(path.join(distRoot, "panel.html"), "utf8");
  assert.match(panel, /id="status-text"/);
  assert.doesNotMatch(panel, /approval|id="host"|id="start"|id="observe"|id="screenshot"/i);
  const serviceWorker = fs.readFileSync(path.join(distRoot, "src/service-worker.js"), "utf8");
  assert.doesNotMatch(serviceWorker, /void maybeConnectHost|function maybeConnectHost/);
  assert.doesNotMatch(serviceWorker, /NB_PANEL_HOST_CONNECT|NB_PANEL_START|NB_PANEL_COMMAND|NB_PANEL_APPROVAL|ApprovalSink|PanelApproval|approvalSink/);
  assert.match(serviceWorker, /void syncHost\(\)/);
  assert.match(serviceWorker, /runtime\.renewLeases\(\)/);
  assert.match(serviceWorker, /chrome\.storage\.local\.get\(SESSION_BINDINGS_KEY\)/);
  assert.match(serviceWorker, /chrome\.storage\.local\.set\(\{ \[SESSION_BINDINGS_KEY\]/);
  assert.match(serviceWorker, /ensureForActiveSessions\(activeTab\?\.id, bindings\)/);
  assert.match(serviceWorker, /cleanupOrphanBindings/);
  assert.match(serviceWorker, /createToolbarIconController/);
  assert.match(serviceWorker, /openOnFirstInstall/);
  assert.match(serviceWorker, /case "NB_PANEL_STOP_ALL"/);
  assert.match(serviceWorker, /sessions: summarizePanelSessions\(sessions\)/);
  const localTransport = fs.readFileSync(path.join(distRoot, "src/local-transport.js"), "utf8");
  assert.doesNotMatch(localTransport, /enqueueCommand|postEscalation|no_live_session|command_timeout|sessions = new Map/);
});

function assertRelativeImportClosure(root: string, entry: string) {
  const pending = [entry];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const relative = pending.pop()!;
    if (visited.has(relative)) continue;
    visited.add(relative);
    const absolute = path.join(root, relative);
    assert.ok(fs.existsSync(absolute), `missing runtime import: ${relative}`);
    const source = fs.readFileSync(absolute, "utf8");
    for (const match of source.matchAll(/(?:import|export)\s+(?:[^"']+?\s+from\s+)?["'](\.[^"']+)["']/g)) {
      const resolved = path.normalize(path.join(path.dirname(relative), match[1])).replaceAll("\\", "/");
      pending.push(resolved);
    }
  }
}

test("first-run onboarding opens once for installation and never for updates", async () => {
  const moduleUrl = pathToFileURL(path.resolve(appRoot, "src/onboarding-lifecycle.js")).href;
  const { openOnFirstInstall } = await import(`${moduleUrl}?install=${Date.now()}`);
  let opened = 0;
  assert.equal(openOnFirstInstall({ reason: "update" }, () => { opened += 1; }), false);
  assert.equal(openOnFirstInstall({ reason: "install" }, () => { opened += 1; }), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(opened, 1);
});

test("icon renderer creates manifest and toolbar assets that are packed", () => {
  let result = spawnSync(process.execPath, ["scripts/render-icons.mjs"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  for (const file of ["icon-16.png", "icon-32.png", "icon-48.png", "icon-128.png", "action-connected-16.png", "action-connected-32.png", "action-disconnected-16.png", "action-disconnected-32.png"]) {
    assert.ok(fs.existsSync(path.join(appRoot, "icons", file)), file);
  }
  result = spawnSync(process.execPath, ["scripts/build-extension-artifact.mjs"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("toolbar icon state is debounced and follows host connection state", async () => {
  const moduleUrl = pathToFileURL(path.resolve(appRoot, "src/toolbar-icon.js")).href;
  const { createToolbarIconController } = await import(`${moduleUrl}?icons=${Date.now()}`);
  const timers: Array<() => void> = [];
  const cleared: number[] = [];
  const calls: any[] = [];
  let connected = false;
  const controller = createToolbarIconController({
    action: { setIcon: async (input: any) => { calls.push(input); } },
    getConnected: () => connected,
    setTimer: (callback: () => void) => { timers.push(callback); return timers.length; },
    clearTimer: (id: number) => { cleared.push(id); },
  });
  controller.schedule();
  connected = true;
  controller.schedule();
  assert.deepEqual(cleared, [1]);
  timers.at(-1)?.();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [{ path: { 16: "icons/action-connected-16.png", 32: "icons/action-connected-32.png" } }]);
});

test("panel session contract exposes only bounded origin, mode, and label summaries", async () => {
  const moduleUrl = pathToFileURL(path.resolve(appRoot, "src/panel-session-summary.js")).href;
  const { summarizePanelSessions, createPanelViewModel } = await import(`${moduleUrl}?sessions=${Date.now()}`);
  const sessions = [
    { origin: "https://example.com", tabMode: "owned_group", instanceLabel: "research", title: "do not expose", url: "https://example.com/private" },
    { origin: "https://example.net", tabMode: "current", instanceLabel: "review" },
  ];
  assert.deepEqual(summarizePanelSessions(sessions), [
    { origin: "https://example.com", mode: "owned", label: "research" },
    { origin: "https://example.net", mode: "current", label: "review" },
  ]);
  assert.deepEqual(createPanelViewModel({ sessions: [], extensionVersion: "0.3.0" }), {
    rows: [], showSessions: false, showStopAll: false, version: "Extension 0.3.0", versionSkew: false,
  });
  assert.equal(createPanelViewModel({ sessions, extensionVersion: "0.3.0", hostVersion: "0.4.0" }).showStopAll, true);
});

test("standalone extension polls host health without opening a WebSocket when unavailable", async () => {
  const moduleUrl = pathToFileURL(path.resolve(appRoot, "src/local-transport.js")).href;
  const { createLocalPanelTransport } = await import(`${moduleUrl}?health=${Date.now()}`);
  const originalWebSocket = (globalThis as any).WebSocket;
  let constructed = 0;
  (globalThis as any).WebSocket = class {
    constructor() {
      constructed += 1;
    }
  };
  try {
    const transport = createLocalPanelTransport({
      healthCheck: async () => false,
      hostUrls: ["ws://127.0.0.1:17321"],
    });
    assert.deepEqual(await transport.connectHost(), { connected: false, hostCount: 0, pairingRequired: false });
    assert.equal(constructed, 0);
  } finally {
    (globalThis as any).WebSocket = originalWebSocket;
  }
});

test("standalone extension retries host health after an initial miss", async () => {
  const moduleUrl = pathToFileURL(path.resolve(appRoot, "src/local-transport.js")).href;
  const { createLocalPanelTransport } = await import(`${moduleUrl}?retry=${Date.now()}`);
  const originalWebSocket = (globalThis as any).WebSocket;
  let constructed = 0;
  let healthCalls = 0;
  (globalThis as any).WebSocket = class {
    listeners: Record<string, (event?: any) => void> = {};

    constructor() {
      constructed += 1;
    }

    addEventListener(type: string, listener: (event?: any) => void) {
      this.listeners[type] = listener;
      if (type === "message") queueMicrotask(() => listener({ data: JSON.stringify({
        type: "auth_challenge",
        hostInstanceId: "host-1",
        nonce: "nonce-1",
      }) }));
    }

    send(raw: string) {
      const message = JSON.parse(raw);
      if (message.type === "auth_response") queueMicrotask(() => this.listeners.message?.({ data: JSON.stringify({
        type: "ready",
        hostInstanceId: "host-1",
        sessions: [],
      }) }));
    }

    close() {}
  };
  try {
    const transport = createLocalPanelTransport({
      healthCheck: async () => {
        healthCalls += 1;
        return healthCalls > 1;
      },
      hostUrls: ["ws://127.0.0.1:17321"],
      getPairingSecret: async () => "test-secret",
      signChallenge: async () => "test-proof",
    });
    assert.deepEqual(await transport.connectHost(), { connected: false, hostCount: 0, pairingRequired: false });
    assert.deepEqual(await transport.connectHost(), { connected: true, hostCount: 1, pairingRequired: false });
    assert.equal(healthCalls, 2);
    assert.equal(constructed, 1);
  } finally {
    (globalThis as any).WebSocket = originalWebSocket;
  }
});

test("standalone extension connects in zero-touch local-trust mode without reading a pairing key", async () => {
  const moduleUrl = pathToFileURL(path.resolve(appRoot, "src/local-transport.js")).href;
  const { createLocalPanelTransport } = await import(`${moduleUrl}?local-trust=${Date.now()}`);
  const originalWebSocket = (globalThis as any).WebSocket;
  let pairingReads = 0;
  (globalThis as any).WebSocket = class {
    listeners: Record<string, (event?: any) => void> = {};

    addEventListener(type: string, listener: (event?: any) => void) {
      this.listeners[type] = listener;
      if (type === "message") queueMicrotask(() => listener({ data: JSON.stringify({
        type: "ready",
        authMode: "local_trust",
        hostInstanceId: "host-local",
        sessions: [],
      }) }));
    }

    send() {}
    close() {}
  };
  try {
    const transport = createLocalPanelTransport({
      healthCheck: async () => true,
      hostUrls: ["ws://127.0.0.1:17321"],
      getPairingSecret: async () => { pairingReads += 1; return null; },
    });
    assert.deepEqual(await transport.connectHost(), { connected: true, hostCount: 1, pairingRequired: false });
    assert.equal(pairingReads, 0);
  } finally {
    (globalThis as any).WebSocket = originalWebSocket;
  }
});

test("standalone extension stays connected as a non-controlling standby for another browser target", async () => {
  const moduleUrl = pathToFileURL(path.resolve(appRoot, "src/local-transport.js")).href;
  const { createLocalPanelTransport } = await import(`${moduleUrl}?browser-target=${Date.now()}`);
  const originalWebSocket = (globalThis as any).WebSocket;
  const sent: any[] = [];
  (globalThis as any).WebSocket = class {
    listeners: Record<string, (event?: any) => void> = {};

    addEventListener(type: string, listener: (event?: any) => void) {
      this.listeners[type] = listener;
      if (type === "message") queueMicrotask(() => listener({ data: JSON.stringify({
        type: "ready",
        authMode: "local_trust",
        browserTarget: "edge",
        hostInstanceId: "host-edge-only",
        sessions: [{ sessionId: "edge-session", origin: "https://example.com" }],
      }) }));
    }

    send(raw: string) { sent.push(JSON.parse(raw)); }
    close() {}
  };
  try {
    const transport = createLocalPanelTransport({
      healthCheck: async () => true,
      hostUrls: ["ws://127.0.0.1:17321"],
      getClientIdentity: async () => ({ clientId: "chrome_profile_test", browserFamily: "chrome", browserMajor: 130 }),
    });
    assert.deepEqual(await transport.connectHost(), { connected: false, hostCount: 0, pairingRequired: false });
    assert.deepEqual(sent, [{
      type: "client_hello",
      clientId: "chrome_profile_test",
      browserFamily: "chrome",
      browserMajor: 130,
    }]);
    assert.deepEqual(await transport.listSessions(), []);
    assert.equal(sent.some((message) => message.type === "bridge_request"), false, "standby must not claim or query sessions");
  } finally {
    (globalThis as any).WebSocket = originalWebSocket;
  }
});

test("standalone extension does not create hidden local sessions when host is unavailable", async () => {
  const moduleUrl = pathToFileURL(path.resolve(appRoot, "src/local-transport.js")).href;
  const { createLocalPanelTransport } = await import(`${moduleUrl}?host-only=${Date.now()}`);
  const transport = createLocalPanelTransport({
    healthCheck: async () => false,
    hostUrls: ["ws://127.0.0.1:17321"],
  });

  await assert.rejects(
    transport.createSession({ origin: "https://example.com" }),
    /host_unavailable/,
  );
  assert.deepEqual(await transport.listSessions(), []);
});

test("standalone extension removes only a dead host's sessions", async () => {
  const moduleUrl = pathToFileURL(path.resolve(appRoot, "src/local-transport.js")).href;
  const { createLocalPanelTransport } = await import(`${moduleUrl}?host-isolation=${Date.now()}`);
  const originalWebSocket = (globalThis as any).WebSocket;
  const sockets = new Map<string, any>();
  const deadUrls = new Set<string>();
  let changes = 0;
  (globalThis as any).WebSocket = class {
    listeners: Record<string, (event?: any) => void> = {};
    url: string;
    constructor(url: string) {
      this.url = url;
      sockets.set(url, this);
    }
    addEventListener(type: string, listener: (event?: any) => void) {
      this.listeners[type] = listener;
      if (type === "message") queueMicrotask(() => listener({ data: JSON.stringify({
        type: "auth_challenge", hostInstanceId: `host-${this.url.at(-1)}`, nonce: "nonce",
      }) }));
    }
    send(raw: string) {
      const message = JSON.parse(raw);
      if (message.type === "auth_response") queueMicrotask(() => this.listeners.message?.({ data: JSON.stringify({
        type: "ready",
        hostInstanceId: `host-${this.url.at(-1)}`,
        sessions: [{ sessionId: `session-${this.url.at(-1)}`, origin: "https://example.com" }],
      }) }));
      if (message.type === "bridge_request" && message.method === "listSessions") queueMicrotask(() => this.listeners.message?.({ data: JSON.stringify({
        type: "bridge_response",
        requestId: message.requestId,
        ok: true,
        result: [{ sessionId: `session-${this.url.at(-1)}`, origin: "https://example.com" }],
      }) }));
    }
    close() { this.listeners.close?.(); }
  };
  try {
    const urls = ["ws://127.0.0.1:17321", "ws://127.0.0.1:17322"];
    const transport = createLocalPanelTransport({
      hostUrls: urls,
      healthCheck: async (url: string) => !deadUrls.has(url),
      getPairingSecret: async () => "test-secret",
      signChallenge: async () => "test-proof",
      hostCleanupDelayMs: 0,
      onHostSessionsChanged: () => { changes += 1; },
    });
    assert.deepEqual(await transport.connectHost(), { connected: true, hostCount: 2, pairingRequired: false });
    assert.deepEqual((await transport.listSessions()).map((session: any) => session.sessionId).sort(), ["session-1", "session-2"]);
    deadUrls.add(urls[0]);
    sockets.get(urls[0])?.close();
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(changes >= 3, true, "two ready hosts plus one dead-host reconciliation");
    assert.deepEqual((await transport.listSessions()).map((session: any) => session.sessionId), ["session-2"]);
  } finally {
    (globalThis as any).WebSocket = originalWebSocket;
  }
});
