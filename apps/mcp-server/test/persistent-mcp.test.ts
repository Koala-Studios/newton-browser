import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import type { DirectBrowserHost } from "../src/browser-runtime/direct-browser-host.ts";
import { boundedIdleMs, prepareSocketPath, startPersistentMcpDaemon } from "../src/persistent-mcp.ts";

test("persistent MCP idle bounds preserve approval-gated worker continuity", () => {
  assert.equal(boundedIdleMs(undefined), 60_000);
  assert.equal(boundedIdleMs("5000"), 10_000);
  assert.equal(boundedIdleMs(String(7 * 24 * 60 * 60_000)), 7 * 24 * 60 * 60_000);
  assert.equal(boundedIdleMs(String(60 * 24 * 60 * 60_000)), 30 * 24 * 60 * 60_000);
});

test("persistent MCP daemon preserves sessions across clients and rejects concurrent clients", { skip: process.platform === "win32" }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "newton-browser-daemon-"));
  const socketPath = path.join(root, "browser.sock");
  const sessions = new Map<string, Record<string, unknown>>();
  let stopped = false;
  const bridge = {
    listen: async () => 17321,
    close: async () => undefined,
    stopAll: () => { stopped = true; sessions.clear(); },
    listSessions: () => [...sessions.values()],
    createSession: (input: Record<string, unknown>) => {
      const sessionId = `session_${sessions.size + 1}`;
      sessions.set(sessionId, { sessionId, attached: true, liveOrigin: input.origin, ...input });
      return { sessionId };
    },
    waitForSessionReady: async (sessionId: string) => sessions.get(sessionId),
    getStatus: () => ({ mode: "direct", configured: true }),
  } as unknown as DirectBrowserHost;
  const daemon = await startPersistentMcpDaemon(socketPath, { bridge, idleMs: 60_000 });
  try {
    const first = net.connect(socketPath);
    await onceConnected(first);
    const created = await rpc(first, 1, "tools/call", {
      name: "browser.session.start",
      arguments: { origin: "https://example.com", goal: "reconnect test" },
    });
    assert.match(JSON.stringify(created), /session_1/u);

    const concurrent = net.connect(socketPath);
    await new Promise<void>((resolve) => concurrent.once("close", resolve));
    first.end();
    await new Promise<void>((resolve) => first.once("close", resolve));

    const second = net.connect(socketPath);
    await onceConnected(second);
    const listed = await rpc(second, 2, "tools/call", { name: "browser.sessions.list", arguments: {} });
    assert.match(JSON.stringify(listed), /session_1/u);
    second.end();
    await new Promise<void>((resolve) => second.once("close", resolve));
  } finally {
    await daemon.close();
    assert.equal(stopped, true);
    assert.equal(fs.existsSync(socketPath), false);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("persistent MCP expires orphaned direct sessions before closing its continuity socket", { skip: process.platform === "win32" }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "newton-browser-direct-orphan-"));
  const socketPath = path.join(root, "browser.sock");
  const sessions = new Map([["direct-session", { sessionId: "direct-session", origin: "https://example.com", lifecycleState: "active" }]]);
  let stopCalls = 0;
  let cleanupStarted!: () => void;
  const started = new Promise<void>((resolve) => { cleanupStarted = resolve; });
  const bridge = {
    listen: async () => ({ mode: "direct", port: null }),
    listSessions: () => [...sessions.values()],
    async stopAll() {
      stopCalls += 1;
      cleanupStarted();
      sessions.clear();
    },
    async close() {},
  } as never;
  const daemon = await startPersistentMcpDaemon(socketPath, {
    bridge,
    idleMs: 60_000,
    orphanSessionTtlMs: 10,
  });
  try {
    const client = net.connect(socketPath);
    await onceConnected(client);
    client.end();
    await new Promise<void>((resolve) => client.once("close", resolve));
    await started;
    await daemon.closed;
    assert.equal(stopCalls >= 1, true);
    assert.equal(sessions.size, 0);
    assert.equal(fs.existsSync(socketPath), false);
  } finally {
    await daemon.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("direct persistent mode requires explicit continuity enablement", { skip: process.platform === "win32" }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "newton-browser-direct-gate-"));
  const socketPath = path.join(root, "browser.sock");
  const previousContinuity = process.env.NEWTON_BROWSER_DIRECT_CONTINUITY;
  try {
    delete process.env.NEWTON_BROWSER_DIRECT_CONTINUITY;
    await assert.rejects(startPersistentMcpDaemon(socketPath), /direct_continuity_not_enabled/u);
    assert.equal(fs.existsSync(socketPath), false);
  } finally {
    if (previousContinuity === undefined) delete process.env.NEWTON_BROWSER_DIRECT_CONTINUITY;
    else process.env.NEWTON_BROWSER_DIRECT_CONTINUITY = previousContinuity;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("orphan cleanup failure retains sessions and retries the authoritative stop", { skip: process.platform === "win32" }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "newton-browser-direct-orphan-retry-"));
  const socketPath = path.join(root, "browser.sock");
  const sessions = new Map([["direct-session", { sessionId: "direct-session", origin: "https://example.com", lifecycleState: "active" }]]);
  let stopCalls = 0;
  let retried!: () => void;
  const retryObserved = new Promise<void>((resolve) => { retried = resolve; });
  const bridge = {
    listen: async () => ({ mode: "direct", port: null }),
    listSessions: () => [...sessions.values()],
    async stopAll() {
      stopCalls += 1;
      if (stopCalls === 1) throw new Error("injected_stop_uncertainty");
      sessions.clear();
      retried();
    },
    async close() {},
  } as never;
  const daemon = await startPersistentMcpDaemon(socketPath, {
    bridge,
    idleMs: 60_000,
    orphanSessionTtlMs: 10,
  });
  try {
    const client = net.connect(socketPath);
    await onceConnected(client);
    client.end();
    await new Promise<void>((resolve) => client.once("close", resolve));
    await retryObserved;
    await daemon.closed;
    assert.equal(stopCalls >= 2, true);
    assert.equal(sessions.size, 0);
  } finally {
    await daemon.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("persistent MCP socket preparation never deletes a regular file", { skip: process.platform === "win32" }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "newton-browser-socket-safety-"));
  const target = path.join(root, "not-a-socket");
  fs.writeFileSync(target, "keep me", "utf8");
  assert.throws(() => prepareSocketPath(target), /persistent_mcp_socket_target_unsafe/u);
  assert.equal(fs.readFileSync(target, "utf8"), "keep me");
  fs.rmSync(root, { recursive: true, force: true });
});

