import { createHmac } from "node:crypto";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { WebSocket } from "ws";

import { createNewtonBrowserHost } from "../src/bridge.ts";
import { doctorToken } from "../src/config.ts";
import { evaluateHostFloor } from "../src/floor-gate.ts";
import { handleMcpMessage } from "../src/mcp-server.ts";

const PAIRING_SECRET = "a".repeat(43);

test("MCP negotiates required protocol versions and lists release tools", async () => {
  const bridge = testBridge();
  for (const protocolVersion of ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"]) {
    const initialized = await handleMcpMessage(bridge, { jsonrpc: "2.0", id: protocolVersion, method: "initialize", params: { protocolVersion } });
    assert.equal((initialized?.result as any)?.protocolVersion, protocolVersion);
  }
  const mismatch = await handleMcpMessage(bridge, { jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1900-01-01" } });
  assert.equal((mismatch?.error?.data as any)?.errorCode, "protocol_mismatch");

  const tools = await handleMcpMessage(bridge, { jsonrpc: "2.0", id: 3, method: "tools/list" });
  const names = ((tools?.result as any).tools as Array<{ name: string }>).map((tool) => tool.name);
  for (const name of ["browser.status", "browser.session.start", "browser.observe", "browser.act", "browser.screenshot", "browser.console", "browser.network", "browser.tabs.list", "browser.session.stop", "browser.stop_all"]) {
    assert.ok(names.includes(name), name);
  }
});

test("session start requires an exact origin and waits for authenticated extension attachment", async () => {
  const bridge = testBridge();
  const address = await bridge.listen(0);
  const extension = await connectExtension(address.port, bridge.hostInstanceId);
  autoBind(extension, "https://example.com");
  try {
    const doctor = await fetch(`http://127.0.0.1:${address.port}/doctor-status`, { headers: { "X-Newton-Browser-Doctor": doctorToken(PAIRING_SECRET) } });
    assert.equal(doctor.status, 200);
    assert.equal((await doctor.json() as any).extensionConnected, true);
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

test("MCP redirects the legacy handle_dialog kind to the typed accept/dismiss kinds", async () => {
  const bridge = testBridge();
  const { sessionId } = bridge.createSession({ origin: "https://example.com", allowedOrigins: ["https://example.com"], tabMode: "owned_group" });
  const result = await toolCall(bridge, "browser.act", { sessionId, action: { kind: "handle_dialog", accept: true } });
  assert.equal(result.isError, true);
  assert.equal(result.json.errorCode, "use_dialog_accept_or_dismiss");
  assert.deepEqual(result.json.decision, {
    class: "blocked",
    commitBoundary: "none",
    reasons: ["use_dialog_accept_or_dismiss"],
  });
});

test("MCP blocks a sensitive fill before any extension dispatch", async () => {
  const bridge = testBridge({ limits: { commandTimeoutMs: 5000 } });
  const { sessionId } = bridge.createSession({ origin: "https://example.com", allowedOrigins: ["https://example.com"], tabMode: "owned_group" });
  const started = Date.now();
  const result = await toolCall(bridge, "browser.act", { sessionId, action: { kind: "fill", label: "One-time code", value: "123456" } });
  assert.equal(result.isError, true);
  assert.equal(result.json.errorCode, "blocked_by_floor");
  assert.ok(result.json.decision.reasons.includes("secret_or_password_field"));
  assert.ok(Date.now() - started < 250, "a pre-dispatch block must not wait for an extension or command timeout");
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

test("observation results are secret-redacted before reaching the MCP client", async () => {
  const bridge = testBridge();
  const address = await bridge.listen(0);
  const socket = await connectExtension(address.port, bridge.hostInstanceId);
  try {
    const { sessionId } = bridge.createSession({ origin: "https://example.com", allowedOrigins: ["https://example.com"], tabMode: "owned_group" });
    await extensionRequest(socket, "subscribeSession", { sessionId });
    const commandPromise = waitForMessage(socket, (message) => message.type === "bridge_command");
    const callPromise = toolCall(bridge, "browser.observe", { sessionId, mode: "full" });
    const command = await commandPromise;
    await extensionRequest(socket, "postResult", { event: { commandId: command.command.commandId, ok: true, result: {
      kind: "observation", mode: "cdp", origin: "https://example.com", title: "Checkout",
      nodes: [{ ref: "n0", role: "textbox", name: "Card number", value: "4111 1111 1111 1111" }],
      nodeCount: 1, truncated: false, capturedAt: "2026-07-10T00:00:00.000Z", actionStatus: "verified", verified: true,
    } } });
    const result = await callPromise;
    assert.equal(result.isError, false);
    assert.equal(result.json.result.kind, "observation");
    assert.equal(result.json.result.nodes[0].value, "[REDACTED]");
    assert.equal(result.json.result.nodes[0].name, "Card number");
    assert.equal(result.json.result.actionStatus, "verified");
  } finally {
    socket.close();
    await bridge.close();
  }
});

test("mode:text observations mask card/SSN sequences before reaching the client", async () => {
  const bridge = testBridge();
  const address = await bridge.listen(0);
  const socket = await connectExtension(address.port, bridge.hostInstanceId);
  try {
    const { sessionId } = bridge.createSession({ origin: "https://example.com", allowedOrigins: ["https://example.com"], tabMode: "owned_group" });
    await extensionRequest(socket, "subscribeSession", { sessionId });
    const commandPromise = waitForMessage(socket, (message) => message.type === "bridge_command");
    const callPromise = toolCall(bridge, "browser.observe", { sessionId, mode: "text" });
    const command = await commandPromise;
    await extensionRequest(socket, "postResult", { event: { commandId: command.command.commandId, ok: true, result: {
      kind: "observation_text", mode: "text", origin: "https://example.com", title: "Receipt",
      text: "Your card 4111 1111 1111 1111 and SSN 123-45-6789 are on file.", chars: 60, truncated: false,
      capturedAt: "2026-07-10T00:00:00.000Z", actionStatus: "verified", verified: true,
    } } });
    const result = await callPromise;
    assert.equal(result.isError, false);
    assert.equal(result.json.result.text.includes("4111"), false);
    assert.equal(result.json.result.text.includes("123-45-6789"), false);
    assert.ok(result.json.result.text.includes("[REDACTED_CARD]"));
    assert.ok(result.json.result.text.includes("[REDACTED_SSN]"));
  } finally {
    socket.close();
    await bridge.close();
  }
});

test("fill_form fills fields sequentially in one call", async () => {
  const bridge = testBridge();
  const address = await bridge.listen(0);
  const socket = await connectExtension(address.port, bridge.hostInstanceId);
  try {
    const { sessionId } = bridge.createSession({ origin: "https://example.com", allowedOrigins: ["https://example.com"], tabMode: "owned_group" });
    await extensionRequest(socket, "subscribeSession", { sessionId });
    // Echo every fill command back as a verified observation.
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString());
      if (message.type !== "bridge_command") return;
      void extensionRequest(socket, "postResult", { event: { commandId: message.command.commandId, ok: true, result: {
        kind: "observation", mode: "cdp", origin: "https://example.com", title: "Form", nodes: [], nodeCount: 0,
        truncated: false, capturedAt: "2026-07-10T00:00:00.000Z", actionStatus: "verified", verified: true,
      } } });
    });
    const result = await toolCall(bridge, "browser.act", { sessionId, action: { kind: "fill_form", fields: [
      { label: "First name", value: "Ada" },
      { label: "Last name", value: "Lovelace" },
    ] } });
    assert.equal(result.isError, false);
    assert.equal(result.json.ok, true);
    assert.equal(result.json.filled, 2);
    assert.deepEqual(result.json.fields.map((f: any) => f.status), ["verified", "verified"]);
  } finally {
    socket.close();
    await bridge.close();
  }
});

test("fill_form stops at a sensitive field before dispatching it", async () => {
  const bridge = testBridge();
  const address = await bridge.listen(0);
  const socket = await connectExtension(address.port, bridge.hostInstanceId);
  try {
    const { sessionId } = bridge.createSession({ origin: "https://example.com", allowedOrigins: ["https://example.com"], tabMode: "owned_group" });
    await extensionRequest(socket, "subscribeSession", { sessionId });
    let dispatched = 0;
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString());
      if (message.type !== "bridge_command") return;
      dispatched += 1;
      void extensionRequest(socket, "postResult", { event: { commandId: message.command.commandId, ok: true, result: {
        kind: "observation", mode: "cdp", origin: "https://example.com", title: "Form", nodes: [], nodeCount: 0,
        truncated: false, capturedAt: "2026-07-10T00:00:00.000Z", actionStatus: "verified", verified: true,
      } } });
    });
    const result = await toolCall(bridge, "browser.act", { sessionId, action: { kind: "fill_form", fields: [
      { label: "Username", value: "ada" },
      { label: "Password", value: "hunter2" },
      { label: "Bio", value: "never reached" },
    ] } });
    assert.equal(result.isError, true);
    assert.equal(result.json.errorCode, "blocked_by_floor");
    assert.equal(result.json.stoppedAt, 1);
    assert.equal(result.json.fields[1].status, "blocked");
    assert.equal(dispatched, 1, "only the first (safe) field is dispatched; the batch halts before the password");
  } finally {
    socket.close();
    await bridge.close();
  }
});

test("browser.console returns the buffered log, secret-redacted", async () => {
  const bridge = testBridge();
  const address = await bridge.listen(0);
  const socket = await connectExtension(address.port, bridge.hostInstanceId);
  try {
    const { sessionId } = bridge.createSession({ origin: "https://example.com", allowedOrigins: ["https://example.com"], tabMode: "owned_group" });
    await extensionRequest(socket, "subscribeSession", { sessionId });
    const commandPromise = waitForMessage(socket, (message) => message.type === "bridge_command");
    const callPromise = toolCall(bridge, "browser.console", { sessionId, level: "error" });
    const command = await commandPromise;
    assert.equal(command.command.action.kind, "console");
    await extensionRequest(socket, "postResult", { event: { commandId: command.command.commandId, ok: true, result: {
      kind: "console_log", origin: "https://example.com", entries: [{ level: "error", text: "Failed with card 4111 1111 1111 1111", at: "2026-07-10T00:00:00.000Z" }],
      count: 1, dropped: 0, capturedAt: "2026-07-10T00:00:00.000Z",
    } } });
    const result = await callPromise;
    assert.equal(result.isError, false);
    assert.equal(result.json.result.kind, "console_log");
    assert.equal(result.json.result.entries[0].text.includes("4111"), false);
    assert.ok(result.json.result.entries[0].text.includes("[REDACTED_CARD]"));
  } finally {
    socket.close();
    await bridge.close();
  }
});

test("browser.network lists requests and never returns headers", async () => {
  const bridge = testBridge();
  const address = await bridge.listen(0);
  const socket = await connectExtension(address.port, bridge.hostInstanceId);
  try {
    const { sessionId } = bridge.createSession({ origin: "https://example.com", allowedOrigins: ["https://example.com"], tabMode: "owned_group" });
    await extensionRequest(socket, "subscribeSession", { sessionId });
    const commandPromise = waitForMessage(socket, (message) => message.type === "bridge_command");
    const callPromise = toolCall(bridge, "browser.network", { sessionId });
    const command = await commandPromise;
    assert.equal(command.command.action.kind, "network");
    await extensionRequest(socket, "postResult", { event: { commandId: command.command.commandId, ok: true, result: {
      kind: "network_log", origin: "https://example.com", entries: [{ requestId: "r1", method: "POST", url: "https://example.com/api", status: 200, at: "2026-07-10T00:00:00.000Z" }],
      count: 1, dropped: 0, capturedAt: "2026-07-10T00:00:00.000Z",
    } } });
    const result = await callPromise;
    assert.equal(result.isError, false);
    assert.equal(result.json.result.entries[0].method, "POST");
    assert.equal(result.json.result.entries[0].status, 200);
    assert.equal("headers" in result.json.result.entries[0], false);
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

test("zero-touch local trust accepts an extension without a pairing key and still rejects webpages", async () => {
  const bridge = createNewtonBrowserHost({ authMode: "local_trust", pairingSecret: PAIRING_SECRET });
  const address = await bridge.listen(0);
  try {
    await assert.rejects(openSocket(address.port, "https://evil.example"), /403/);
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}`, { headers: { Origin: "chrome-extension://test-id" } });
    const readyPromise = waitForMessage(socket, (message) => message.type === "ready");
    await waitForOpen(socket);
    const ready = await readyPromise;
    assert.equal(ready.authMode, "local_trust");
    assert.equal(ready.hostInstanceId, bridge.hostInstanceId);
    socket.send(JSON.stringify({ type: "client_hello", clientId: "local_chrome_client", browserFamily: "chrome" }));
    await waitForMessage(socket, (message) => message.type === "client_ready");
    assert.equal(bridge.getStatus().extensionConnected, true);
    assert.equal(bridge.getStatus().authMode, "local_trust");
    socket.close();
  } finally {
    await bridge.close();
  }
});

test("simultaneous Chrome and Edge atomically claim one session without duplicate control", async () => {
  const bridge = testBridge();
  const address = await bridge.listen(0);
  const chrome = await connectExtension(address.port, bridge.hostInstanceId, { clientId: "qa_chrome_profile", browserFamily: "chrome" });
  const edge = await connectExtension(address.port, bridge.hostInstanceId, { clientId: "qa_edge_profile", browserFamily: "edge" });
  try {
    const { sessionId } = bridge.createSession({ origin: "https://example.com", allowedOrigins: ["https://example.com"], tabMode: "owned_group" });
    const [chromeList, edgeList] = await Promise.all([
      extensionRequest(chrome, "listSessions", {}),
      extensionRequest(edge, "listSessions", {}),
    ]);
    const chromeClaimed = Array.isArray(chromeList.result) && chromeList.result.some((session: any) => session.sessionId === sessionId);
    const edgeClaimed = Array.isArray(edgeList.result) && edgeList.result.some((session: any) => session.sessionId === sessionId);
    assert.notEqual(chromeClaimed, edgeClaimed, "exactly one browser must win the atomic session claim");
    const winner = chromeClaimed ? chrome : edge;
    const loser = chromeClaimed ? edge : chrome;

    const denied = await extensionRequest(loser, "attachTab", { sessionId, tab: { ownedTabId: 9, attached: true, liveOrigin: "https://example.com" } });
    assert.equal(denied.ok, false);
    assert.equal(denied.error, "session_not_owned");
    const attached = await extensionRequest(winner, "attachTab", { sessionId, tab: { ownedTabId: 10, attached: true, liveOrigin: "https://example.com" } });
    assert.equal(attached.ok, true);
    await extensionRequest(winner, "subscribeSession", { sessionId });

    let loserCommandCount = 0;
    const onLoserMessage = (data: any) => {
      if (JSON.parse(data.toString()).type === "bridge_command") loserCommandCount += 1;
    };
    loser.on("message", onLoserMessage);
    const commandPromise = waitForMessage(winner, (message) => message.type === "bridge_command");
    const dispatched = bridge.dispatch(sessionId, { kind: "observe", maxNodes: 5 }, 2000);
    const command = await commandPromise;
    await extensionRequest(winner, "postResult", { event: { commandId: command.command.commandId, ok: true, result: { browser: chromeClaimed ? "chrome" : "edge" } } });
    assert.equal((await dispatched).ok, true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    loser.off("message", onLoserMessage);
    assert.equal(loserCommandCount, 0, "standby browser must never receive the claimed session command");

    const released = waitForMessage(loser, (message) => message.type === "sessions_changed" && message.sessions?.some((session: any) => session.sessionId === sessionId));
    winner.close();
    await released;
    const takeover = await extensionRequest(loser, "listSessions", {});
    const transferred = takeover.result.find((session: any) => session.sessionId === sessionId);
    assert.ok(transferred);
    assert.equal(transferred.attached, false);
    assert.equal(transferred.ownedTabId, null);
    assert.equal((await extensionRequest(loser, "attachTab", { sessionId, tab: { ownedTabId: 11, attached: true, liveOrigin: "https://example.com" } })).ok, true);
  } finally {
    chrome.close();
    edge.close();
    await bridge.close();
  }
});

test("browser target selects Edge while Chrome remains connected as standby", async () => {
  const bridge = testBridge({ browserTarget: "edge" });
  const address = await bridge.listen(0);
  const chrome = await connectExtension(address.port, bridge.hostInstanceId, { clientId: "target_chrome_profile", browserFamily: "chrome" });
  try {
    assert.equal(bridge.getStatus().extensionConnected, false);
    assert.equal(bridge.getStatus().browserTarget, "edge");
    const { sessionId } = bridge.createSession({ origin: "https://example.com", allowedOrigins: ["https://example.com"], tabMode: "owned_group" });
    const denied = await extensionRequest(chrome, "listSessions", {});
    assert.equal(denied.ok, false);
    assert.equal(denied.error, "browser_not_selected");

    const edge = await connectExtension(address.port, bridge.hostInstanceId, { clientId: "target_edge_profile", browserFamily: "edge" });
    try {
      assert.equal(bridge.getStatus().extensionConnected, true);
      const claimed = await extensionRequest(edge, "listSessions", {});
      assert.deepEqual(claimed.result.map((session: any) => session.sessionId), [sessionId]);
    } finally {
      edge.close();
    }
  } finally {
    chrome.close();
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
    const denied = await fetch(`http://127.0.0.1:${address.port}/doctor-status`);
    assert.equal(denied.status, 403);
    assert.equal(denied.headers.get("access-control-allow-origin"), null);
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

test("command timeout and session stop resolve pending work with typed outcomes", async () => {
  const bridge = testBridge({ limits: { maxCommandTimeoutMs: 250 } });
  const address = await bridge.listen(0);
  const socket = await connectExtension(address.port, bridge.hostInstanceId);
  try {
    const first = bridge.createSession({ origin: "https://example.com", allowedOrigins: ["https://example.com"], tabMode: "owned_group" });
    await extensionRequest(socket, "subscribeSession", { sessionId: first.sessionId });
    const timedOut = await bridge.dispatch(first.sessionId, { kind: "observe" }, 100);
    assert.equal(timedOut.errorCode, "command_timeout");

    const second = bridge.createSession({ origin: "https://example.com", allowedOrigins: ["https://example.com"], tabMode: "owned_group" });
    await extensionRequest(socket, "subscribeSession", { sessionId: second.sessionId });
    const pending = bridge.dispatch(second.sessionId, { kind: "observe" }, 250);
    bridge.stopSession(second.sessionId);
    assert.equal((await pending).errorCode, "session_stopped");
  } finally {
    socket.close();
    await bridge.close();
  }
});

test("stdio process emits MCP only and exits after stdin closes", async () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "newton-browser-test-"));
  const child = spawn(process.execPath, ["apps/mcp-server/src/index.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, NEWTON_BROWSER_PORT: "0", NEWTON_BROWSER_CONFIG_DIR: configDir },
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

test("stdio process stays alive and returns typed host_collision when its port is occupied", async () => {
  const blocker = net.createServer();
  await new Promise<void>((resolve, reject) => { blocker.once("error", reject); blocker.listen(0, "127.0.0.1", resolve); });
  const address = blocker.address();
  assert.ok(address && typeof address === "object");
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "newton-browser-collision-"));
  const child = spawn(process.execPath, ["apps/mcp-server/src/index.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, NEWTON_BROWSER_PORT: String(address.port), NEWTON_BROWSER_CONFIG_DIR: configDir },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const client = jsonLineClient(child);
  try {
    const initialized = await client.request("initialize", { protocolVersion: "2025-11-25" });
    assert.equal(initialized.result.protocolVersion, "2025-11-25");
    const listed = await client.request("tools/list");
    assert.ok(listed.result.tools.length >= 8);
    const status = await client.request("tools/call", { name: "browser.status", arguments: {} });
    assert.equal(status.result.isError, true);
    const detail = JSON.parse(status.result.content[0].text);
    assert.equal(detail.errorCode, "host_collision");
    assert.equal(detail.nextAction, "stop_stale_newton_browser_hosts_or_free_a_configured_port");
    child.stdin.end();
    const exitCode = await new Promise<number | null>((resolve) => child.once("exit", resolve));
    assert.equal(exitCode, 0, client.stderr());
  } finally {
    if (child.exitCode === null) child.kill();
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

function testBridge(options: Record<string, any> = {}) {
  return createNewtonBrowserHost({ pairingSecret: PAIRING_SECRET, ...options });
}

function jsonLineClient(child: ReturnType<typeof spawn>) {
  const responses = new Map<number, any>();
  const waiters = new Map<number, () => void>();
  let buffer = "";
  let stderr = "";
  let id = 0;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) {
        const message = JSON.parse(line);
        responses.set(message.id, message);
        waiters.get(message.id)?.();
      }
      newline = buffer.indexOf("\n");
    }
  });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  return {
    stderr: () => stderr,
    async request(method: string, params?: Record<string, unknown>) {
      const requestId = ++id;
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params })}\n`);
      if (!responses.has(requestId)) await Promise.race([
        new Promise<void>((resolve) => waiters.set(requestId, resolve)),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`stdio response timeout: ${stderr}`)), 5000)),
      ]);
      waiters.delete(requestId);
      return responses.get(requestId);
    },
  };
}

async function toolCall(bridge: ReturnType<typeof createNewtonBrowserHost>, name: string, args: Record<string, unknown>) {
  const response = await handleMcpMessage(bridge, { jsonrpc: "2.0", id: Math.random(), method: "tools/call", params: { name, arguments: args } });
  const result = response?.result as any;
  return { isError: result?.isError === true, json: JSON.parse(result.content[0].text) };
}

async function connectExtension(port: number, hostInstanceId: string, identity = { clientId: "test_chrome_client", browserFamily: "chrome" }) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { Origin: "chrome-extension://test-id" } });
  const challengePromise = waitForMessage(socket, (message) => message.type === "auth_challenge");
  await waitForOpen(socket);
  const challenge = await challengePromise;
  assert.equal(challenge.hostInstanceId, hostInstanceId);
  const proof = createHmac("sha256", PAIRING_SECRET)
    .update(`newton-browser-auth-v1:${challenge.hostInstanceId}:${challenge.nonce}`)
    .digest("base64url");
  const readyPromise = waitForMessage(socket, (message) => message.type === "ready");
  socket.send(JSON.stringify({ type: "auth_response", hostInstanceId: challenge.hostInstanceId, proof }));
  await readyPromise;
  const clientReady = waitForMessage(socket, (message) => message.type === "client_ready");
  socket.send(JSON.stringify({ type: "client_hello", ...identity }));
  await clientReady;
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
