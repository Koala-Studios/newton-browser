import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createNewtonBrowserHost } from "../../../apps/mcp-server/src/bridge.ts";
import { handleMcpMessage } from "../../../apps/mcp-server/src/mcp-server.ts";
import { resolveLiveBrowserTarget, resolveLiveHostPort } from "../../../scripts/smoke/live-config.mjs";

const fixtureRoot = path.dirname(fileURLToPath(import.meta.url));

export async function runInputReliabilityLive(name, execute, options = {}) {
  const mainPort = Number(options.mainPort);
  const crossPort = Number(options.crossPort);
  const hostPort = options.hostPort === undefined ? resolveLiveHostPort() : Number(options.hostPort);
  const browserTarget = options.browserTarget ?? resolveLiveBrowserTarget();
  if (![mainPort, crossPort].every((value) => Number.isSafeInteger(value) && value > 0)
    || (hostPort !== undefined && (!Number.isSafeInteger(hostPort) || hostPort < 17_321 || hostPort > 17_340))) {
    throw new Error("live smoke fixture ports must be positive integers and the optional host port must be within 17321-17340");
  }
  const main = await startStaticServer(mainPort);
  const cross = await startStaticServer(crossPort);
  const bridge = createNewtonBrowserHost({ browserTarget });
  let sessionId = "";
  let requestId = 1;
  const origin = `http://127.0.0.1:${mainPort}`;
  const crossOrigin = `http://127.0.0.1:${crossPort}`;
  const mcp = async (tool, args = {}) => {
    const response = await handleMcpMessage(bridge, {
      jsonrpc: "2.0",
      id: requestId++,
      method: "tools/call",
      params: { name: tool, arguments: args },
    });
    const text = response?.result?.content?.find((item) => item.type === "text")?.text;
    if (typeof text !== "string") throw new Error(`missing MCP result for ${tool}`);
    return JSON.parse(text);
  };
  try {
    const listener = await bridge.listen(hostPort, "127.0.0.1");
    await waitForState(() => bridge.getStatus().extensionConnected === true, "extension connection", 45_000);
    const started = await mcp("browser.session.start", {
      origin,
      allowedOrigins: [origin, crossOrigin],
      tabMode: "owned_group",
      goal: name,
      instanceLabel: name,
    });
    sessionId = started.sessionId;
    assert(typeof sessionId === "string" && sessionId.length > 0, "session did not start", started);
    const navigated = await mcp("browser.act", {
      sessionId,
      action: { kind: "navigate", url: `${origin}/index.html?frameOrigin=${encodeURIComponent(crossOrigin)}` },
    });
    assert(navigated?.ok !== false, "input fixture navigation failed", navigated);
    const api = {
      bridge,
      mcp,
      sessionId,
      origin,
      crossOrigin,
      browserTarget,
      hostPort: listener.port,
      resultOf(value) { return value?.result ?? value; },
      statusOf(value) { return value?.errorCode ?? value?.result?.actionStatus ?? value?.result?.status ?? value?.status; },
      assert,
      log(step, detail = {}) { process.stdout.write(`${JSON.stringify({ smoke: name, step, ...detail })}\n`); },
    };
    api.log("connected", { browserTarget, hostPort: listener.port });
    await execute(api);
    api.log("pass", { browserTarget, hostPort: listener.port });
  } finally {
    try { if (sessionId) await mcp("browser.session.stop", { sessionId }); } catch {}
    try { bridge.stopAll(); await bridge.close(); } catch {}
    await Promise.all([closeServer(main), closeServer(cross)]);
  }
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