test("persistent MCP shutdown closes after stopAll failure", { skip: process.platform === "win32" }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "newton-browser-daemon-close-"));
  const socketPath = path.join(root, "browser.sock");
  const calls: string[] = [];
  const bridge = {
    listen: async () => 17321,
    listSessions: () => [],
    async stopAll() {
      calls.push("stopAll");
      throw new Error("stop_all_failed");
    },
    async close() { calls.push("close"); },
  } as unknown as DirectBrowserHost;
  const daemon = await startPersistentMcpDaemon(socketPath, { bridge, idleMs: 60_000 });
  try {
    await daemon.close();
    await daemon.closed;
    assert.deepEqual(calls, ["stopAll", "close"]);
    assert.equal(fs.existsSync(socketPath), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("persistent MCP failed close settles closed and a later close retries cleanup", { skip: process.platform === "win32" }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "newton-browser-daemon-retry-"));
  const socketPath = path.join(root, "browser.sock");
  const calls: string[] = [];
  let closeAttempts = 0;
  const bridge = {
    listen: async () => 17321,
    listSessions: () => [],
    async stopAll() { calls.push("stopAll"); },
    async close() {
      calls.push("close");
      closeAttempts += 1;
      if (closeAttempts === 1) throw new Error("close_failed");
    },
  } as unknown as DirectBrowserHost;
  const daemon = await startPersistentMcpDaemon(socketPath, { bridge, idleMs: 60_000 });
  try {
    await assert.rejects(daemon.close(), /close_failed/u);
    await assert.rejects(daemon.closed, /close_failed/u);
    assert.equal(fs.existsSync(socketPath), true);
    await daemon.close();
    assert.deepEqual(calls, ["stopAll", "close", "stopAll", "close"]);
    assert.equal(fs.existsSync(socketPath), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

async function onceConnected(socket: net.Socket): Promise<void> {
  if (!socket.connecting) return;
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
}

async function rpc(socket: net.Socket, id: number, method: string, params: Record<string, unknown>): Promise<unknown> {
  const output = new PassThrough();
  const response = new Promise<unknown>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("rpc_timeout")), 2_000);
    const onData = (chunk: Buffer) => {
      const line = chunk.toString("utf8").trim();
      if (!line) return;
      clearTimeout(timeout);
      socket.off("data", onData);
      resolve(JSON.parse(line));
    };
    socket.on("data", onData);
  });
  output.end(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  for await (const chunk of output) socket.write(chunk);
  return response;
}
