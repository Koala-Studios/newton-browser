import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { WebSocket } from "ws";

import { createNewtonBrowserHost } from "../src/bridge.ts";

type WireMessage = Record<string, any>;

function socketInbox(socket: WebSocket) {
  const messages: WireMessage[] = [];
  const waiters: Array<{ predicate: (message: WireMessage) => boolean; resolve: (message: WireMessage) => void }> = [];
  socket.on("message", (data) => {
    const message = JSON.parse(data.toString()) as WireMessage;
    messages.push(message);
    const index = waiters.findIndex(({ predicate }) => predicate(message));
    if (index < 0) return;
    const [waiter] = waiters.splice(index, 1);
    waiter!.resolve(message);
  });
  return {
    next(predicate: (message: WireMessage) => boolean): Promise<WireMessage> {
      const existing = messages.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve) => waiters.push({ predicate, resolve }));
    },
  };
}

async function connectExtension(port: number, label: string) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`, {
    headers: { Origin: "chrome-extension://aip02-acceptance" },
  });
  const inbox = socketInbox(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const ready = inbox.next((message) => message.type === "client_ready");
  socket.send(JSON.stringify({
    type: "client_hello",
    clientId: `aip02_${label}_${randomUUID().replaceAll("-", "")}`,
    browserFamily: "chrome",
    browserMajor: 130,
  }));
  await ready;
  return { socket, inbox };
}

async function extensionRequest(socket: WebSocket, inbox: ReturnType<typeof socketInbox>, method: string, params: unknown) {
  const requestId = `aip02_${randomUUID()}`;
  const response = inbox.next((message) => message.type === "bridge_response" && message.requestId === requestId);
  socket.send(JSON.stringify({ type: "bridge_request", requestId, method, params }));
  return response;
}

function safeRemoveTempRoot(directory: string) {
  const resolved = path.resolve(directory);
  assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
  assert.match(path.basename(resolved), /^newton-browser-aip02-[^/\\]+$/);
  fs.rmSync(resolved, { recursive: true, force: true });
}

test("AIP-02 acceptance: close drains lifecycle state and permits a clean host restart", { timeout: 10_000 }, async () => {
  const temporary = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "newton-browser-aip02-"));
  const registry = path.join(temporary, "registry");
  fs.mkdirSync(registry);
  const token = `observer_${"x".repeat(40)}`;
  const first = createNewtonBrowserHost({ authMode: "local_trust", browserTarget: "chrome", observerRegistryDirectory: registry, observerToken: token });
  let firstSocket: WebSocket | null = null;
  let secondSocket: WebSocket | null = null;
  let second: ReturnType<typeof createNewtonBrowserHost> | null = null;

  try {
    const address = await first.listen(0, "127.0.0.1");
    const connected = await connectExtension(address.port, "first");
    firstSocket = connected.socket;
    const session = first.createSession({ origin: "https://restart.example", allowedOrigins: ["https://restart.example"], tabMode: "owned_group" });
    await extensionRequest(firstSocket, connected.inbox, "attachTab", {
      sessionId: session.sessionId,
      tab: { ownedTabId: 501, tabGroupId: 601, attached: true, liveOrigin: "https://restart.example" },
    });
    await extensionRequest(firstSocket, connected.inbox, "subscribeSession", { sessionId: session.sessionId });

    const firstWire = connected.inbox.next((message) => message.type === "bridge_command" && message.command?.sessionId === session.sessionId);
    const active = first.dispatch(session.sessionId, { kind: "observe" }, 2_000);
    const queued = first.dispatch(session.sessionId, { kind: "observe" }, 2_000);
    await firstWire;
    await first.close();

    const activeResult = await active;
    const queuedResult = await queued;
    if (activeResult.ok) assert.fail("active command unexpectedly survived host close");
    if (queuedResult.ok) assert.fail("queued command unexpectedly survived host close");
    assert.equal(activeResult.errorCode, "owner_disconnected");
    assert.equal(activeResult.outcome, "outcome_unknown");
    assert.equal(queuedResult.errorCode, "owner_disconnected");
    assert.equal(queuedResult.outcome, "not_started");
    assert.equal(first.listSessions().length, 0);
    assert.deepEqual(fs.readdirSync(registry), []);

    second = createNewtonBrowserHost({ authMode: "local_trust", browserTarget: "chrome", observerRegistryDirectory: registry, observerToken: token });
    const restarted = await second.listen(address.port, "127.0.0.1");
    assert.equal(restarted.port, address.port, "the prior listener must release its exact port");
    assert.notEqual(second.hostInstanceId, first.hostInstanceId);

    const successor = await connectExtension(restarted.port, "second");
    secondSocket = successor.socket;
    const fresh = second.createSession({ origin: "https://restart.example", allowedOrigins: ["https://restart.example"], tabMode: "owned_group" });
    await extensionRequest(secondSocket, successor.inbox, "subscribeSession", { sessionId: fresh.sessionId });
    const freshWirePromise = successor.inbox.next((message) => message.type === "bridge_command" && message.command?.sessionId === fresh.sessionId);
    const freshWork = second.dispatch(fresh.sessionId, { kind: "observe" }, 2_000);
    const freshWire = await freshWirePromise;
    assert.equal(freshWire.command.sequence, 1);
    await extensionRequest(secondSocket, successor.inbox, "postResult", {
      event: {
        commandId: freshWire.command.commandId,
        sessionEpoch: freshWire.command.sessionEpoch,
        sequence: freshWire.command.sequence,
        ok: true,
        outcome: "completed",
        result: { restarted: true },
      },
    });
    assert.equal((await freshWork).outcome, "completed");
  } finally {
    firstSocket?.close();
    secondSocket?.close();
    await first.close();
    await second?.close();
    assert.deepEqual(fs.readdirSync(registry), []);
    safeRemoveTempRoot(temporary);
  }
});

function runStdio(input: string, configDirectory: string) {
  const child = spawn(process.execPath, ["apps/mcp-server/src/index.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, NEWTON_BROWSER_PORT: "0", NEWTON_BROWSER_CONFIG_DIR: configDirectory },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdin.end(input);
  return collectExit(child, () => ({ stdout, stderr }));
}

async function collectExit(
  child: ChildProcessWithoutNullStreams,
  output: () => { stdout: string; stderr: string },
) {
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  return { ...result, ...output() };
}

function jsonLines(stdout: string): WireMessage[] {
  return stdout.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line));
}

test("AIP-02 acceptance: malformed framing leaves no residue in a fresh stdio process", { timeout: 15_000 }, async () => {
  const temporary = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "newton-browser-aip02-"));
  const config = path.join(temporary, "config");
  fs.mkdirSync(config);
  try {
    const malformed = await runStdio('{"jsonrpc":"2.0","id":1,"method":"ping"', config);
    assert.equal(malformed.code, 0, malformed.stderr);
    const malformedFrames = jsonLines(malformed.stdout);
    assert.equal(malformedFrames.length, 1);
    assert.equal(malformedFrames[0]?.error?.data?.errorCode, "incomplete_frame");

    const recovered = await runStdio(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" })}\n`, config);
    assert.equal(recovered.code, 0, recovered.stderr);
    const recoveredFrames = jsonLines(recovered.stdout);
    assert.equal(recoveredFrames.length, 1);
    assert.equal(recoveredFrames[0]?.id, 2);
    assert.deepEqual(recoveredFrames[0]?.result, {});

    const residue = fs.readdirSync(config, { recursive: true }).map(String).filter((entry) => /(?:\.tmp$|observer|binding|session)/i.test(entry));
    assert.deepEqual(residue, []);
  } finally {
    safeRemoveTempRoot(temporary);
  }
});
