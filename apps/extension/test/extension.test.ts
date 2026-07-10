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
    "src/config.js",
    "src/local-transport.js",
    "src/panel.css",
    "src/panel.js",
    "src/service-worker.js",
  ];
  for (const file of files) {
    const text = fs.readFileSync(path.join(appRoot, file), "utf8");
    const forbidden = new RegExp(["@" + "new" + "ton/", "new" + "ton", "shi" + "re", "her" + "mes", "com" + "panion", "shared" + "\\.mjs"].join("|"), "i");
    assert.doesNotMatch(text, forbidden, file);
  }
});

test("standalone extension root manifest points at generated runtime", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(appRoot, "manifest.json"), "utf8"));
  assert.equal(manifest.action.default_popup, "dist/panel.html");
  assert.equal(manifest.background.service_worker, "dist/src/service-worker.js");
  assert.deepEqual(
    manifest.web_accessible_resources[0].resources,
    ["dist/src/overlay.js", "dist/src/overlay.css"],
  );
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
    "src/vendor/browser-bridge-core/risk.js",
    "src/vendor/browser-bridge-driver/controller.js",
    "src/vendor/browser-bridge-driver/chrome-tabs-port.js",
    "src/vendor/browser-bridge-driver/driver.js",
    "src/overlay.js",
    "src/overlay.css",
  ]) {
    assert.ok(fs.existsSync(path.join(distRoot, file)), file);
  }
  const risk = fs.readFileSync(path.join(distRoot, "src/vendor/browser-bridge-core/risk.js"), "utf8");
  assert.doesNotMatch(risk, /import type|export type|\.ts["']/);
  assert.match(risk, /export function evaluateBrowserFloor/);
  const driver = fs.readFileSync(path.join(distRoot, "src/vendor/browser-bridge-driver/driver.js"), "utf8");
  assert.match(driver, /"dist\/src\/overlay\.css"/);
  assert.match(driver, /"dist\/src\/overlay\.js"/);
  const panel = fs.readFileSync(path.join(distRoot, "panel.html"), "utf8");
  assert.match(panel, /id="status-text"/);
  assert.doesNotMatch(panel, /approval|id="host"|id="start"|id="observe"|id="screenshot"/i);
  const serviceWorker = fs.readFileSync(path.join(distRoot, "src/service-worker.js"), "utf8");
  assert.doesNotMatch(serviceWorker, /void maybeConnectHost|function maybeConnectHost/);
  assert.doesNotMatch(serviceWorker, /BB_PANEL_HOST_CONNECT|BB_PANEL_START|BB_PANEL_COMMAND|BB_PANEL_STOP_ALL|BB_PANEL_APPROVAL|ApprovalSink|PanelApproval|approvalSink/);
  assert.match(serviceWorker, /void syncHost\(\)/);
  assert.match(serviceWorker, /runtime\.renewLeases\(\)/);
  const localTransport = fs.readFileSync(path.join(distRoot, "src/local-transport.js"), "utf8");
  assert.doesNotMatch(localTransport, /enqueueCommand|postEscalation|no_live_session|command_timeout|sessions = new Map/);
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
