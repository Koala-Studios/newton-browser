import { createHmac } from "node:crypto";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { WebSocket } from "ws";

import { createBrowserBridgeHost } from "../src/bridge.ts";
import { evaluateHostFloor } from "../src/floor-gate.ts";
import { handleMcpMessage } from "../src/mcp-server.ts";

const PAIRING_SECRET = "a".repeat(43);

test("MCP negotiates required protocol versions and lists release tools", async () => {
  const bridge = testBridge();
  for (const protocolVersion of ["2024-11-05", "2025-11-25"]) {
    const initialized = await handleMcpMessage(bridge, { jsonrpc: "2.0", id: protocolVersion, method: "initialize", params: { protocolVersion } });
    assert.equal((initialized?.result as any)?.protocolVersion, protocolVersion);
  }
  const mismatch = await handleMcpMessage(bridge, { jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1900-01-01" } });
  assert.equal((mismatch?.error?.data as any)?.errorCode, "protocol_mismatch");

  const tools = await handleMcpMessage(bridge, { jsonrpc: "2.0", id: 3, method: "tools/list" });
  const names = ((tools?.result as any).tools as Array<{ name: string }>).map((tool) => tool.name);
  for (const name of ["browser.status", "browser.session.start", "browser.observe", "browser.act", "browser.screenshot", "browser.tabs.list", "browser.session.stop", "browser.stop_all"]) {
    assert.ok(names.includes(name), name);
  }
});

test("session start requires an exact origin and waits for authenticated extension attachment", async () => {
  const bridge = testBridge();
  const address = await bridge.listen(0);
  const extension = await connectExtension(address.port, bridge.hostInstanceId);
  autoBind(extension, "https://example.com");
  try {
    const missing = await toolCall(bridge, "browser.session.start", {});
    assert.equal(missing.isError, true);
    assert.equal(missing.json.errorCode, "origin_required");

    const invalid = await toolCall(bridge, "browser.session.start", { origin: "https://example.com/path" });
    assert.equal(invalid.isError, true);
    assert.equal(invalid.json.errorCode, "invalid_origin");

    const started = await toolCall(bridge, "browser.session.start", {
      origin: "https://example.com",
      allowedOrigins: ["https://example.com"],
      tabMode: "owned_group",
    });
    assert.equal(started.isError, false);
    assert.match(started.json.sessionId, /^bbs_local_/);
    assert.equal(started.json.session.liveOrigin, "https://example.com");
    assert.equal(started.json.session.attached, true);
  } finally {
    extension.close();
    await bridge.close();
  }
});

test("host floor blocks sensitive fields before dispatch", () => {
  const bridge = testBridge();
  const { sessionId } = bridge.createSession({ origin: "https://example.com", allowedOrigins: ["https://example.com"], tabMode: "owned_group" });
  const session = bridge.listSessions().find((candidate) => candidate.sessionId === sessionId);
  assert.ok(session);
  const verdict = evaluateHostFloor({ session, action: { kind: "fill", label: "Credit card number", value: "4111111111111111" } });
  assert.equal(verdict.relay, false);
  assert.ok(verdict.decision.reasons.includes("payment_or_pii_field"));
});

test("MCP returns a typed unsupported result for JavaScript dialog control", async () => {
  const bridge = testBridge();
  const { sessionId } = bridge.createSession({ origin: "https://example.com", allowedOrigins: ["https://example.com"], tabMode: "owned_group" });
  const result = await toolCall(bridge, "browser.act", { sessionId, action: { kind: "handle_dialog", accept: true } });
  assert.equal(result.isError, true);
  assert.equal(result.json.errorCode, "unsupported_dialog_control");
  assert.deepEqual(result.json.decision, {
    class: "blocked",
    commitBoundary: "none",
    reasons: ["unsupported_dialog_control"],
  });
});

test("authenticated ws transport queues, subscribes, and carries frames above 64 KiB", async () => {
  const bridge = testBridge();
  const address = await bridge.listen(0);
  const socket = await connectExtension(address.port, bridge.hostInstanceId);
  try {
    const { sessionId } = bridge.createSession({ origin: "https://example.com", allowedOrigins: ["https://example.com"], tabMode: "owned_group" });
    const dispatched = bridge.dispatch(sessionId, { kind: "observe", maxNodes: 5 }, 2000);
    const commandPromise = waitForMessage(socket, (message) => message.type === "bridge_command");
    await extensionRequest(socket, "subscribeSession", { sessionId });
    const command = await commandPromise;
    const large = "x".repeat(3 * 1024 * 1024);
    await extensionRequest(socket, "postResult", { event: { commandId: command.command.commandId, ok: true, result: { large } } });
    const result = await dispatched;
    assert.equal(result.ok, true);
    assert.equal((result as any).result.large.length, 3 * 1024 * 1024);
  } finally {
    socket.close();
    await bridge.close();
  }
});

test("pairing rejects normal webpage origins and invalid proofs", async () => {
  const bridge = testBridge();
  const address = await bridge.listen(0);
  try {
    await assert.rejects(openSocket(address.port, "https://evil.example"), /403/);
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}`, { headers: { Origin: "chrome-extension://test-id" } });
    const challengePromise = waitForMessage(socket, (message) => message.type === "auth_challenge");
    await waitForOpen(socket);
    const challenge = await challengePromise;
    const closePromise = waitForClose(socket);
    socket.send(JSON.stringify({ type: "auth_response", hostInstanceId: challenge.hostInstanceId, proof: "bad" }));
    const close = await closePromise;
    assert.equal(close.code, 4003);
  } finally {
    await bridge.close();
  }
});

test("health endpoint omits wildcard CORS", async () => {
  const bridge = testBridge();
  const address = await bridge.listen(0);
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/health`);
    assert.equal(response.status, 204);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
  } finally {
    await bridge.close();
  }
});

