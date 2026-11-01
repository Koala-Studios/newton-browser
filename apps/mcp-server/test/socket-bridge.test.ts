import test from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { EngineHost } from "../src/browser-runtime/engine-host.ts";
import { discoverBrowserExecutable } from "../src/browser-runtime/browser-discovery.ts";
import { ENGINE_TOOL_CATALOG } from "../src/engine-mcp.ts";
import { bridgeSocketPath, bridgeTokenFile, post, startSocketBridge } from "../src/socket-bridge.ts";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "index.ts");
const unix = process.platform !== "win32";

// A short directory: a Unix socket path holds at most 104 bytes on macOS.
function dataDirectory(t: test.TestContext): string {
  const directory = fs.mkdtempSync("/tmp/nbb-");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function unlaunchedHost(): EngineHost {
  return new EngineHost(async () => { throw new Error("not_started"); });
}

function call(directory: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(resolve => execFile(process.execPath, [CLI, "call", ...args], { env: { ...process.env, NEWTON_BROWSER_CONFIG_DIR: directory }, timeout: 120_000 },
    (error, stdout, stderr) => resolve({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, stdout, stderr })));
}

/** TCP sockets the process listens on: lsof on macOS, /proc on Linux. */
function tcpListeners(pid: number): string[] | undefined {
  if (process.platform === "darwin") {
    try { return execFileSync("lsof", ["-nP", "-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN"], { encoding: "utf8" }).split("\n").slice(1).filter(Boolean); }
    catch (error) { return (error as { status?: number }).status === 1 ? [] : undefined; }
  }
  if (process.platform !== "linux") return undefined;
  const inodes = new Set(fs.readdirSync(`/proc/${pid}/fd`).flatMap(fd => {
    try { return [/^socket:\[(\d+)\]$/u.exec(fs.readlinkSync(`/proc/${pid}/fd/${fd}`))?.[1] ?? ""]; } catch { return []; }
  }).filter(Boolean));
  return ["/proc/net/tcp", "/proc/net/tcp6"].flatMap(file => fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").slice(1) : [])
    .map(line => line.trim().split(/\s+/u)).filter(fields => fields[3] === "0A" && inodes.has(fields[9] ?? "")).map(fields => fields.join(" "));
}

const LIST = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };

test("the bridge is a user-only socket in the data directory and answers only with the bearer token", { skip: !unix && "Unix domain sockets" }, async (t) => {
  const directory = dataDirectory(t);
  const bridge = await startSocketBridge({ host: unlaunchedHost(), directory });
  t.after(() => bridge.close());
  assert.equal(bridge.socket, bridgeSocketPath(directory));
  assert.equal(bridge.tokenFile, bridgeTokenFile(directory));
  assert.ok(fs.lstatSync(bridge.socket).isSocket());
  assert.equal(fs.statSync(directory).mode & 0o777, 0o700, "data directory");
  assert.equal(fs.lstatSync(bridge.socket).mode & 0o777, 0o600, "socket");
  assert.equal(fs.statSync(bridge.tokenFile).mode & 0o777, 0o600, "token file");
  const advertisement = JSON.parse(fs.readFileSync(bridge.tokenFile, "utf8"));
  assert.match(advertisement.token, /^[a-f0-9]{64}$/u);
  assert.equal(advertisement.port, undefined, "no port");

  assert.deepEqual(await post(bridge.socket, undefined, LIST), { status: 401, body: { error: "bridge_token_required" } });
  assert.equal((await post(bridge.socket, "0".repeat(64), LIST)).status, 401);
  assert.equal((await post(bridge.socket, undefined, LIST, { authorization: advertisement.token })).status, 401, "the scheme is part of the token");
  const listed = await post(bridge.socket, advertisement.token, LIST);
  assert.equal(listed.status, 200);
  assert.deepEqual((listed.body as { result: { tools: { name: string }[] } }).result.tools.map(tool => tool.name), ENGINE_TOOL_CATALOG.map(tool => tool.name), "the same tools as the MCP server");
  // A browser page never gets in, token or not.
  assert.deepEqual(await post(bridge.socket, advertisement.token, LIST, { origin: "https://example.com" }), { status: 403, body: { error: "browser_origin_refused" } });

  await bridge.close();
  assert.equal(fs.existsSync(bridge.socket), false, "closing removes the socket");
  assert.equal(fs.existsSync(bridge.tokenFile), false, "and the token file");
});

test("one bridge per data directory; a socket left by a killed bridge is cleared", { skip: !unix && "Unix domain sockets" }, async (t) => {
  const directory = dataDirectory(t);
  const socket = bridgeSocketPath(directory);
  // A process killed while listening leaves its socket file behind.
  const holder = spawn(process.execPath, ["-e", `require("node:net").createServer().listen(${JSON.stringify(socket)},()=>console.log("up"))`], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise(resolve => holder.stdout.once("data", resolve));
  await assert.rejects(startSocketBridge({ host: unlaunchedHost(), directory }), (error: { code?: string }) => error.code === "bridge_already_running", "a socket that answers is a running bridge");
  holder.kill("SIGKILL");
  await new Promise(resolve => holder.once("exit", resolve));
  assert.ok(fs.lstatSync(socket).isSocket(), "the killed listener left its socket");

  const bridge = await startSocketBridge({ host: unlaunchedHost(), directory });
  t.after(() => bridge.close());
  await assert.rejects(startSocketBridge({ host: unlaunchedHost(), directory }), (error: { code?: string }) => error.code === "bridge_already_running");
  await bridge.close();
  fs.writeFileSync(socket, "not a socket");
  await assert.rejects(startSocketBridge({ host: unlaunchedHost(), directory }), (error: { code?: string }) => error.code === "bridge_socket_path_occupied", "anything else at the path is kept");
});

test("the bridge opens no TCP port, and a session started through it survives into the next call", { skip: !unix && "Unix domain sockets" }, async (t) => {
  if (!discoverBrowserExecutable({ family: "chrome", env: process.env })) { t.skip("Chrome is unavailable"); return; }
  const directory = dataDirectory(t);
  const page = http.createServer((_request, response) => { response.setHeader("content-type", "text/html; charset=utf-8"); response.end("<!doctype html><title>Bridge fixture</title><button>Continue</button>"); });
  await new Promise<void>(resolve => page.listen(0, "127.0.0.1", resolve));
  t.after(() => { page.close(); });
  const env = { ...process.env, NEWTON_BROWSER_CONFIG_DIR: directory };
  delete env.NEWTON_BROWSER_EGRESS;
  const bridge = spawn(process.execPath, [CLI, "bridge"], { env, stdio: ["ignore", "pipe", "inherit"] });
  const exited = new Promise<number | null>(resolve => bridge.once("exit", resolve));
  t.after(async () => { if (bridge.exitCode === null) { bridge.kill("SIGTERM"); await exited; } });
  const listening = JSON.parse(await new Promise<string>(resolve => { let text = ""; bridge.stdout.on("data", chunk => { text += chunk; if (text.includes("\n")) resolve(text.split("\n")[0]!); }); }));
  assert.deepEqual([listening.state, listening.socket], ["listening", bridgeSocketPath(directory)]);
  assert.equal(listening.url, undefined);

  const url = `http://127.0.0.1:${(page.address() as { port: number }).port}/`;
  const started = await call(directory, ["browser.session.start", JSON.stringify({ url })]);
  assert.equal(started.code, 0, started.stderr);
  const { sessionId, nextCommandId } = JSON.parse(started.stdout);
  assert.match(sessionId, /^engine_/u);
  const listeners = tcpListeners(bridge.pid!);
  if (listeners === undefined) t.diagnostic("no way to list this platform's TCP listeners");
  else assert.deepEqual(listeners, [], "the bridge process listens on no TCP port, with a session running");

  const observed = await call(directory, ["browser.observe", JSON.stringify({ sessionId })]);
  assert.equal(observed.code, 0, observed.stderr);
  const observation = JSON.parse(observed.stdout).observation;
  assert.equal(observation.title, "Bridge fixture", "the session from the first call process");
  const button = observation.nodes.find((node: { name: string }) => node.name === "Continue");
  const clicked = await call(directory, ["browser.act", JSON.stringify({ sessionId, command: { commandId: nextCommandId, action: { kind: "click", target: { kind: "ref", ref: button.ref, snapshotId: observation.snapshotId } } } })]);
  assert.equal(JSON.parse(clicked.stdout).reason, "completed", clicked.stdout);

  const out = path.join(directory, "images");
  const shot = await call(directory, ["browser.screenshot", JSON.stringify({ sessionId }), "--out", out]);
  assert.equal(shot.code, 0, shot.stderr);
  const images = JSON.parse(shot.stdout).images as { path: string; mimeType: string }[];
  assert.equal(images.length, 1);
  assert.equal(path.dirname(images[0]!.path), out);
  assert.deepEqual([...fs.readFileSync(images[0]!.path).subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], "a PNG file");
  assert.doesNotMatch(shot.stdout, /"data"/u, "pixels go to the file, not the output");

  const missing = await call(directory, ["browser.observe", JSON.stringify({ sessionId: "engine_missing" })]);
  assert.equal(missing.code, 1, "a tool error exits non-zero and still prints its result");
  assert.ok(JSON.parse(missing.stdout).errorCode);
  const listed = await call(directory, ["browser.sessions.list"]);
  assert.deepEqual(JSON.parse(listed.stdout).sessions.map((session: { sessionId: string }) => session.sessionId), [sessionId]);

  bridge.kill("SIGTERM");
  assert.equal(await exited, 0);
  assert.equal(fs.existsSync(bridgeSocketPath(directory)), false, "stopping removes the socket");
  assert.equal(fs.existsSync(bridgeTokenFile(directory)), false, "and the token file");
  const after = await call(directory, ["browser.sessions.list"]);
  assert.equal(after.code, 1);
  assert.match(after.stderr, /bridge_not_running/u);
});
