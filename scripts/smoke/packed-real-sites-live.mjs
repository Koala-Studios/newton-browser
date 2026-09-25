import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { discoverBrowserExecutable } from "../../apps/mcp-server/src/browser-runtime/browser-discovery.ts";

const version = JSON.parse(fs.readFileSync("apps/mcp-server/package.json", "utf8")).version;
const family = process.env.NEWTON_BROWSER_QA_BROWSER === "edge" ? "edge" : "chrome";
const executable = discoverBrowserExecutable({ family, ...(process.env.NEWTON_BROWSER_BROWSER_EXECUTABLE ? { explicitPath: process.env.NEWTON_BROWSER_BROWSER_EXECUTABLE } : {}), env: process.env });
if (!executable) throw new Error("packed_real_sites_browser_unavailable");
const artifact = path.resolve("artifacts", `newton-browser-${version}.tgz`);
if (!fs.existsSync(artifact)) throw new Error("packed_real_sites_artifact_missing");
const parent = fs.realpathSync.native(os.tmpdir());
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(parent, "newton-packed-real-sites-")));
const nonce = randomBytes(32).toString("hex");
fs.writeFileSync(path.join(root, ".owner"), nonce, { flag: "wx", mode: 0o600 });
const install = path.join(root, "install");
const config = path.join(root, "config");
const profiles = path.join(root, "profiles");
fs.mkdirSync(install, { recursive: true });
fs.writeFileSync(path.join(install, "package.json"), JSON.stringify({ name: "newton-packed-real-sites", private: true }));
const env = { ...process.env, NEWTON_BROWSER_CONFIG_DIR: config, NEWTON_BROWSER_PROFILE_STORE_DIR: profiles, NEWTON_BROWSER_BROWSER: family, NEWTON_BROWSER_BROWSER_EXECUTABLE: executable.path, npm_config_cache: path.join(root, "npm-cache") };
let client;
const sites = [
  { id: "rfc-editor", url: "https://www.rfc-editor.org/", marker: "RFC" },
  { id: "w3c-accessibility", url: "https://www.w3.org/WAI/", marker: "Accessibility" },
  { id: "wikipedia-browser", url: "https://en.wikipedia.org/wiki/Web_browser", marker: "browser" },
];
const receipts = [];
try {
  await run(process.execPath, [npmCli(), "install", "--ignore-scripts", "--no-audit", "--no-fund", "--offline", artifact], install, env);
  const entry = path.join(install, "node_modules", "newton-browser", "dist", "index.js");
  if (!fs.existsSync(entry)) throw new Error("packed_real_sites_entry_missing");
  client = createClient(entry, install, env);
  const discovered = await client.request("server/discover", {});
  if (discovered?.result?.supportedVersions?.[0] !== "2026-07-28") throw new Error("packed_real_sites_discovery_failed");
  for (const site of sites) receipts.push(await runSite(site));
  await client.close(); client = null;
  const output = { ok: true, browserFamily: family, packedArtifactSha256: createHash("sha256").update(fs.readFileSync(artifact)).digest("hex"), sites: receipts, engine: "packed_default_session_engine", legacyHost: false };
  process.stdout.write(`${JSON.stringify(output)}\n`);
} finally {
  if (client) await client.abort();
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || path.dirname(root) !== parent || fs.readFileSync(path.join(root, ".owner"), "utf8") !== nonce) throw new Error("packed_real_sites_cleanup_refused");
  fs.rmSync(root, { recursive: true });
}

async function runSite(site) {
  const started = await client.tool("browser.session.start", { url: site.url });
  requireSuccess(started, `${site.id}_start_failed`);
  const sessionId = started.value?.sessionId;
  if (typeof sessionId !== "string") throw new Error(`${site.id}_session_missing`);
  try {
    const ready = await client.tool("browser.act", { sessionId, command: { commandId: 1, action: { kind: "wait_for", waitFor: { url: site.url, timeoutMs: 30_000 } } } });
    requireReceipt(ready, `${site.id}_ready_failed`, "met");
    const observed = await client.tool("browser.observe", { sessionId, maxBytes: 16_384 });
    requireSuccess(observed, `${site.id}_observe_failed`);
    const records = await client.tool("browser.observe", { sessionId, mode: "records", maxBytes: 16_384 });
    requireSuccess(records, `${site.id}_records_failed`);
    const snapshotId = records.value?.observation?.snapshotId;
    if (typeof snapshotId !== "string" || !snapshotId) throw new Error(`${site.id}_records_snapshot_missing`);
    const delta = await client.tool("browser.observe", { sessionId, mode: "records", previousSnapshotId: snapshotId, maxBytes: 16_384 });
    requireSuccess(delta, `${site.id}_records_delta_failed`);
    if (delta.value?.observation?.delta?.baseSnapshotId !== snapshotId) throw new Error(`${site.id}_records_delta_base_missing`);
    const document = await client.tool("browser.document.read", { sessionId, maxBytes: 16_384 });
    requireSuccess(document, `${site.id}_document_failed`);
    const text = String(document.value?.observation?.text ?? "");
    if (text.length < 200 || /This site can.t be reached|ERR_BLOCKED_BY_CLIENT|Connection failed/iu.test(text)) throw new Error(`${site.id}_browser_error_surface`);
    if (!text.toLowerCase().includes(site.marker.toLowerCase())) throw new Error(`${site.id}_content_marker_missing`);
    const scrolled = await client.tool("browser.act", { sessionId, command: { commandId: 2, action: { kind: "scroll", x: 0, y: 700 } } });
    requireReceipt(scrolled, `${site.id}_scroll_failed`, "met");
    const restored = await client.tool("browser.act", { sessionId, command: { commandId: 3, action: { kind: "scroll", x: 0, y: -700 } } });
    requireReceipt(restored, `${site.id}_scroll_restore_failed`, "met");
    return { id: site.id, observed: true, records: true, delta: true, documentChars: text.length, scroll: "met", scrollRestore: "met", metrics: client.stats() };
  } finally {
    const stopped = await client.tool("browser.session.stop", { sessionId });
    requireSuccess(stopped, `${site.id}_stop_failed`);
  }
}

