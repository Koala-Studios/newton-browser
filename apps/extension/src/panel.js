import { createPanelViewModel } from "./panel-session-summary.js";

const elements = {
  status: document.getElementById("status"),
  statusText: document.getElementById("status-text"),
  pairing: document.getElementById("pairing"),
  pairingSecret: document.getElementById("pairing-secret"),
  pairingMessage: document.getElementById("pairing-message"),
  sessions: document.getElementById("sessions"),
  sessionList: document.getElementById("session-list"),
  stopAll: document.getElementById("stop-all"),
  version: document.getElementById("version"),
  versionSkew: document.getElementById("version-skew"),
};

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "NB_STATE") {
    applyPanel(message);
  }
});

void refresh();

async function refresh() {
  const response = await send({ type: "NB_PANEL_STATUS" });
  applyPanel(response);
}

elements.pairing.addEventListener("submit", (event) => {
  event.preventDefault();
  void savePairing();
});

elements.stopAll.addEventListener("click", () => { void stopAll(); });

async function savePairing() {
  const secret = elements.pairingSecret.value.trim();
  elements.pairingMessage.textContent = "Pairing…";
  const response = await send({ type: "NB_PAIRING_SAVE", secret });
  if (!response.ok || !response.hostConnected) {
    elements.pairingMessage.textContent = response.error === "invalid_pairing_secret"
      ? "That pairing secret is not valid."
      : "Pairing saved. Start or restart the MCP client, then check again.";
    return;
  }
  elements.pairingSecret.value = "";
  applyPanel({ ...response, hostConnected: true, pairingRequired: false });
}

async function stopAll() {
  elements.stopAll.disabled = true;
  const response = await send({ type: "NB_PANEL_STOP_ALL" });
  elements.stopAll.disabled = false;
  applyPanel(response);
}

function applyPanel(response) {
  const connected = Boolean(response.ok !== false && response.hostConnected);
  applyStatus(connected, Number(response.hostCount ?? 0), Boolean(response.pairingRequired));
  const model = createPanelViewModel({
    sessions: response.sessions,
    extensionVersion: chrome.runtime.getManifest().version,
    hostVersion: response.hostVersion,
  });
  elements.sessions.hidden = !model.showSessions;
  elements.stopAll.hidden = !model.showStopAll;
  elements.sessionList.replaceChildren(...model.rows.map(sessionRow));
  elements.version.textContent = model.version;
  elements.versionSkew.hidden = !model.versionSkew;
}

function sessionRow(session) {
  const row = document.createElement("li");
  const origin = document.createElement("span");
  const mode = document.createElement("span");
  origin.textContent = session.origin;
  mode.className = "session-mode";
  mode.textContent = session.mode;
  row.append(origin, mode);
  if (session.label) {
    const label = document.createElement("span");
    label.className = "session-label";
    label.textContent = session.label;
    row.append(label);
  }
  return row;
}

function applyStatus(connected, hostCount, pairingRequired) {
  elements.status.dataset.connected = connected ? "true" : "false";
  elements.statusText.textContent = connected ? `Connected (${hostCount})` : pairingRequired ? "Pairing required" : "Disconnected";
  elements.pairing.hidden = connected || !pairingRequired;
}

function send(message) {
  return chrome.runtime.sendMessage(message).catch((error) => ({
    ok: false,
    error: error?.message ?? String(error),
  }));
}
