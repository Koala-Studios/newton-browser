import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createBrowserBridgeHost } from "../../apps/mcp-server/src/bridge.ts";
import { handleMcpMessage } from "../../apps/mcp-server/src/mcp-server.ts";
import { startFixtureServers } from "../../test/fixtures/server.mjs";

const fixturePort = Number(process.env.BROWSER_BRIDGE_QA_FIXTURE_PORT ?? 18231);
const hostPort = Number(process.env.BROWSER_BRIDGE_PORT ?? 17321);
const results = [];

let fixtureServer;
let bridge;
let sessionId = "";
let uploadRoot = "";

try {
  await startFixture();
  uploadRoot = materializeUploadFixtures();
  bridge = createBrowserBridgeHost();
  await bridge.listen(hostPort, "127.0.0.1");
  log("servers_started", { fixture: page(), hostPort });

  const started = await mcp("browser.session.start", {
    origin: page("/"),
    allowedOrigins: [`http://127.0.0.1:${fixturePort}`],
    tabMode: "owned_group",
    goal: "standalone holistic QA",
    instanceLabel: "standalone-live-qa",
  });
  sessionId = started.sessionId;
  assert(/^bbs_local_/.test(sessionId), "session did not start", started);
  log("session_started", { sessionId });

  const boundSession = await waitFor(async () => {
    const listed = await mcp("browser.tabs.list", {});
    const session = listed.sessions?.find((item) => item.sessionId === sessionId);
    return session?.ownedTabId ? session : null;
  }, "extension auto-bind");
  log("extension_auto_bound", { ownedTabId: boundSession.ownedTabId, tabGroupId: boundSession.tabGroupId ?? null });

  const observed = okResult(await mcp("browser.observe", { sessionId, maxNodes: 120 }), "observe");
  assert(observed.origin === `http://127.0.0.1:${fixturePort}`, "observe origin mismatch", observed);
  for (const name of ["Increment", "Network write", "Publish fixture", "Name", "Plan", "Password", "Credit card number", "Creative assets", "Shadow button", "Same-origin frame button", "Editable notes", "Custom region"]) {
    assert(hasName(observed, name), `observe missing ${name}`, observed);
  }
  assert(!hasName(observed, "Cross-origin denied target"), "cross-origin frame target escaped the observation grant", observed);
  log("observe_ok", { nodeCount: observed.nodeCount, kind: observed.kind });

  okResult(await mcp("browser.act", { sessionId, action: { kind: "fill", label: "Name", value: "Alice" } }), "fill by label");
  log("fill_label_ok");

  okResult(await mcp("browser.act", { sessionId, action: { kind: "type", selector: "#notes", value: "typed notes" } }), "type by selector");
  okResult(await mcp("browser.act", { sessionId, action: { kind: "fill", label: "Editable notes", value: "editable notes" } }), "contenteditable fill");
  okResult(await mcp("browser.act", { sessionId, action: { kind: "click", name: "Custom region" } }), "custom combobox");
  okResult(await mcp("browser.act", { sessionId, action: { kind: "click", name: "Shadow button" } }), "shadow button");
  okResult(await mcp("browser.act", { sessionId, action: { kind: "click", name: "Same-origin frame button" } }), "same-origin frame button");
  log("type_selector_ok");

  const selected = await mcp("browser.act", { sessionId, action: { kind: "select", label: "Plan", value: "pro" } });
  assert(["verified", "dispatched_unverified"].includes(statusOf(selected)), "select failed", selected);
  log("select_label_ok", { status: statusOf(selected) });

  const clicked = await mcp("browser.act", {
    sessionId,
    action: { kind: "click", name: "Increment", waitFor: { text: "Count: 1" }, timeoutMs: 3000 },
  });
  assert(statusOf(clicked) === "verified", "click by name failed", clicked);
  log("click_name_ok");

  okResult(await mcp("browser.act", { sessionId, action: { kind: "hover", name: "Increment" } }), "hover");
  log("hover_ok");

  okResult(await mcp("browser.act", { sessionId, action: { kind: "scroll", value: 900 } }), "scroll");
  log("scroll_ok");

  const shot = okResult(await mcp("browser.screenshot", {
    sessionId,
    fullPage: true,
    device: "mobile",
    waitMs: 100,
    inline: false,
  }), "screenshot");
  assert(shot.kind === "screenshot" && Number(shot.width) > 0 && Number(shot.height) > 0, "screenshot missing metadata", shot);
  log("screenshot_mobile_ok", { width: shot.width, height: shot.height, fullPage: shot.fullPage, device: shot.device });

  const staleObservation = okResult(await mcp("browser.observe", { sessionId, maxNodes: 160 }), "stale observe");
  const staleRef = (staleObservation.nodes ?? []).find((node) => node.name === "Stale target")?.ref;
  assert(staleRef, "stale target ref missing", staleObservation);
  okResult(await mcp("browser.act", { sessionId, action: { kind: "click", name: "Rerender counter" } }), "SPA rerender");
  const stale = await mcp("browser.act", { sessionId, action: { kind: "click", target: { ref: staleRef } } });
  assert(["not_found", "stale_target"].includes(statusOf(stale)), "stale ref was not rejected", stale);
  log("spa_stale_ref_ok", { status: statusOf(stale) });

  okResult(await mcp("browser.act", { sessionId, action: { kind: "navigate", url: page("/second.html") } }), "navigate");
  okResult(await mcp("browser.act", { sessionId, action: { kind: "back" } }), "back");
  okResult(await mcp("browser.act", { sessionId, action: { kind: "forward" } }), "forward");
  okResult(await mcp("browser.act", { sessionId, action: { kind: "reload" } }), "reload");
  log("navigation_history_ok");

  okResult(await mcp("browser.act", { sessionId, action: { kind: "navigate", url: page("/") } }), "navigate home");
  const password = await mcp("browser.act", { sessionId, action: { kind: "fill", label: "Password", value: "not-a-real-secret" } });
  assert(password.ok === false && password.errorCode === "blocked_by_floor", "password fill was not blocked", password);
  log("password_blocked_ok");

  const card = await mcp("browser.act", { sessionId, action: { kind: "fill", label: "Credit card number", value: "4111111111111111" } });
  assert(card.ok === false && card.errorCode === "blocked_by_floor", "card fill was not blocked", card);
  log("card_blocked_ok");

  const localWrite = await mcp("browser.act", { sessionId, action: { kind: "click", name: "Network write" } });
  assert(statusOf(localWrite) === "blocked", "post-action reconciliation did not block local write", localWrite);
  log("post_action_reconciliation_ok");

  const uploadObservation = okResult(await mcp("browser.observe", { sessionId, maxNodes: 160 }), "upload observe");
  const uploadNode = (uploadObservation.nodes ?? []).find((node) => node.name === "Creative assets");
  assert(uploadNode?.ref, "file input ref missing", uploadObservation);
  const uploadFiles = fs.readdirSync(uploadRoot).map((name) => path.join(uploadRoot, name));
  const uploaded = await mcp("browser.act", { sessionId, action: { kind: "set_files", target: { ref: uploadNode.ref }, files: uploadFiles } });
  assert(statusOf(uploaded) === "verified", "set_files was not verified", uploaded);
  const accepted = uploaded.result?.changed?.files ?? uploaded.changed?.files ?? [];
  assert(accepted.length === uploadFiles.length, "browser FileList acceptance mismatch", uploaded);
  assert(accepted.every((file) => !String(file.filename).includes("\\") && !String(file.filename).includes("/")), "set_files exposed a local path", accepted);
  log("real_file_inputs_ok", { files: accepted.map((file) => file.filename), autoSubmit: false });

  const stopped = await mcp("browser.stop_all", {});
  assert(stopped.stopped, "stop_all failed", stopped);
  await waitFor(async () => {
    const listed = await mcp("browser.tabs.list", {});
    return Array.isArray(listed.sessions) && listed.sessions.length === 0 ? listed : null;
  }, "empty host session list", 10000);
  log("cleanup_ok", { stopped: stopped.stopped });
  log("live_qa_pass", { steps: results.length });
} catch (error) {
  log("live_qa_fail", { message: error.message, detail: error.detail });
  process.exitCode = 1;
} finally {
  try {
    if (bridge) {
      bridge.stopAll();
      await new Promise((resolve) => setTimeout(resolve, 500));
      await bridge.close();
    }
  } catch {}
  try {
    if (fixtureServer) await fixtureServer.close();
  } catch {}
  try {
    if (uploadRoot) fs.rmSync(uploadRoot, { recursive: true, force: true });
  } catch {}
}

