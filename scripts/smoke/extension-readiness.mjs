import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const version = JSON.parse(fs.readFileSync("apps/mcp-server/package.json", "utf8")).version;
const tarball = path.resolve(`artifacts/newton-browser-${version}.tgz`);
const extensionArtifact = path.resolve(`artifacts/newton-browser-extension-${version}.zip`);
if (!fs.existsSync(extensionArtifact) || !fs.readFileSync(extensionArtifact).includes(Buffer.from("onboarding.html"))) {
  throw new Error("packed extension artifact is missing onboarding.html");
}
const npxCli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npx-cli.js");
const child = spawn(process.execPath, [npxCli, "--yes", "--package", tarball, "newton-browser"], {
  cwd: process.cwd(),
  env: cleanEnvironment(),
  windowsHide: true,
  stdio: ["pipe", "pipe", "pipe"],
});
const responses = new Map();
const waiters = new Map();
let stdout = "";
let stderr = "";
let id = 0;

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
      responses.set(String(message.id), message);
      waiters.get(String(message.id))?.();
    }
    newline = stdout.indexOf("\n");
  }
});
child.stderr.on("data", (chunk) => { stderr += chunk; });

const timeoutMs = Math.max(1_000, Number(process.env.NEWTON_BROWSER_EXTENSION_PROBE_MS ?? 35_000));
const startedAt = Date.now();
let last = { ready: false, errorCode: "extension_disconnected" };
try {
  await request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "extension-readiness", version } }, 30_000);
  while (Date.now() - startedAt < timeoutMs) {
    const response = await request("tools/call", { name: "browser.status", arguments: {} });
    const result = response.result;
    const text = result?.content?.find((item) => item.type === "text")?.text;
    const value = text ? JSON.parse(text) : {};
    last = { ready: value.ready === true, errorCode: value.errorCode ?? null };
    if (last.ready) break;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  process.stdout.write(`${JSON.stringify({ ...last, elapsedMs: Date.now() - startedAt, secretExposed: false })}\n`);
} finally {
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.stdin.end();
  const cleanExit = await Promise.race([
    exited.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 5_000)),
  ]);
  if (!cleanExit) terminateProcessTree(child);
}

async function request(method, params, responseTimeoutMs = 10_000) {
  const requestId = String(++id);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params })}\n`);
  if (!responses.has(requestId)) await Promise.race([
    new Promise((resolve) => waiters.set(requestId, resolve)),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`MCP response timeout: ${stderr}`)), responseTimeoutMs)),
  ]);
  waiters.delete(requestId);
  return responses.get(requestId);
}

function cleanEnvironment() {
  const env = { ...process.env, npm_config_update_notifier: "false" };
  delete env.npm_config_verify_deps_before_run;
  return env;
}

function terminateProcessTree(processHandle) {
  if (processHandle.exitCode !== null || processHandle.signalCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill.exe", ["/PID", String(processHandle.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return;
  }
  processHandle.kill("SIGKILL");
}
