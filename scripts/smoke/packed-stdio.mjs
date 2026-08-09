import { createHmac, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const entry = requiredArg("--entry");
const configDirectory = path.resolve(requiredArg("--config-dir"));
const port = Number(arg("--port") ?? 18621);
const TINY_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=";
const LARGE_PNG = Buffer.concat([Buffer.from(TINY_PNG, "base64"), Buffer.alloc(160 * 1024)]).toString("base64");
const requireFromPackage = createRequire(pathToFileURL(entry));
const { WebSocket } = requireFromPackage("ws");
fs.mkdirSync(configDirectory, { recursive: true });

const child = spawn(process.execPath, [entry], {
  cwd: path.dirname(entry),
  env: {
    ...process.env,
    NEWTON_BROWSER_PORT: String(port),
    NEWTON_BROWSER_CONFIG_DIR: configDirectory,
    NEWTON_BROWSER_READINESS_TIMEOUT_MS: "150",
  },
  stdio: ["pipe", "pipe", "pipe"],
});
const responses = new Map();
const waiters = new Map();
let stdoutBuffer = "";
let stderr = "";
let requestId = 0;

child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  stdoutBuffer += chunk;
  let newline = stdoutBuffer.indexOf("\n");
  while (newline >= 0) {
    const line = stdoutBuffer.slice(0, newline).trim();
    stdoutBuffer = stdoutBuffer.slice(newline + 1);
    if (line) {
      const message = JSON.parse(line);
      responses.set(String(message.id), message);
      waiters.get(String(message.id))?.();
    }
    newline = stdoutBuffer.indexOf("\n");
  }
});
child.stderr.on("data", (chunk) => { stderr += chunk; });

