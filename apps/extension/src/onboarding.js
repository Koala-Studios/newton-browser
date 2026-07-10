const configurations = [
  {
    label: "Codex",
    value: `[mcp_servers.newton-browser]\ncommand = "npx"\nargs = ["-y", "newton-browser"]`,
  },
  {
    label: "Claude Code",
    value: "claude mcp add newton-browser -- npx -y newton-browser",
  },
  {
    label: "Claude Desktop",
    value: `{\n  "mcpServers": {\n    "newton-browser": {\n      "command": "npx",\n      "args": ["-y", "newton-browser"]\n    }\n  }\n}`,
  },
  {
    label: "Generic MCP client",
    value: `{\n  "command": "npx",\n  "args": ["-y", "newton-browser"]\n}`,
  },
];

const status = document.getElementById("connection-status");
const configurationRoot = document.getElementById("configurations");

for (const configuration of configurations) {
  const card = document.createElement("article");
  const heading = document.createElement("h3");
  const code = document.createElement("pre");
  const copy = document.createElement("button");
  heading.textContent = configuration.label;
  code.textContent = configuration.value;
  copy.type = "button";
  copy.textContent = "Copy";
  copy.addEventListener("click", () => { void copyConfiguration(copy, configuration.value); });
  card.append(heading, copy, code);
  configurationRoot.append(card);
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "NB_STATE") applyStatus(Boolean(message.hostConnected), Number(message.hostCount ?? 0));
});

void refreshStatus();
setInterval(() => { void refreshStatus(); }, 2_000);

async function refreshStatus() {
  const response = await chrome.runtime.sendMessage({ type: "NB_PANEL_STATUS" }).catch(() => ({ ok: false }));
  applyStatus(Boolean(response?.ok && response.hostConnected), Number(response?.hostCount ?? 0));
}

function applyStatus(connected, hostCount) {
  status.dataset.connected = connected ? "true" : "false";
  status.textContent = connected ? `Connected${hostCount > 1 ? ` (${hostCount} hosts)` : ""}` : "Waiting for an MCP client…";
}

async function copyConfiguration(button, value) {
  try {
    await navigator.clipboard.writeText(value);
    button.textContent = "Copied";
  } catch {
    button.textContent = "Copy failed";
  }
  setTimeout(() => { button.textContent = "Copy"; }, 1_500);
}