async function startFixture() {
  fixtureServer = await startFixtureServers({ port: fixturePort, crossOriginPort: fixturePort + 1 });
}

async function mcp(name, args = {}) {
  const response = await handleMcpMessage(bridge, {
    jsonrpc: "2.0",
    id: Math.floor(Math.random() * 1e9),
    method: "tools/call",
    params: { name, arguments: args },
  });
  const text = response?.result?.content?.[0]?.text;
  assert(typeof text === "string", `missing MCP text for ${name}`, { response });
  return JSON.parse(text);
}

async function waitFor(predicate, label, timeoutMs = 90000) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    last = await predicate();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`timed out waiting for ${label}: ${JSON.stringify(last)}`);
}

function okResult(result, label) {
  assert(result && result.ok !== false, `${label} failed`, result);
  return result.result ?? result;
}

function statusOf(result) {
  return result?.result?.actionStatus ?? result?.result?.status ?? result?.actionStatus ?? result?.status;
}

function hasName(observation, expected) {
  const nodes = observation.nodes ?? observation.added ?? [];
  return nodes.some((node) => String(node.name ?? "").trim() === expected);
}

function page(path = "/") {
  return `http://127.0.0.1:${fixturePort}${path}`;
}

function log(step, detail = {}) {
  const entry = { step, ...detail };
  results.push(entry);
  console.log(JSON.stringify(entry));
}

function materializeUploadFixtures() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "browser-bridge-live-files-"));
  const fixtures = {
    "asset.png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    "asset.jpg": Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    "asset.webp": Buffer.from("RIFF0000WEBP", "ascii"),
    "asset.gif": Buffer.from("GIF89a", "ascii"),
    "asset.mp4": Buffer.from([0, 0, 0, 16, ...Buffer.from("ftyp", "ascii")]),
    "asset.webm": Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
  };
  for (const [name, bytes] of Object.entries(fixtures)) fs.writeFileSync(path.join(root, name), bytes);
  return root;
}

function assert(condition, message, detail = {}) {
  if (condition) return;
  const error = new Error(message);
  error.detail = detail;
  throw error;
}