try {
  await waitForHealth();
  for (const protocolVersion of ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"]) {
    const initialized = await request("initialize", { protocolVersion });
    assert(initialized.result?.protocolVersion === protocolVersion, `initialize ${protocolVersion}`);
    assert(initialized.result?.contractVersion === "1.0", "initialize contract version");
    assert(initialized.result?.instructions?.includes("untrusted data"), "initialize trust instructions");
  }
  const listed = await request("tools/list");
  const toolNames = listed.result.tools.map((tool) => tool.name);
  for (const name of ["browser.status", "browser.session.start", "browser.observe", "browser.act", "browser.screenshot", "browser.console", "browser.network", "browser.tabs.list", "browser.tabs.finalize", "browser.session.stop", "browser.stop_all"]) {
    assert(toolNames.includes(name), `tools/list missing ${name}`);
  }
  assert(listed.result.tools.every((entry) => entry.annotations && typeof entry.annotations.readOnlyHint === "boolean"), "packed tool annotations");
  const actSchema = listed.result.tools.find((entry) => entry.name === "browser.act")?.inputSchema?.properties?.action;
  assert(actSchema?.additionalProperties === false && Object.keys(actSchema["x-newtonVariants"] ?? {}).length > 20, "packed strict action contract");

  const missing = await tool("browser.session.start", { origin: "https://example.com" });
  assert(missing.isError && missing.json.errorCode === "extension_disconnected", "missing extension typed error");

  let extension = await connectFakeExtension();
  const status = await tool("browser.status", { detail: "full" });
  assert(!status.isError && status.json.ready === true, "browser.status ready");
  assert(status.json.authMode === "local_trust" && status.json.zeroTouch === true && status.json.paired === false, "browser.status zero-touch contract");

  const [first, peer] = await Promise.all([startSession(), startSession()]);
  const [observation, peerObservation] = await Promise.all([
    tool("browser.observe", { sessionId: first }),
    tool("browser.observe", { sessionId: peer, format: "json" }),
  ]);
  assert(typeof observation.json.output === "string" && observation.json.provenance?.trust === "untrusted_page_content", "compact observe result and provenance");
  assert(peerObservation.json.result.kind === "observation", "peer observe result");
  assert(!observation.json.output.includes(peerObservation.json.result.nodes[0].ref), "logical workers received distinct refs");

  const [screenshot, peerScreenshot] = await Promise.all([
    rawTool("browser.screenshot", { sessionId: first, delivery: "image", fullPage: true }),
    rawTool("browser.screenshot", { sessionId: peer, delivery: "image" }),
  ]);
  const screenshotImage = screenshot.result.content.find((item) => item.type === "image" && item.mimeType === "image/png");
  const peerScreenshotImage = peerScreenshot.result.content.find((item) => item.type === "image" && item.mimeType === "image/png");
  assert(screenshotImage && Buffer.from(screenshotImage.data, "base64").length > 128 * 1024, "large MCP image block");
  assert(peerScreenshotImage && Buffer.from(peerScreenshotImage.data, "base64").length > 0, "peer MCP image block");
  const screenshotDirectory = path.join(configDirectory, "screenshots");
  const fileShot = await tool("browser.screenshot", { sessionId: first, delivery: "file", outputDirectory: screenshotDirectory });
  assert(fs.existsSync(fileShot.json.path), "file screenshot exists");

  const invalidAction = await tool("browser.act", { sessionId: first, action: { kind: "scroll", value: 20 } });
  assert(invalidAction.isError && invalidAction.json.errorCode === "invalid_arguments", "strict packed action rejection");
  const acted = await tool("browser.act", { sessionId: first, action: { kind: "scroll", y: 20 } });
  assert(acted.json.decision?.code === "agentic" && acted.json.outcome === "completed", "act decision metadata");
  const commitShaped = await tool("browser.act", { sessionId: first, action: { kind: "click", name: "Publish" } });
  assert(commitShaped.json.decision?.code === "approval_required", "commit-shaped act decision metadata");

  const opaque = await tool("browser.network", { sessionId: first, requestId: "opaque-1" });
  assert(opaque.json.result.body === null && opaque.json.result.bodyDisposition === "opaque_body_not_returned", "packed opaque body omitted");
  assert(!JSON.stringify(opaque.json).includes("packed-opaque-secret"), "packed opaque bytes absent");

  const upload = path.join(configDirectory, "asset.png");
  fs.writeFileSync(upload, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=", "base64"));
  const firstObservation = await tool("browser.observe", { sessionId: first, format: "json" });
  const setFiles = await tool("browser.act", { sessionId: first, action: { kind: "set_files", target: { ref: firstObservation.json.result.nodes[0].ref }, files: [upload] } });
  assert(setFiles.json.changed === true && !JSON.stringify(setFiles.json).includes(upload), "set_files sanitized result");

  const tabs = await tool("browser.tabs.list", {});
  const firstTab = tabs.json.sessions.find((session) => session.sessionId === first);
  const peerTab = tabs.json.sessions.find((session) => session.sessionId === peer);
  assert(firstTab && peerTab, "tabs list both logical workers");
  assert(firstTab.ownedTabId !== peerTab.ownedTabId && firstTab.tabGroupId !== peerTab.tabGroupId, "logical workers received distinct tabs and groups");
  await tool("browser.session.stop", { sessionId: peer });
  const afterPeerStop = await tool("browser.tabs.list", {});
  assert(afterPeerStop.json.sessions.some((session) => session.sessionId === first), "scoped peer stop preserved first worker");
  assert(!afterPeerStop.json.sessions.some((session) => session.sessionId === peer), "scoped peer stop removed only peer worker");
  const finalized = await tool("browser.tabs.finalize", { sessionId: first, disposition: "deliverable" });
  assert(finalized.json.finalized === true && finalized.json.tabKept === true, "finalize deliverable");
  await tool("browser.session.stop", { sessionId: first });

  const second = await startSession();
  extension.disconnectOnNextCommand = true;
  const disconnected = await tool("browser.observe", { sessionId: second });
  assert(disconnected.isError && disconnected.json.errorCode === "owner_disconnected" && disconnected.json.outcome === "outcome_unknown" && disconnected.json.retrySafe === false, "mid-command disconnect typed uncertain outcome");
  await waitUntil(() => extension.socket.readyState === WebSocket.CLOSED, "extension close");
  extension = await connectFakeExtension();
  const reconnected = await tool("browser.status", {});
  assert(!reconnected.isError && reconnected.json.ready === true, "extension reconnect");
  await tool("browser.session.stop", { sessionId: second });

  const third = await startSession();
  assert(third, "third session");
  const stopped = await tool("browser.stop_all", {});
  assert(stopped.json.stopped === true, "stop_all");

  child.stdin.write("{not-json}\n");
  const malformed = await waitForResponse("null");
  assert(malformed.error?.data?.errorCode === "invalid_json", "malformed frame typed error");

  extension.socket.close();
  child.stdin.end();
  const exitCode = await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((_, reject) => setTimeout(() => reject(new Error("stdin-close shutdown timeout")), 5000)),
  ]);
  assert(exitCode === 0, `packed host exit ${exitCode}: ${stderr}`);
  assert(!stdoutBuffer.trim(), "stdout contains only complete MCP frames");
  process.stdout.write(`${JSON.stringify({ ok: true, protocols: 4, tools: toolNames.length, packedEntry: entry })}\n`);
} catch (error) {
  child.kill();
  throw error;
}

