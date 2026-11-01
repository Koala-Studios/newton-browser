// `newton-browser bridge`: the MCP tools over loopback HTTP, for an agent whose MCP connection to Newton
// Browser is down. One engine serves every request, so sessions persist across calls. It listens on
// 127.0.0.1 only and needs the bearer token it writes, readable by this user only, to the app data
// directory on start. `newton-browser call <tool> '<json>'` reads that file and makes one call.
import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

import { ensureConfigDirectory } from "./config.ts";
import type { EngineHost } from "./browser-runtime/engine-host.ts";
import { ENGINE_INSTRUCTIONS, handleEngineMcp } from "./engine-mcp.ts";
import { MAX_MCP_IN_FLIGHT_REQUESTS, MAX_MCP_LINE_BYTES, type JsonRpcId, type ModernMcpRequest, type ModernMcpResponse } from "./modern-mcp-stdio.ts";
import { NEWTON_BROWSER_VERSION } from "./package-metadata.ts";

export const BRIDGE_PATH = "/mcp";
const BRIDGE_FILE = "bridge.json";
const BRIDGE_FILE_VERSION = 1;
// The longest browser call is a 120 s command; the client waits a little longer for its receipt.
const CALL_TIMEOUT_MS = 150_000;

export type BridgeAdvertisement = Readonly<{ version: number; port: number; token: string; pid: number; engine: string }>;
export type LoopbackBridge = Readonly<{ port: number; url: string; tokenFile: string; close(): Promise<void> }>;

export function bridgeTokenFile(directory: string): string { return path.join(directory, BRIDGE_FILE); }

/** Serve the engine's MCP tools at http://127.0.0.1:<port>/mcp. Each request is one JSON-RPC message with
 * `Authorization: Bearer <token>`; the token is in the file this writes. Close stops every session. */
export async function startLoopbackBridge(input: { host: EngineHost; directory: string; port?: number }): Promise<LoopbackBridge> {
  const directory = ensureConfigDirectory(input.directory);
  const tokenFile = bridgeTokenFile(directory);
  const running = readAdvertisement(tokenFile);
  if (running && running.pid !== process.pid && processAlive(running.pid)) throw bridgeError("bridge_already_running", `a bridge (pid ${running.pid}) serves port ${running.port}`);
  const port = input.port ?? 0;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw bridgeError("bridge_invalid_arguments");
  const token = randomBytes(32).toString("hex");
  const expected = Buffer.from(`Bearer ${token}`);
  let inFlight = 0;
  const server = http.createServer((request, response) => {
    void serve(request, response).catch(() => { if (!response.headersSent) reply(response, 500, { error: "bridge_failed" }); else response.destroy(); });
  });
  const serve = async (request: http.IncomingMessage, response: http.ServerResponse) => {
    // Bound to loopback; refuse anything else that still arrives, and pages in a browser (which send Origin).
    if (!isLoopback(request.socket.remoteAddress)) return reply(response, 403, { error: "loopback_only" });
    if (request.headers.origin !== undefined) return reply(response, 403, { error: "browser_origin_refused" });
    const authorization = Buffer.from(String(request.headers.authorization ?? ""));
    if (authorization.length !== expected.length || !timingSafeEqual(authorization, expected)) return reply(response, 401, { error: "bridge_token_required" });
    if (request.method !== "POST" || new URL(request.url ?? "/", "http://127.0.0.1").pathname !== BRIDGE_PATH) return reply(response, 404, { error: "not_found" });
    if (inFlight >= MAX_MCP_IN_FLIGHT_REQUESTS) return reply(response, 503, { error: "bridge_busy" });
    inFlight++;
    const controller = new AbortController();
    // A client that hangs up cancels its call, as closing the MCP connection would.
    response.on("close", () => { if (!response.writableFinished) controller.abort(); });
    try {
      let message: unknown;
      try { message = JSON.parse((await readBody(request)).toString("utf8")); }
      catch (error) { return reply(response, (error as { code?: string }).code === "body_too_large" ? 413 : 400, rpcError(null, -32700, "Parse error.")); }
      if (!isRequest(message)) return reply(response, 400, rpcError(isObject(message) && isId(message.id) ? message.id : null, -32600, "Invalid request."));
      const answer = await handle(input.host, message, controller.signal);
      if (controller.signal.aborted) return;
      reply(response, 200, answer ?? rpcError(message.id, -32800, "Request cancelled."));
    } finally { inFlight--; }
  };
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  const bound = typeof address === "object" && address ? address.port : 0;
  try { writeAdvertisement(tokenFile, { version: BRIDGE_FILE_VERSION, port: bound, token, pid: process.pid, engine: NEWTON_BROWSER_VERSION }); }
  catch (error) { await closeServer(server); throw error; }
  let closing: Promise<void> | undefined;
  return Object.freeze({
    port: bound, url: `http://127.0.0.1:${bound}${BRIDGE_PATH}`, tokenFile,
    close: () => closing ??= (async () => {
      // Only this bridge's own file: another may have started since.
      if (readAdvertisement(tokenFile)?.token === token) fs.rmSync(tokenFile, { force: true });
      server.closeAllConnections();
      await closeServer(server);
      try { await input.host.stopAll(); } finally { await input.host.close(); }
    })(),
  });
}

