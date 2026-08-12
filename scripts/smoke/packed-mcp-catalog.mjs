import { spawn } from "node:child_process";
import path from "node:path";

const entryIndex = process.argv.indexOf("--entry");
const entry = entryIndex >= 0 ? process.argv[entryIndex + 1] : null;
if (!entry || !path.isAbsolute(entry)) throw new Error("packed_catalog_entry_required");

const child = spawn(process.execPath, [entry], {
  cwd: process.cwd(),
  env: process.env,
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});
let stdout = "";
let stderrTail = "";
let discovered = false;
let catalogVerified = false;
let terminalError = null;

const deadline = setTimeout(() => {
  terminalError ??= new Error("packed_catalog_deadline");
  child.kill();
}, 30_000);
deadline.unref();

child.stderr.on("data", (chunk) => { stderrTail = `${stderrTail}${chunk}`.slice(-4096); });
child.stdout.on("data", (chunk) => {
  stdout += chunk;
  while (true) {
    const newline = stdout.indexOf("\n");
    if (newline < 0) break;
    const line = stdout.slice(0, newline).trim();
    stdout = stdout.slice(newline + 1);
    if (!line) continue;
    let message;
    try { message = JSON.parse(line); } catch { terminalError ??= new Error("packed_catalog_invalid_json"); child.kill(); return; }
    if (message.id === 1) {
      if (!Array.isArray(message.result?.supportedVersions)
        || message.result.supportedVersions.length !== 1
        || message.result.supportedVersions[0] !== "2026-07-28"
        || message.result?._meta?.["io.modelcontextprotocol/serverInfo"]?.name !== "newton-browser") {
        terminalError ??= new Error("packed_catalog_discovery_invalid");
        child.kill();
        return;
      }
      discovered = true;
      send(request(2, "tools/list", {}));
    } else if (message.id === 2) {
      const tools = message.result?.tools;
      if (!Array.isArray(tools) || tools.length !== 10 || tools.some((tool) => typeof tool?.name !== "string" || !tool.name.startsWith("browser."))) {
        terminalError ??= new Error("packed_catalog_tools_invalid");
        child.kill();
        return;
      }
      catalogVerified = true;
      child.stdin.end();
    }
  }
});
child.once("error", (error) => { terminalError ??= error; });

send(request(1, "server/discover", {}));

const exit = await new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
clearTimeout(deadline);
if (terminalError) throw terminalError;
if (!discovered || !catalogVerified || exit.code !== 0 || exit.signal) {
  throw new Error(`packed_catalog_failed:${safeCategory(stderrTail)}`);
}
process.stdout.write(`${JSON.stringify({ ok: true, protocols: 1, tools: 10, browserStarted: false })}\n`);

function request(id, method, params) {
  return {
    jsonrpc: "2.0",
    id,
    method,
    params: {
      ...params,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientCapabilities": {},
        "io.modelcontextprotocol/clientInfo": { name: "packed-catalog", version: "1" },
      },
    },
  };
}

function send(message) {
  if (!child.stdin.destroyed) child.stdin.write(`${JSON.stringify(message)}\n`);
}

function safeCategory(value) {
  if (/direct_cleanup_uncertain/u.test(value)) return "cleanup_uncertain";
  if (/invalid/u.test(value)) return "invalid";
  return "process_exit";
}