async function startSession() {
  const started = await tool("browser.session.start", {
    origin: "https://example.com",
    allowedOrigins: ["https://example.com"],
    tabMode: "owned_group",
    instanceLabel: `packed-smoke:${randomUUID()}`,
  });
  assert(!started.isError && started.json.session?.attached, "session ready");
  return started.json.sessionId;
}

async function connectFakeExtension() {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { Origin: "chrome-extension://packed-smoke" } });
  const handshakePromise = waitForWs(socket, (message) => message.type === "auth_challenge" || message.type === "ready");
  await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  const handshake = await handshakePromise;
  if (handshake.type === "auth_challenge") {
    const pairing = JSON.parse(fs.readFileSync(path.join(configDirectory, "pairing.json"), "utf8"));
    const proof = createHmac("sha256", pairing.secret)
      .update(`newton-browser-auth-v1:${handshake.hostInstanceId}:${handshake.nonce}`)
      .digest("base64url");
    const readyPromise = waitForWs(socket, (message) => message.type === "ready");
    socket.send(JSON.stringify({ type: "auth_response", hostInstanceId: handshake.hostInstanceId, proof }));
    await readyPromise;
  } else {
    assert(handshake.authMode === "local_trust", "default packed host uses zero-touch local trust");
  }
  const clientReady = waitForWs(socket, (message) => message.type === "client_ready");
  socket.send(JSON.stringify({ type: "client_hello", clientId: "packed_smoke_extension", browserFamily: "chromium", browserMajor: 130 }));
  await clientReady;
  const state = { socket, disconnectOnNextCommand: false };
  const sessionTabs = new Map();
  socket.on("message", (data) => {
    const message = JSON.parse(data.toString());
    if (message.type === "sessions_changed") {
      for (const session of message.sessions ?? []) {
        if (session.attached) continue;
        if (!sessionTabs.has(session.sessionId)) sessionTabs.set(session.sessionId, { tabId: 501 + sessionTabs.size, groupId: 601 + sessionTabs.size });
        const owned = sessionTabs.get(session.sessionId);
        sendExtensionRequest(socket, "attachTab", { sessionId: session.sessionId, tab: { ownedTabId: owned.tabId, tabGroupId: owned.groupId, attached: true, liveOrigin: session.origin } });
        sendExtensionRequest(socket, "subscribeSession", { sessionId: session.sessionId });
      }
      return;
    }
    if (message.type !== "bridge_command") return;
    if (state.disconnectOnNextCommand) {
      state.disconnectOnNextCommand = false;
      socket.close();
      return;
    }
    const action = message.command.action;
    const owned = sessionTabs.get(message.command.sessionId) ?? { tabId: 500, groupId: 600 };
    let result;
    if (action.kind === "observe") {
      result = observationResult(message.command.sessionId, owned.tabId);
    } else if (action.kind === "screenshot") {
      result = { kind: "screenshot", mode: "cdp", origin: "https://example.com", title: `Packed smoke ${message.command.sessionId}`, width: action.fullPage ? 1440 : 1, height: action.fullPage ? 6000 : 1, fullPage: Boolean(action.fullPage), dataUrl: `data:image/png;base64,${action.fullPage ? LARGE_PNG : TINY_PNG}`, inline: true, capturedAt: new Date().toISOString() };
    } else if (action.kind === "network") {
      result = { kind: "network_log", origin: "https://example.com", entries: [], count: 0, dropped: 0, capturedAt: new Date().toISOString(), body: { requestId: "opaque-1", url: "https://example.com/blob", mimeType: "application/json", encoding: "base64", base64Encoded: true, data: "packed-opaque-secret" } };
    } else if (action.kind === "set_files") {
      result = { ...observationResult(message.command.sessionId, owned.tabId), actionStatus: "verified", changed: { files: [{ filename: path.basename(action.files[0]), sizeBytes: 68, mimeType: "image/png" }], fileCount: 1 } };
    } else if (action.kind === "__finalize") {
      result = { finalized: true, disposition: action.disposition, tabId: owned.tabId, tabKept: action.disposition !== "close" };
    } else {
      result = { kind: "ack", message: "verified", actionStatus: "verified" };
    }
    sendExtensionRequest(socket, "postResult", { event: {
      commandId: message.command.commandId,
      sessionEpoch: message.command.sessionEpoch,
      sequence: message.command.sequence,
      ok: true,
      result,
    } });
  });
  return state;
}