/** The bridge answers the tool methods of a stateless or a classic MCP client, one message per request. */
async function handle(host: EngineHost, message: ModernMcpRequest, signal: AbortSignal): Promise<ModernMcpResponse | null> {
  if (message.method === "initialize") {
    return { jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-11-25", capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "newton-browser", version: NEWTON_BROWSER_VERSION }, instructions: ENGINE_INSTRUCTIONS } };
  }
  if (message.method === "ping") return { jsonrpc: "2.0", id: message.id, result: {} };
  if (!["server/discover", "tools/list", "tools/call"].includes(message.method)) return rpcError(message.id, -32601, "Unsupported MCP method.");
  const { cursor: _cursor, ...params } = isObject(message.params) ? message.params : {};
  return handleEngineMcp(host, { ...message, params: { _meta: {}, ...params } }, { signal });
}

/** One tool call through a running bridge: the result's JSON, with each image written to a file in `out` and
 * listed under `images` instead of its pixels. */
export async function callBridge(input: { directory: string; tool: string; args: unknown; out: string }): Promise<{ output: Record<string, unknown>; isError: boolean }> {
  const advertisement = readAdvertisement(bridgeTokenFile(input.directory));
  if (!advertisement) throw bridgeError("bridge_not_running", "start it with: newton-browser bridge");
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${advertisement.port}${BRIDGE_PATH}`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${advertisement.token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: input.tool, arguments: input.args } }),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
  } catch { throw bridgeError("bridge_unreachable", `nothing answers on 127.0.0.1:${advertisement.port}; start it with: newton-browser bridge`); }
  const body = await response.json().catch(() => undefined) as Record<string, unknown> | undefined;
  if (!response.ok || !body) throw bridgeError("bridge_refused", `HTTP ${response.status}${body && typeof body.error === "string" ? ` ${body.error}` : ""}`);
  if (isObject(body.error)) throw bridgeError("bridge_call_failed", typeof body.error.message === "string" ? body.error.message : "");
  const result = isObject(body.result) ? body.result : {};
  const content = Array.isArray(result.content) ? result.content.filter(isObject) : [];
  const texts = content.filter(block => block.type === "text" && typeof block.text === "string").map(block => String(block.text));
  let output: Record<string, unknown>;
  try { const parsed: unknown = texts.length === 1 ? JSON.parse(texts[0]!) : undefined; output = isObject(parsed) ? parsed : { text: texts }; }
  catch { output = { text: texts }; }
  const images: { path: string; mimeType: string }[] = [];
  for (const block of content) {
    if (block.type !== "image" || typeof block.data !== "string" || typeof block.mimeType !== "string") continue;
    fs.mkdirSync(input.out, { recursive: true, mode: 0o700 });
    const extension = block.mimeType === "image/jpeg" ? "jpg" : block.mimeType === "image/webp" ? "webp" : "png";
    const file = path.join(input.out, `newton-browser-${Date.now()}-${randomBytes(4).toString("hex")}.${extension}`);
    fs.writeFileSync(file, Buffer.from(block.data, "base64"), { mode: 0o600, flag: "wx" });
    images.push({ path: file, mimeType: block.mimeType });
  }
  return { output: images.length ? { ...output, images } : output, isError: result.isError === true };
}

function readAdvertisement(file: string): BridgeAdvertisement | undefined {
  let raw: string;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) return undefined;
    raw = fs.readFileSync(file, "utf8");
  } catch { return undefined; }
  try {
    const value: unknown = JSON.parse(raw);
    if (!isObject(value) || value.version !== BRIDGE_FILE_VERSION || !Number.isSafeInteger(value.port) || Number(value.port) < 1 || Number(value.port) > 65535
      || typeof value.token !== "string" || !/^[a-f0-9]{64}$/u.test(value.token) || !Number.isSafeInteger(value.pid) || typeof value.engine !== "string") return undefined;
    return value as BridgeAdvertisement;
  } catch { return undefined; }
}

function writeAdvertisement(file: string, advertisement: BridgeAdvertisement): void {
  const temporary = `${file}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    // Created readable by this user only, then moved into place whole.
    fs.writeFileSync(temporary, `${JSON.stringify(advertisement)}\n`, { mode: 0o600, flag: "wx" });
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, file);
  } catch (error) { fs.rmSync(temporary, { force: true }); throw error; }
}

function readBody(request: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    request.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_MCP_LINE_BYTES) { request.destroy(); reject(Object.assign(new Error("body_too_large"), { code: "body_too_large" })); return; }
      chunks.push(chunk);
    });
    request.once("end", () => resolve(Buffer.concat(chunks)));
    request.once("error", reject);
  });
}

function reply(response: http.ServerResponse, status: number, body: unknown): void {
  if (response.headersSent || response.destroyed) return;
  const text = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text), "cache-control": "no-store" });
  response.end(text);
}

function rpcError(id: JsonRpcId | null, code: number, message: string) {
  return { jsonrpc: "2.0" as const, ...(id === null ? {} : { id }), error: { code, message } };
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise(resolve => server.close(() => resolve()));
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

export function isLoopback(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function isRequest(value: unknown): value is ModernMcpRequest {
  return isObject(value) && value.jsonrpc === "2.0" && isId(value.id) && typeof value.method === "string" && value.method.length > 0 && value.method.length <= 120
    && (value.params === undefined || isObject(value.params));
}

function isId(value: unknown): value is JsonRpcId {
  return (typeof value === "string" && value.length <= 120) || (typeof value === "number" && Number.isSafeInteger(value));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function bridgeError(code: string, detail?: string): Error & { code: string } {
  return Object.assign(new Error(detail ? `${code}: ${detail}` : code), { code });
}