test("two independent hosts bind separate ports and isolate sessions", async () => {
  const first = testBridge({ hostInstanceId: "host-one", limits: { firstPort: 18421, lastPort: 18422 } });
  const second = testBridge({ hostInstanceId: "host-two", limits: { firstPort: 18421, lastPort: 18422 } });
  const third = testBridge({ hostInstanceId: "host-three", limits: { firstPort: 18421, lastPort: 18422 } });
  const firstAddress = await first.listen();
  const secondAddress = await second.listen();
  try {
    assert.notEqual(firstAddress.port, secondAddress.port);
    await assert.rejects(third.listen(), /host_collision/);
    const one = first.createSession({ origin: "https://one.example", allowedOrigins: ["https://one.example"], tabMode: "owned_group" });
    const two = second.createSession({ origin: "https://two.example", allowedOrigins: ["https://two.example"], tabMode: "owned_group" });
    assert.equal(first.listSessions()[0]?.sessionId, one.sessionId);
    assert.equal(second.listSessions()[0]?.sessionId, two.sessionId);
    first.stopSession(one.sessionId);
    assert.equal(first.listSessions().length, 0);
    assert.equal(second.listSessions().length, 1);
  } finally {
    await first.close();
    await second.close();
    await third.close();
  }
});

test("transport supports fragmentation and ping/pong", async () => {
  const bridge = testBridge();
  const address = await bridge.listen(0);
  const socket = await connectExtension(address.port, bridge.hostInstanceId);
  try {
    const pong = new Promise<void>((resolve) => socket.once("pong", () => resolve()));
    socket.ping("health");
    await pong;

    const { sessionId } = bridge.createSession({ origin: "https://example.com", allowedOrigins: ["https://example.com"], tabMode: "owned_group" });
    const requestId = "fragmented-subscribe";
    const response = waitForMessage(socket, (message) => message.type === "bridge_response" && message.requestId === requestId);
    const payload = JSON.stringify({ type: "bridge_request", requestId, method: "subscribeSession", params: { sessionId } });
    socket.send(payload.slice(0, 12), { fin: false });
    socket.send(payload.slice(12), { fin: true });
    assert.equal((await response).ok, true);
  } finally {
    socket.close();
    await bridge.close();
  }
});

test("session, pending, result, and orphan bounds return typed outcomes", async () => {
  const bridge = testBridge({ limits: { maxSessions: 1, maxPending: 1, maxResultBytes: 1024, orphanSessionTtlMs: 1000 } });
  const address = await bridge.listen(0);
  const socket = await connectExtension(address.port, bridge.hostInstanceId);
  try {
    const { sessionId } = bridge.createSession({ origin: "https://example.com", allowedOrigins: ["https://example.com"], tabMode: "owned_group" });
    assert.throws(() => bridge.createSession({ origin: "https://example.com", allowedOrigins: ["https://example.com"], tabMode: "owned_group" }), /session_limit/);
    const pending = bridge.dispatch(sessionId, { kind: "observe" }, 2000);
    const overflow = await bridge.dispatch(sessionId, { kind: "observe" }, 2000);
    assert.equal(overflow.errorCode, "queue_full");
    const commandPromise = waitForMessage(socket, (message) => message.type === "bridge_command");
    await extensionRequest(socket, "subscribeSession", { sessionId });
    const command = await commandPromise;
    await extensionRequest(socket, "postResult", { event: { commandId: command.command.commandId, ok: true, result: { value: "x".repeat(2048) } } });
    const oversized = await pending;
    assert.equal(oversized.errorCode, "result_too_large");
    assert.equal(bridge.reapExpiredSessions(Date.now() + 2000), 1);
    assert.equal(bridge.listSessions().length, 0);
  } finally {
    socket.close();
    await bridge.close();
  }
});

