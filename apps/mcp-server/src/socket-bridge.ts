// `newton-browser bridge`: the MCP tools over HTTP on a Unix domain socket, for an agent whose MCP
// connection to Newton Browser dropped, so it can keep driving its own sessions. One engine serves every
// request, so sessions persist across calls. There is no TCP listener: the socket is `bridge.sock` (0600)
// in the app data directory (0700), and every request also needs the bearer token in `bridge.json` (0600)
// beside it. `newton-browser call <tool> '<json>'` reads that file and makes one call over the socket.
import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";

import { ensureConfigDirectory } from "./config.ts";
import type { EngineHost } from "./browser-runtime/engine-host.ts";
import { ENGINE_INSTRUCTIONS, handleEngineMcp } from "./engine-mcp.ts";
import { MAX_MCP_IN_FLIGHT_REQUESTS, MAX_MCP_LINE_BYTES, type JsonRpcId, type ModernMcpRequest, type ModernMcpResponse } from "./modern-mcp-stdio.ts";
import { NEWTON_BROWSER_VERSION } from "./package-metadata.ts";

export const BRIDGE_PATH = "/mcp";
const BRIDGE_FILE = "bridge.json";
const BRIDGE_SOCKET = "bridge.sock";
const BRIDGE_FILE_VERSION = 2;
// sun_path holds 104 bytes on macOS and 108 on Linux, including the terminator.
const SUN_PATH_BYTES = process.platform === "darwin" ? 104 : 108;
// The longest browser call is a 120 s command; the client waits a little longer for its receipt.
const CALL_TIMEOUT_MS = 150_000;

export type BridgeAdvertisement = Readonly<{ version: number; socket: string; token: string; pid: number; engine: string }>;
export type SocketBridge = Readonly<{ socket: string; tokenFile: string; close(): Promise<void> }>;

export function bridgeTokenFile(directory: string): string { return path.join(directory, BRIDGE_FILE); }
export function bridgeSocketPath(directory: string): string { return path.join(directory, BRIDGE_SOCKET); }

/** Serve the engine's MCP tools on `bridge.sock` in the data directory. Each request is one JSON-RPC message
 * POSTed to /mcp with `Authorization: Bearer <token>` from `bridge.json`. Close stops every session. */
export async function startSocketBridge(input: { host: EngineHost; directory: string }): Promise<SocketBridge> {
  if (process.platform === "win32") throw bridgeError("bridge_platform_unsupported", "the bridge needs a Unix domain socket");
  const directory = ensureConfigDirectory(input.directory);
  const tokenFile = bridgeTokenFile(directory);
  const socket = bridgeSocketPath(directory);
  if (Buffer.byteLength(socket) >= SUN_PATH_BYTES) throw bridgeError("bridge_socket_path_too_long", `${socket} is longer than a Unix socket path can be; set NEWTON_BROWSER_CONFIG_DIR to a shorter directory`);
  const running = readAdvertisement(tokenFile);
  if (running && running.pid !== process.pid && processAlive(running.pid)) throw bridgeError("bridge_already_running", `pid ${running.pid}`);
  await clearStaleSocket(socket);
  const token = randomBytes(32).toString("hex");
  const expected = Buffer.from(`Bearer ${token}`);
  let inFlight = 0;
  const server = http.createServer((request, response) => {
    void serve(request, response).catch(() => { if (!response.headersSent) reply(response, 500, { error: "bridge_failed" }); else response.destroy(); });
  });
  const serve = async (request: http.IncomingMessage, response: http.ServerResponse) => {
    // A page in a browser sends Origin; nothing there may reach the engine, token or not.
    if (request.headers.origin !== undefined) return reply(response, 403, { error: "browser_origin_refused" });
    const authorization = Buffer.from(String(request.headers.authorization ?? ""));
    if (authorization.length !== expected.length || !timingSafeEqual(authorization, expected)) return reply(response, 401, { error: "bridge_token_required" });
    if (request.method !== "POST" || new URL(request.url ?? "/", "http://bridge").pathname !== BRIDGE_PATH) return reply(response, 404, { error: "not_found" });
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
  // Created readable and writable by this user only, inside a directory only this user can enter.
  const umask = process.umask(0o177);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen({ path: socket, exclusive: true }, () => { server.off("error", reject); resolve(); });
    });
  } finally { process.umask(umask); }
  try {
    fs.chmodSync(socket, 0o600);
    writeAdvertisement(tokenFile, { version: BRIDGE_FILE_VERSION, socket, token, pid: process.pid, engine: NEWTON_BROWSER_VERSION });
  } catch (error) { await closeServer(server); removeSocket(socket); throw error; }
  let closing: Promise<void> | undefined;
  return Object.freeze({
    socket, tokenFile,
    close: () => closing ??= (async () => {
      // Only this bridge's own file: another may have started since.
      if (readAdvertisement(tokenFile)?.token === token) fs.rmSync(tokenFile, { force: true });
      server.closeAllConnections();
      await closeServer(server);
      removeSocket(socket);
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
  const socket = bridgeSocketPath(input.directory);
  const reply = await post(socket, advertisement.token, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: input.tool, arguments: input.args } })
    .catch(() => { throw bridgeError("bridge_unreachable", `nothing answers on ${socket}; start it with: newton-browser bridge`); });
  const body = isObject(reply.body) ? reply.body : undefined;
  if (reply.status !== 200 || !body) throw bridgeError("bridge_refused", `HTTP ${reply.status}${body && typeof body.error === "string" ? ` ${body.error}` : ""}`);
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

/** One JSON request over the bridge socket. */
export function post(socket: string, token: string | undefined, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const text = JSON.stringify(body);
    const request = http.request({ socketPath: socket, path: BRIDGE_PATH, method: "POST", headers: {
      "content-type": "application/json", "content-length": String(Buffer.byteLength(text)), ...(token === undefined ? {} : { authorization: `Bearer ${token}` }), ...headers } }, response => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.once("end", () => {
        clearTimeout(timer);
        let parsed: unknown;
        try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { parsed = undefined; }
        resolve({ status: response.statusCode ?? 0, body: parsed });
      });
      response.once("error", reject);
    });
    const timer = setTimeout(() => request.destroy(new Error("bridge_timeout")), CALL_TIMEOUT_MS);
    request.once("error", error => { clearTimeout(timer); reject(error); });
    request.end(text);
  });
}

/** A socket left by a bridge that is gone is removed; a live one, or anything that is not a socket, is kept. */
async function clearStaleSocket(socket: string): Promise<void> {
  let stat: fs.Stats;
  try { stat = fs.lstatSync(socket); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  if (!stat.isSocket()) throw bridgeError("bridge_socket_path_occupied", `${socket} is not a socket`);
  const answers = await new Promise<boolean>(resolve => {
    const probe = net.connect({ path: socket });
    probe.once("connect", () => { probe.destroy(); resolve(true); });
    probe.once("error", () => resolve(false));
  });
  if (answers) throw bridgeError("bridge_already_running", socket);
  removeSocket(socket);
}

function removeSocket(socket: string): void {
  try { if (fs.lstatSync(socket).isSocket()) fs.rmSync(socket, { force: true }); } catch { /* already gone */ }
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
    if (!isObject(value) || value.version !== BRIDGE_FILE_VERSION || typeof value.socket !== "string" || typeof value.token !== "string"
      || !/^[a-f0-9]{64}$/u.test(value.token) || !Number.isSafeInteger(value.pid) || typeof value.engine !== "string") return undefined;
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
