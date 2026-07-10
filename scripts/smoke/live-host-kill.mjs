import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { startFixtureServers } from "../../test/fixtures/server.mjs";

const fixturePort = Number(process.env.NEWTON_BROWSER_QA_FIXTURE_PORT ?? 18231);
const hostPort = Number(process.env.NEWTON_BROWSER_PORT ?? 17321);
const statePath = process.env.NEWTON_BROWSER_QA_STATE_FILE;
if (!statePath) throw new Error("NEWTON_BROWSER_QA_STATE_FILE is required");

const fixture = await startFixtureServers({ port: fixturePort, crossOriginPort: fixturePort + 1 });
const configDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "newton-browser-host-kill-"));
const child = spawn(process.execPath, ["apps/mcp-server/src/index.ts"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    NEWTON_BROWSER_PORT: String(hostPort),
    NEWTON_BROWSER_CONFIG_DIR: configDirectory,
    NEWTON_BROWSER_AUTH_MODE: "local_trust",
    NEWTON_BROWSER_BROWSER: process.env.NEWTON_BROWSER_QA_OWNER === "chrome" ? "chrome" : "edge",
  },
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
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
  await request("initialize", { protocolVersion: "2025-06-18" });
  const started = await tool("browser.session.start", {
    origin: fixture.origin,
    allowedOrigins: [fixture.origin],
    tabMode: "owned_group",
    goal: "host killed mid-command",
    instanceLabel: "live-host-kill",
  }, 90_000);
  assert(!started.isError && started.json?.sessionId, `session start failed: ${JSON.stringify(started.json)}`);
  const sessionId = started.json.sessionId;
  const tabId = started.json.session?.ownedTabId;
  sendNoWait("tools/call", { name: "browser.act", arguments: {
    sessionId,
    action: { kind: "wait_for", waitFor: { text: `never-present-${Date.now()}` }, timeoutMs: 120_000 },
  } });
  await new Promise((resolve) => setTimeout(resolve, 1000));
  writeState({ phase: "kill_host_now", childPid: child.pid, sessionId, tabId });

  const exitCode = await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((_, reject) => setTimeout(() => reject(new Error("host was not killed within 90 seconds")), 90_000)),
  ]);
  writeState({ phase: "host_killed_waiting_cleanup", childPid: child.pid, sessionId, tabId, exitCode });
  await new Promise((resolve) => setTimeout(resolve, 25_000));
  const report = { ok: true, childPid: child.pid, sessionId, tabId, exitCode, cleanupWindowMs: 25_000 };
  writeState({ phase: "inspect_complete", ...report });
  process.stdout.write(`${JSON.stringify(report)}\n`);
} catch (error) {
  writeState({ phase: "fail", childPid: child.pid, message: error.message, stderr });
  throw error;
} finally {
  if (child.exitCode === null) child.kill();
  await fixture.close();
  fs.rmSync(configDirectory, { recursive: true, force: true });
}

async function request(method, params, timeoutMs = 10_000) {
  const id = String(++requestId);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return waitForResponse(id, timeoutMs);
}

function sendNoWait(method, params) {
  const id = String(++requestId);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return id;
}

async function tool(name, args, timeoutMs) {
  const response = await request("tools/call", { name, arguments: args }, timeoutMs);
  const text = response.result?.content?.find((item) => item.type === "text")?.text;
  return { isError: response.result?.isError === true, json: text ? JSON.parse(text) : null };
}

async function waitForResponse(id, timeoutMs) {
  const key = String(id);
  if (responses.has(key)) return responses.get(key);
  await Promise.race([
    new Promise((resolve) => waiters.set(key, resolve)),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`MCP response timeout ${key}: ${stderr}`)), timeoutMs)),
  ]);
  waiters.delete(key);
  return responses.get(key);
}

async function waitForHealth() {
  const started = Date.now();
  while (Date.now() - started < 10_000) {
    try {
      const response = await fetch(`http://127.0.0.1:${hostPort}/health`);
      if (response.status === 204) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`host health timeout: ${stderr}`);
}

function writeState(value) {
  fs.writeFileSync(statePath, `${JSON.stringify(value)}\n`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