test("stdio process emits MCP only and exits after stdin closes", async () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "browser-bridge-test-"));
  const child = spawn(process.execPath, ["apps/mcp-server/src/index.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, BROWSER_BRIDGE_PORT: "0", BROWSER_BRIDGE_CONFIG_DIR: configDir },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const events = new EventEmitter();
  const responses = new Map<number, any>();
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    let newline = stdout.indexOf("\n");
    while (newline >= 0) {
      const line = stdout.slice(0, newline).trim();
      stdout = stdout.slice(newline + 1);
      if (line) {
        const message = JSON.parse(line);
        responses.set(message.id, message);
        events.emit(String(message.id));
      }
      newline = stdout.indexOf("\n");
    }
  });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  let id = 0;
  const request = async (method: string, params?: Record<string, unknown>) => {
    const requestId = ++id;
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params })}\n`);
    const deadline = Date.now() + 5000;
    while (!responses.has(requestId)) {
      if (child.exitCode !== null) throw new Error(`host exited ${child.exitCode}: ${stderr}`);
      if (Date.now() > deadline) throw new Error(`stdio response timeout: ${stderr}`);
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 25);
        events.once(String(requestId), () => { clearTimeout(timer); resolve(undefined); });
      });
    }
    return responses.get(requestId);
  };
  const initialized = await request("initialize", { protocolVersion: "2025-11-25" });
  assert.equal(initialized.result.protocolVersion, "2025-11-25");
  const tools = await request("tools/list");
  assert.ok(tools.result.tools.length >= 8);
  child.stdin.end();
  const exitCode = await new Promise<number | null>((resolve) => child.once("exit", resolve));
  assert.equal(exitCode, 0, stderr);
  assert.equal(stdout.trim(), "");
  fs.rmSync(configDir, { recursive: true, force: true });
});

function testBridge(options: Record<string, any> = {}) {
  return createBrowserBridgeHost({ pairingSecret: PAIRING_SECRET, ...options });
}

async function toolCall(bridge: ReturnType<typeof createBrowserBridgeHost>, name: string, args: Record<string, unknown>) {
  const response = await handleMcpMessage(bridge, { jsonrpc: "2.0", id: Math.random(), method: "tools/call", params: { name, arguments: args } });
  const result = response?.result as any;
  return { isError: result?.isError === true, json: JSON.parse(result.content[0].text) };
}

async function connectExtension(port: number, hostInstanceId: string) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { Origin: "chrome-extension://test-id" } });
  const challengePromise = waitForMessage(socket, (message) => message.type === "auth_challenge");
  await waitForOpen(socket);
  const challenge = await challengePromise;
  assert.equal(challenge.hostInstanceId, hostInstanceId);
  const proof = createHmac("sha256", PAIRING_SECRET)
    .update(`browser-bridge-auth-v1:${challenge.hostInstanceId}:${challenge.nonce}`)
    .digest("base64url");
  const readyPromise = waitForMessage(socket, (message) => message.type === "ready");
  socket.send(JSON.stringify({ type: "auth_response", hostInstanceId: challenge.hostInstanceId, proof }));
  await readyPromise;
  return socket;
}

function autoBind(socket: WebSocket, liveOrigin: string) {
  socket.on("message", (data) => {
    const message = JSON.parse(data.toString());
    if (message.type !== "sessions_changed") return;
    for (const session of message.sessions ?? []) {
      if (session.attached) continue;
      void extensionRequest(socket, "attachTab", {
        sessionId: session.sessionId,
        tab: { ownedTabId: 101, tabGroupId: 201, attached: true, liveOrigin },
      });
    }
  });
}

function extensionRequest(socket: WebSocket, method: string, params: unknown) {
  const requestId = `test_${Math.random()}`;
  const response = waitForMessage(socket, (message) => message.type === "bridge_response" && message.requestId === requestId);
  socket.send(JSON.stringify({ type: "bridge_request", requestId, method, params }));
  return response;
}

function waitForOpen(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
}

function waitForMessage(socket: WebSocket, predicate: (message: any) => boolean, timeoutMs = 3000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error("message timeout")); }, timeoutMs);
    const onMessage = (data: any) => {
      const message = JSON.parse(data.toString());
      if (!predicate(message)) return;
      cleanup();
      resolve(message);
    };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("message", onMessage);
      socket.off("error", onError);
    };
    socket.on("message", onMessage);
    socket.on("error", onError);
  });
}

function waitForClose(socket: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => socket.once("close", (code, reason) => resolve({ code, reason: reason.toString() })));
}

function openSocket(port: number, origin: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { Origin: origin } });
    socket.once("open", () => resolve(socket));
    socket.once("unexpected-response", (_request, response) => reject(new Error(String(response.statusCode))));
    socket.once("error", reject);
  });
}
