import http from "node:http";

import { createBrowserBridgeHost } from "../../apps/mcp-server/src/bridge.ts";
import { handleMcpMessage } from "../../apps/mcp-server/src/mcp-server.ts";
import { startFixtureServers } from "../../test/fixtures/server.mjs";

const fixturePort = 18271;
const controlPort = 18273;
const hostPort = 17321;
const gates = new Map();
let fixture;
let control;
let bridge;
let sessionId = "";

try {
  fixture = await startFixtureServers({ port: fixturePort, crossOriginPort: fixturePort + 1 });
  bridge = createBrowserBridgeHost();
  await bridge.listen(hostPort, "127.0.0.1");
  control = await startControlServer();
  await waitFor(() => bridge.getStatus().extensionConnected, "extension connection", 45_000);
  log("current_tab_servers_ready", { fixture: fixture.origin, control: `http://127.0.0.1:${controlPort}`, extensionConnected: true });

  await gate("bind");
  const started = await mcp("browser.session.start", {
    origin: fixture.origin,
    allowedOrigins: [fixture.origin],
    tabMode: "current",
    goal: "explicit current-tab and focus-escape QA",
    instanceLabel: "current-tab-live-qa",
  });
  assert(started.ok !== false && started.session?.tabMode === "current", "current-tab session did not bind", started);
  sessionId = started.sessionId;
  log("current_tab_bound", { sessionId, tabId: started.session.ownedTabId, liveOrigin: started.session.liveOrigin });

  await gate("focus-switched");
  const observed = resultOf(await mcp("browser.observe", { sessionId, maxNodes: 120 }));
  assert(observed.origin === fixture.origin, "current session followed focused tab outside its grant", observed);
  assert((observed.nodes ?? []).some((node) => String(node.name ?? "").trim() === "Increment"), "bound current tab observation missing fixture target", observed);
  log("focus_escape_ok", { observedOrigin: observed.origin, nodeCount: observed.nodeCount });

  const stopped = await mcp("browser.session.stop", { sessionId });
  assert(stopped.stopped === true, "current session stop failed", stopped);
  const listed = await mcp("browser.tabs.list", {});
  assert(Array.isArray(listed.sessions) && listed.sessions.length === 0, "current session remained registered", listed);
  sessionId = "";
  log("current_tab_live_qa_pass", { currentTabKept: true, focusEscapeDenied: true, sessions: 0 });
} catch (error) {
  log("current_tab_live_qa_fail", { message: error.message, detail: error.detail });
  process.exitCode = 1;
} finally {
  try { if (sessionId) bridge?.stopSession(sessionId); } catch {}
  try { await new Promise((resolve) => control?.close(() => resolve()) ?? resolve()); } catch {}
  try { bridge?.stopAll(); await bridge?.close(); } catch {}
  try { await fixture?.close(); } catch {}
}

function startControlServer() {
  const server = http.createServer((request, response) => {
    if (request.method === "GET" && request.url === "/status") {
      return response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify({
        extensionConnected: bridge?.getStatus().extensionConnected === true,
        sessions: bridge?.listSessions() ?? [],
      }));
    }
    if (request.method !== "POST") return response.writeHead(404).end();
    const name = String(request.url ?? "").replace(/^\//, "");
    const waiter = gates.get(name);
    if (!waiter) return response.writeHead(409).end();
    gates.delete(name);
    waiter.resolve();
    response.writeHead(204).end();
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(controlPort, "127.0.0.1", () => resolve(server));
  });
}

function gate(name, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { gates.delete(name); reject(new Error(`timed out waiting for ${name}`)); }, timeoutMs);
    gates.set(name, { resolve: () => { clearTimeout(timer); resolve(); } });
  });
}

async function waitFor(predicate, label, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function mcp(name, args = {}) {
  const response = await handleMcpMessage(bridge, {
    jsonrpc: "2.0",
    id: Math.floor(Math.random() * 1e9),
    method: "tools/call",
    params: { name, arguments: args },
  });
  const text = response?.result?.content?.find((item) => item.type === "text")?.text;
  assert(typeof text === "string", `missing MCP result for ${name}`, response);
  return JSON.parse(text);
}

function resultOf(value) {
  assert(value?.ok !== false, "MCP tool failed", value);
  return value.result ?? value;
}

function assert(condition, message, detail = {}) {
  if (condition) return;
  const error = new Error(message);
  error.detail = detail;
  throw error;
}

function log(step, detail = {}) {
  console.log(JSON.stringify({ step, ...detail }));
}
