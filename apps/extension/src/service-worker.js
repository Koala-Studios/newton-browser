import { evaluateBrowserFloor } from "./vendor/browser-bridge-core/risk.js";
import { createBridgeRuntime } from "./vendor/browser-bridge-driver/controller.js";
import { createBrowserBridgeDriver } from "./vendor/browser-bridge-driver/driver.js";
import { createChromeTabsPort } from "./vendor/browser-bridge-driver/chrome-tabs-port.js";
import { createLocalPanelTransport } from "./local-transport.js";
import { OWNER_LABEL } from "./config.js";

const transport = createLocalPanelTransport({
  notify: notifyPanels,
  onHostSessionsChanged: () => ensureForHostSessions().catch(() => {}),
  getPairingSecret: async () => {
    const stored = await chrome.storage.local.get("pairingSecret");
    return typeof stored?.pairingSecret === "string" ? stored.pairingSecret : null;
  },
});
const BRIDGE_ALARM = "browser-bridge-sync";
const runtime = createBridgeRuntime({
  transport,
  evaluateFloor: evaluateFloorLocally,
  tabs: createChromeTabsPort(chrome),
  driverFactory: () => createBrowserBridgeDriver({ ownerLabel: OWNER_LABEL }),
  notify: notifyPanels,
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  void handleMessage(message)
    .then((response) => sendResponse({ ok: true, ...response }))
    .catch((error) => sendResponse({ ok: false, error: errorCode(error) }));
  return true;
});

chrome.runtime.onInstalled?.addListener?.(() => {
  ensureBridgeAlarm();
  void syncHost();
});

chrome.runtime.onStartup?.addListener?.(() => {
  ensureBridgeAlarm();
  void syncHost();
});

chrome.alarms?.onAlarm?.addListener?.((alarm) => {
  if (alarm.name === BRIDGE_ALARM) void syncHost();
});

ensureBridgeAlarm();
void syncHost();

async function handleMessage(message) {
  switch (message?.type) {
    case "BB_PANEL_STATUS":
      await syncHost();
      return {
        state: runtime.snapshot(),
        hostConnected: transport.isHostConnected(),
        hostCount: transport.connectedHostCount(),
        pairingRequired: transport.pairingRequired(),
      };
    case "BB_PAIRING_SAVE": {
      const secret = String(message.secret ?? "").trim();
      if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) throw new Error("invalid_pairing_secret");
      await chrome.storage.local.set({ pairingSecret: secret });
      await syncHost();
      return { hostConnected: transport.isHostConnected(), hostCount: transport.connectedHostCount() };
    }
    default:
      throw new Error("unknown_message");
  }
}

async function ensureForHostSessions() {
  const activeTab = await findActiveWebTab();
  await runtime.renewLeases();
  await runtime.ensureForActiveSessions(activeTab?.id);
}

async function syncHost() {
  const host = await transport.connectHost();
  if (host.connected) {
    await ensureForHostSessions().catch(() => {});
  }
  await notifyPanels({ type: "state", state: runtime.snapshot() });
  return host.connected;
}

function evaluateFloorLocally(input) {
  return evaluateBrowserFloor({
    action: input.action,
    origin: input.origin,
    policy: { allowedOrigins: input.allowedOrigins ?? (input.origin ? [input.origin] : []) },
    resolved: input.resolved,
    signals: input.signals,
    requestedClass: input.requestedClass,
  });
}

async function notifyPanels(event) {
  if (event?.type === "state") {
    await chrome.runtime.sendMessage({
      type: "BB_STATE",
      state: event.state,
      hostConnected: transport.isHostConnected(),
      hostCount: transport.connectedHostCount(),
      pairingRequired: transport.pairingRequired(),
    }).catch(() => {});
    return;
  }
}

function errorCode(error) {
  const message = String(error?.message ?? error ?? "request_failed");
  return message.slice(0, 80).replace(/[^a-z0-9_]+/gi, "_").toLowerCase() || "request_failed";
}

function ensureBridgeAlarm() {
  chrome.alarms?.create?.(BRIDGE_ALARM, { periodInMinutes: 0.5 });
}

async function findActiveWebTab() {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
  return tabs.find((tab) => typeof tab?.id === "number" && /^https?:\/\//i.test(String(tab.url ?? ""))) ?? null;
}
