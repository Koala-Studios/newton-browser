const elements = {
  status: document.getElementById("status"),
  statusText: document.getElementById("status-text"),
  pairing: document.getElementById("pairing"),
  pairingSecret: document.getElementById("pairing-secret"),
  pairingMessage: document.getElementById("pairing-message"),
};

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "NB_STATE") {
    applyStatus(Boolean(message.hostConnected), Number(message.hostCount ?? 0), Boolean(message.pairingRequired));
  }
});

void refresh();

async function refresh() {
  const response = await send({ type: "NB_PANEL_STATUS" });
  applyStatus(Boolean(response.ok && response.hostConnected), Number(response.hostCount ?? 0), Boolean(response.pairingRequired));
}

elements.pairing.addEventListener("submit", (event) => {
  event.preventDefault();
  void savePairing();
});

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
  applyStatus(true, Number(response.hostCount ?? 1), false);
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
