import { evaluateBrowserFloor } from "./vendor/newton-browser-core/risk.js";
import { createBridgeRuntime } from "./vendor/newton-browser-driver/controller.js";
import { createNewtonBrowserDriver } from "./vendor/newton-browser-driver/driver.js";
import { createChromeTabsPort } from "./vendor/newton-browser-driver/chrome-tabs-port.js";
import { createLocalPanelTransport } from "./local-transport.js";
import { OWNER_LABEL } from "./config.js";
import { createToolbarIconController } from "./toolbar-icon.js";
import { openOnFirstInstall } from "./onboarding-lifecycle.js";
import { summarizePanelSessions } from "./panel-session-summary.js";

const transport = createLocalPanelTransport({
  notify: notifyPanels,
  onHostSessionsChanged,
  getClientIdentity,
  getPairingSecret: async () => {
    const stored = await chrome.storage.local.get("pairingSecret");
    return typeof stored?.pairingSecret === "string" ? stored.pairingSecret : null;
  },
});
const toolbarIcon = createToolbarIconController({
  action: chrome.action,
  getConnected: () => transport.isHostConnected(),
});
let clientIdentityPromise;
let bindingRecordsPromise;
let orphanCleanupTimer;
const BRIDGE_ALARM = "newton-browser-sync";
const SESSION_BINDINGS_KEY = "newtonBrowserOwnedBindings";
const ORPHAN_CLEANUP_DELAY_MS = 15_000;
const runtime = createBridgeRuntime({
  transport,
  evaluateFloor: evaluateFloorLocally,
  tabs: createChromeTabsPort(chrome),
  driverFactory: () => createNewtonBrowserDriver({ ownerLabel: OWNER_LABEL }),
  notify: notifyPanels,
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  void handleMessage(message)
    .then((response) => sendResponse({ ok: true, ...response }))
    .catch((error) => sendResponse({ ok: false, error: errorCode(error) }));
  return true;
});

