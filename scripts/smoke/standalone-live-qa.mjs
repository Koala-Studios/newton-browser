import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createBrowserBridgeHost } from "../../apps/mcp-server/src/bridge.ts";
import { handleMcpMessage } from "../../apps/mcp-server/src/mcp-server.ts";

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
  for (const name of ["Increment", "Local write", "Submit order", "Name", "Plan", "Password", "Credit card number", "Creative assets"]) {
    assert(hasName(observed, name), `observe missing ${name}`, observed);
  }
  log("observe_ok", { nodeCount: observed.nodeCount, kind: observed.kind });

  okResult(await mcp("browser.act", { sessionId, action: { kind: "fill", label: "Name", value: "Alice" } }), "fill by label");
  log("fill_label_ok");

  okResult(await mcp("browser.act", { sessionId, action: { kind: "type", selector: "#notes", value: "typed notes" } }), "type by selector");
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

  okResult(await mcp("browser.act", { sessionId, action: { kind: "navigate", url: page("/second") } }), "navigate");
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

  const localWrite = await mcp("browser.act", { sessionId, action: { kind: "click", name: "Local write" } });
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
    if (fixtureServer) await new Promise((resolve) => fixtureServer.close(resolve));
  } catch {}
  try {
    if (uploadRoot) fs.rmSync(uploadRoot, { recursive: true, force: true });
  } catch {}
}

function startFixture() {
  fixtureServer = http.createServer((req, res) => {
    if (req.url === "/write") {
      res.writeHead(204, { "Access-Control-Allow-Origin": "*" }).end();
      return;
    }
    if (req.url === "/second") {
      res.writeHead(200, { "content-type": "text/html" }).end(html(`
        <h1>Second page</h1>
        <a href="/">Home</a>
        <p id="second-marker">Second marker</p>
      `, "Second"));
      return;
    }
    res.writeHead(200, { "content-type": "text/html" }).end(html(`
      <h1>Browser Bridge QA Fixture</h1>
      <p class="status">Ready marker</p>
      <label>Name <input id="name" aria-label="Name"></label>
      <label>Notes <textarea id="notes" placeholder="Notes"></textarea></label>
      <label>Plan <select id="plan" aria-label="Plan"><option value="basic">Basic</option><option value="pro">Pro</option></select></label>
      <p>Count: <span id="count">0</span></p>
      <button id="increment">Increment</button>
      <button id="local-write">Local write</button><span id="write-status"></span>
      <form id="commit-form" action="/submitted" method="post"><button id="submit" type="submit">Submit order</button></form>
      <label>Password <input id="password" type="password" aria-label="Password"></label>
      <label>Credit card number <input id="card" aria-label="Credit card number"></label>
      <form id="upload-form"><label>Creative assets <input id="assets" type="file" aria-label="Creative assets" multiple accept="image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm"></label><output id="accepted-files">none</output></form>
      <div class="spacer"></div><button id="bottom">Bottom target</button>
    `));
  });
  return new Promise((resolve) => fixtureServer.listen(fixturePort, "127.0.0.1", resolve));
}

function html(body, title = "Browser Bridge QA") {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>
    body{font-family:Arial,sans-serif;margin:24px;line-height:1.4;min-height:1800px}
    label{display:block;margin:12px 0}
    button,a,select,input,textarea{font:inherit;margin:4px;padding:6px}
    .spacer{height:900px}
    .status{padding:8px;background:#eef;border:1px solid #99c}
  </style></head><body>${body}<script>
    document.addEventListener('click', async (event) => {
      if (event.target && event.target.id === 'increment') {
        document.getElementById('count').textContent = String(Number(document.getElementById('count').textContent || '0') + 1);
      }
      if (event.target && event.target.id === 'local-write') {
        await fetch('/write', { method: 'POST', body: 'write=1' });
        document.getElementById('write-status').textContent = 'write attempted';
      }
    });
    document.getElementById('assets').addEventListener('change', (event) => {
      document.getElementById('accepted-files').textContent = Array.from(event.target.files).map((file) => file.name).join('|');
    });
  </script></body></html>`;
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
