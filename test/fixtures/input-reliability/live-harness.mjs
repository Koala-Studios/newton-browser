import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import os from "node:os";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

import { createDefaultDirectBrowserHost } from "../../../apps/mcp-server/src/browser-runtime/default-direct-host.ts";
import { discoverBrowserExecutable } from "../../../apps/mcp-server/src/browser-runtime/browser-discovery.ts";
import { handleMcpMessage } from "../../../apps/mcp-server/src/mcp-server.ts";
import { resolveLiveBrowserFamily } from "../../../scripts/smoke/live-config.mjs";

const fixtureRoot = path.dirname(fileURLToPath(import.meta.url));

export async function runInputReliabilityLive(name, execute, options = {}) {
  const mainPort = Number(options.mainPort);
  const crossPort = Number(options.crossPort);
  const browserFamily = options.browserFamily ?? resolveLiveBrowserFamily();
  if (![mainPort, crossPort].every((value) => Number.isSafeInteger(value) && value > 0)) throw new Error("live smoke fixture ports must be positive integers");
  const main = await startStaticServer(mainPort);
  const cross = await startStaticServer(crossPort);
  const directRoot = createDirectRoot();
  let host = null;
  let sessionId = "";
  let requestId = 1;
  const origin = `http://127.0.0.1:${mainPort}`;
  const crossOrigin = `http://127.0.0.1:${crossPort}`;
  const mcp = async (tool, args = {}) => {
    if (!host) throw new Error("live browser host is unavailable");
    const response = await handleMcpMessage(host, {
      jsonrpc: "2.0",
      id: requestId++,
      method: "tools/call",
      params: { name: tool, arguments: args, _meta: modernMcpMeta() },
    });
    const text = response?.result?.content?.find((item) => item.type === "text")?.text;
    if (typeof text !== "string") throw new Error(`missing MCP result for ${tool}`);
    return JSON.parse(text);
  };
  try {
    const directExecutable = discoverBrowserExecutable({ family: browserFamily, env: process.env });
    if (!directExecutable) throw new Error("direct_browser_unavailable");
    host = createDefaultDirectBrowserHost({
      ...process.env,
      NEWTON_BROWSER_BROWSER: browserFamily,
      NEWTON_BROWSER_BROWSER_EXECUTABLE: directExecutable.path,
      NEWTON_BROWSER_CONFIG_DIR: directRoot.root,
      NEWTON_BROWSER_PROFILE_STORE_DIR: path.join(directRoot.root, "identities"),
    });
    const started = await mcp("browser.session.start", { origin });
    sessionId = started.sessionId;
    assert(typeof sessionId === "string" && sessionId.length > 0, "session did not start", started);
    const navigated = await mcp("browser.act", {
      sessionId,
      action: { kind: "navigate", url: `${origin}/index.html?frameOrigin=${encodeURIComponent(crossOrigin)}` },
    });
    assert(navigated?.ok !== false, "input fixture navigation failed", navigated);
    const api = {
      host,
      mcp,
      sessionId,
      origin,
      crossOrigin,
      browserFamily,
      resultOf(value) { return value?.result ?? value; },
      statusOf(value) { return value?.errorCode ?? value?.result?.status ?? value?.status; },
      assert,
      log(step, detail = {}) { process.stdout.write(`${JSON.stringify({ smoke: name, step, ...detail })}\n`); },
    };
    api.log("connected", { browserFamily });
    await execute(api);
    api.log("pass", { browserFamily });
  } finally {
    try { if (sessionId) await mcp("browser.session.stop", { sessionId }); } catch {}
    let directCleanupConfirmed = host === null;
    try {
      if (host) { await host.stopAll(); await host.close(); }
      directCleanupConfirmed = true;
    } catch {}
    await Promise.all([closeServer(main), closeServer(cross)]);
    if (directRoot && directCleanupConfirmed) removeDirectRoot(directRoot);
  }
}

function modernMcpMeta() {
  return { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} };
}

function createDirectRoot() {
  const parent = fs.realpathSync.native(os.tmpdir());
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(parent, "newton-direct-input-live-")));
  const stat = fs.lstatSync(root);
  const nonce = randomBytes(32).toString("hex");
  fs.writeFileSync(path.join(root, ".owner"), nonce, { flag: "wx", mode: 0o600 });
  return Object.freeze({ root, parent, nonce, dev: stat.dev, ino: stat.ino });
}

function removeDirectRoot(owned) {
  const resolved = fs.realpathSync.native(owned.root);
  const stat = fs.lstatSync(resolved);
  const marker = path.join(resolved, ".owner");
  const markerStat = fs.lstatSync(marker);
  if (resolved !== owned.root || path.dirname(resolved) !== owned.parent
    || !/^newton-direct-input-live-[^/\\]+$/u.test(path.basename(resolved))
    || !stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== owned.dev || stat.ino !== owned.ino
    || !markerStat.isFile() || markerStat.isSymbolicLink() || fs.readFileSync(marker, "utf8") !== owned.nonce) {
    throw new Error("direct input live cleanup refused");
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}

async function startStaticServer(port) {
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://fixture.local").pathname;
    const requested = pathname === "/" ? "index.html" : pathname.slice(1);
    const file = path.resolve(fixtureRoot, requested);
    const relative = path.relative(fixtureRoot, file);
    if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative) || !fs.existsSync(file)) {
      response.writeHead(404).end("not found");
      return;
    }
    const contentType = path.extname(file) === ".html" ? "text/html; charset=utf-8" : "application/octet-stream";
    response.writeHead(200, { "content-type": contentType, "cache-control": "no-store" });
    fs.createReadStream(file).pipe(response);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return server;
}

function closeServer(server) {
  return new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections?.();
  });
}

async function waitForState(predicate, label, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function assert(condition, message, detail = {}) {
  if (condition) return;
  const error = new Error(message);
  error.detail = detail;
  throw error;
}