function observationResult(sessionId = "session", tabId = 7) {
  return { kind: "observation", mode: "cdp", origin: "https://example.com", title: `Packed smoke ${sessionId}`, nodes: [{ ref: `d1:e${tabId}`, role: "button", name: "Example" }], nodeCount: 1, truncated: false, capturedAt: new Date().toISOString() };
}

function sendExtensionRequest(socket, method, params) {
  socket.send(JSON.stringify({ type: "bridge_request", requestId: `ext_${randomUUID()}`, method, params }));
}

async function request(method, params) {
  const id = String(++requestId);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return waitForResponse(id);
}

async function rawTool(name, args) {
  return request("tools/call", { name, arguments: args });
}

async function tool(name, args) {
  const response = await rawTool(name, args);
  const text = response.result?.content?.find((item) => item.type === "text")?.text;
  return { isError: response.result?.isError === true, json: text ? JSON.parse(text) : null, response };
}

async function waitForResponse(id) {
  const key = String(id);
  if (responses.has(key)) return responses.get(key);
  await Promise.race([
    new Promise((resolve) => waiters.set(key, resolve)),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`MCP response timeout ${key}: ${stderr}`)), 5000)),
  ]);
  waiters.delete(key);
  return responses.get(key);
}

function waitForWs(socket, predicate, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error("WebSocket message timeout")); }, timeoutMs);
    const onMessage = (data) => {
      const message = JSON.parse(data.toString());
      if (!predicate(message)) return;
      cleanup();
      resolve(message);
    };
    const onError = (error) => { cleanup(); reject(error); };
    const cleanup = () => { clearTimeout(timer); socket.off("message", onMessage); socket.off("error", onError); };
    socket.on("message", onMessage);
    socket.on("error", onError);
  });
}

async function waitForHealth() {
  await waitUntil(async () => {
    try { return (await fetch(`http://127.0.0.1:${port}/health`)).status === 204; } catch { return false; }
  }, "host health");
}

async function waitUntil(predicate, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`packed host exited ${child.exitCode} while waiting for ${label}: ${stderr}`);
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function requiredArg(name) {
  const value = arg(name);
  if (!value) throw new Error(`${name} is required`);
  return path.resolve(value);
}

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function assert(condition, label) {
  if (!condition) throw new Error(`packed stdio assertion failed: ${label}`);
}