function createClient(entry, cwd, childEnv) {
  const child = spawn(process.execPath, [entry], { cwd, env: childEnv, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let buffer = ""; let id = 0; let exited = false; let exitResolve;
  const pending = new Map();
  const metrics = { toolCalls: 0, observeCalls: 0, waitCalls: 0, repairCalls: 0 };
  const exit = new Promise(resolve => { exitResolve = resolve; child.once("close", (code, signal) => { exited = true; for (const waiter of pending.values()) waiter.reject(new Error("packed_real_sites_cli_exited")); pending.clear(); resolve({ code, signal }); }); });
  child.stdout.on("data", chunk => {
    buffer += chunk.toString("utf8");
    while (true) {
      const newline = buffer.indexOf("\n"); if (newline < 0) break;
      const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1); if (!line) continue;
      const message = JSON.parse(line); const waiter = pending.get(message.id); if (!waiter) throw new Error("packed_real_sites_response_unmatched");
      pending.delete(message.id); waiter.resolve(message);
    }
  });
  child.stderr.on("data", () => undefined);
  const request = (method, params) => {
    if (exited) return Promise.reject(new Error("packed_real_sites_cli_exited"));
    const requestId = ++id;
    const promise = new Promise((resolve, reject) => pending.set(requestId, { resolve, reject }));
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params: { ...params, _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {}, "io.modelcontextprotocol/clientInfo": { name: "packed-real-sites", version } } } })}\n`);
    return withTimeout(promise, 60_000, "packed_real_sites_command_timeout");
  };
  return {
    request,
    async tool(name, arguments_) { metrics.toolCalls++; if (name === "browser.observe") metrics.observeCalls++; if (name === "browser.act" && arguments_?.command?.action?.kind === "wait_for") metrics.waitCalls++; const reply = await request("tools/call", { name, arguments: arguments_ }); const text = reply.result?.content?.find(entry => entry.type === "text")?.text; if (typeof text !== "string") throw new Error("packed_real_sites_tool_result_invalid"); return { envelope: reply.result, value: JSON.parse(text) }; },
    stats() { return { ...metrics }; },
    async close() { child.stdin.end(); const result = await withTimeout(exit, 30_000, "packed_real_sites_exit_timeout"); if (result.code !== 0 || result.signal !== null) throw new Error("packed_real_sites_cli_exit_failed"); },
    async abort() { if (!exited) child.stdin.end(); await withTimeout(exit, 30_000, "packed_real_sites_abort_timeout").catch(() => { child.kill(); }); },
  };
}

function requireSuccess(result, code) { if (result.envelope?.isError === true || result.value?.errorCode || result.value?.ok === false) throw new Error(`${code}:${result.value?.errorCode ?? result.value?.reason ?? "tool_error"}`); }
function requireReceipt(result, code, state) { requireSuccess(result, code); if (result.value?.postcondition?.state !== state) throw new Error(code); }
function withTimeout(promise, ms, code) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(code)), ms);
    promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}
async function run(command, args, cwd, childEnv) { const result = await new Promise((resolve, reject) => { const child = spawn(command, args, { cwd, env: childEnv, windowsHide: true, stdio: "inherit" }); child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal })); }); if (result.code !== 0 || result.signal !== null) throw new Error("packed_real_sites_install_failed"); }
function npmCli() { const bin = path.dirname(process.execPath); return [path.join(bin, "node_modules", "npm", "bin", "npm-cli.js"), path.join(bin, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")].find(candidate => fs.existsSync(candidate)) ?? path.join(bin, "node_modules", "npm", "bin", "npm-cli.js"); }