chrome.runtime.onInstalled?.addListener?.((details) => {
  ensureBridgeAlarm();
  void syncHost();
  openOnFirstInstall(details, () => chrome.tabs.create({ url: chrome.runtime.getURL("onboarding.html") }));
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
    case "NB_PANEL_STATUS":
      await syncHost();
      return panelStatus();
    case "NB_PANEL_STOP_ALL": {
      const result = await runtime.stopAll();
      return { ...await panelStatus(), stopped: result.stopped };
    }
    case "NB_PAIRING_SAVE": {
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
  const bindings = [...(await getBindingRecords()).values()];
  await runtime.renewLeases();
  await runtime.ensureForActiveSessions(activeTab?.id, bindings);
  scheduleOrphanCleanup();
}

async function syncHost() {
  const host = await transport.connectHost();
  toolbarIcon.schedule();
  if (host.connected) {
    await ensureForHostSessions().catch(() => {});
  }
  scheduleOrphanCleanup();
  await notifyPanels({ type: "state", state: runtime.snapshot() });
  return host.connected;
}

function onHostSessionsChanged() {
  toolbarIcon.schedule();
  void ensureForHostSessions().catch(() => {});
}

async function panelStatus(state = runtime.snapshot()) {
  const sessions = await transport.listSessions().catch(() => []);
  return {
    state,
    hostConnected: transport.isHostConnected(),
    hostCount: transport.connectedHostCount(),
    pairingRequired: transport.pairingRequired(),
    sessions: summarizePanelSessions(sessions),
  };
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
  if (event?.type === "finalized") {
    await forgetBinding(event.sessionId);
    return;
  }
  if (event?.type === "state") {
    await rememberOwnedBindings(event.state);
    const panel = await panelStatus(event.state);
    await chrome.runtime.sendMessage({
      type: "NB_STATE",
      ...panel,
    }).catch(() => {});
    return;
  }
}

function getBindingRecords() {
  if (!bindingRecordsPromise) bindingRecordsPromise = loadBindingRecords();
  return bindingRecordsPromise;
}

async function loadBindingRecords() {
  const stored = await chrome.storage.local.get(SESSION_BINDINGS_KEY).catch(() => ({})) ?? {};
  const values = Array.isArray(stored?.[SESSION_BINDINGS_KEY]) ? stored[SESSION_BINDINGS_KEY] : [];
  return new Map(values.flatMap((binding) =>
    binding?.sessionId && Number.isInteger(binding?.tabId) ? [[binding.sessionId, binding]] : [],
  ));
}

async function rememberOwnedBindings(state) {
  const records = await getBindingRecords();
  for (const session of state?.sessions ?? []) {
    if (!session?.ownsTab || !session.sessionId || !Number.isInteger(session.tabId)) continue;
    records.set(session.sessionId, {
      sessionId: session.sessionId,
      tabId: session.tabId,
      tabGroupId: Number.isInteger(session.tabGroupId) ? session.tabGroupId : null,
      origin: typeof session.origin === "string" ? session.origin : null,
    });
  }
  await persistBindingRecords(records);
  scheduleOrphanCleanup();
}

async function forgetBinding(sessionId) {
  const records = await getBindingRecords();
  records.delete(String(sessionId ?? ""));
  await persistBindingRecords(records);
}

function scheduleOrphanCleanup() {
  if (orphanCleanupTimer) clearTimeout(orphanCleanupTimer);
  orphanCleanupTimer = setTimeout(() => { void cleanupOrphanBindings(); }, ORPHAN_CLEANUP_DELAY_MS);
}

async function cleanupOrphanBindings() {
  orphanCleanupTimer = null;
  const records = await getBindingRecords();
  if (records.size === 0) return;
  const live = await transport.listSessions().catch(() => []);
  const liveIds = new Set((Array.isArray(live) ? live : []).map((session) => session?.sessionId).filter(Boolean));
  const activeIds = new Set((runtime.snapshot().sessions ?? []).map((session) => session.sessionId));
  for (const [sessionId, binding] of [...records]) {
    if (liveIds.has(sessionId) || activeIds.has(sessionId)) continue;
    await chrome.tabs.remove(binding.tabId).catch(() => {});
    records.delete(sessionId);
  }
  await persistBindingRecords(records);
}

async function persistBindingRecords(records) {
  await chrome.storage.local.set({ [SESSION_BINDINGS_KEY]: [...records.values()] }).catch(() => {});
}

function errorCode(error) {
  const message = String(error?.message ?? error ?? "request_failed");
  return message.slice(0, 80).replace(/[^a-z0-9_]+/gi, "_").toLowerCase() || "request_failed";
}

function ensureBridgeAlarm() {
  chrome.alarms?.create?.(BRIDGE_ALARM, { periodInMinutes: 0.5 });
}

function getClientIdentity() {
  if (!clientIdentityPromise) clientIdentityPromise = loadClientIdentity();
  return clientIdentityPromise;
}

async function loadClientIdentity() {
  const stored = await chrome.storage.local.get("bridgeClientId");
  let clientId = typeof stored?.bridgeClientId === "string" && /^[A-Za-z0-9_-]{8,128}$/.test(stored.bridgeClientId)
    ? stored.bridgeClientId
    : null;
  if (!clientId) {
    clientId = `bb_${crypto.randomUUID().replaceAll("-", "")}`;
    await chrome.storage.local.set({ bridgeClientId: clientId });
  }
  const userAgent = String(globalThis.navigator?.userAgent ?? "");
  const browserFamily = /Edg\//i.test(userAgent) ? "edge" : /Chrome\//i.test(userAgent) ? "chrome" : "chromium";
  return { clientId, browserFamily };
}

async function findActiveWebTab() {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
  return tabs.find((tab) => typeof tab?.id === "number" && /^https?:\/\//i.test(String(tab.url ?? ""))) ?? null;
}
