import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { EngineHost } from "../src/browser-runtime/engine-host.ts";
import { createDefaultEngineHost } from "../src/browser-runtime/default-engine-host.ts";
import { discoverBrowserExecutable } from "../src/browser-runtime/browser-discovery.ts";
import { ENGINE_TOOL_CATALOG } from "../src/engine-mcp.ts";
import { bridgeTokenFile, isLoopback, startLoopbackBridge } from "../src/loopback-bridge.ts";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "index.ts");

function temporaryDirectory(t: test.TestContext): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "newton-browser-bridge-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function unlaunchedHost(): EngineHost {
  return new EngineHost(async () => { throw new Error("not_started"); });
}

function post(port: number, body: unknown, headers: Record<string, string> = {}, host = "127.0.0.1"): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const text = JSON.stringify(body);
    const request = http.request({ host, port, path: "/mcp", method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(text), ...headers } }, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
    });
    request.once("error", reject);
    request.end(text);
  });
}

function call(directory: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(resolve => execFile(process.execPath, [CLI, "call", ...args], { env: { ...process.env, NEWTON_BROWSER_CONFIG_DIR: directory }, timeout: 120_000 },
    (error, stdout, stderr) => resolve({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, stdout, stderr })));
}

const LIST = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };

test("the bridge answers only with the bearer token from its user-only file", async (t) => {
  const directory = temporaryDirectory(t);
  const bridge = await startLoopbackBridge({ host: unlaunchedHost(), directory });
  t.after(() => bridge.close());
  assert.equal(bridge.tokenFile, bridgeTokenFile(directory));
  const advertisement = JSON.parse(fs.readFileSync(bridge.tokenFile, "utf8"));
  assert.match(advertisement.token, /^[a-f0-9]{64}$/u);
  assert.equal(advertisement.port, bridge.port);
  if (process.platform !== "win32") assert.equal(fs.statSync(bridge.tokenFile).mode & 0o777, 0o600);

  assert.deepEqual(await post(bridge.port, LIST), { status: 401, body: { error: "bridge_token_required" } });
  assert.equal((await post(bridge.port, LIST, { authorization: `Bearer ${"0".repeat(64)}` })).status, 401);
  assert.equal((await post(bridge.port, LIST, { authorization: advertisement.token })).status, 401, "the scheme is part of the token");
  const listed = await post(bridge.port, LIST, { authorization: `Bearer ${advertisement.token}` });
  assert.equal(listed.status, 200);
  assert.deepEqual((listed.body.result as { tools: { name: string }[] }).tools.map(tool => tool.name), ENGINE_TOOL_CATALOG.map(tool => tool.name), "the same tools as the MCP server");
  // A page in a browser that learned the port is refused even with the token.
  assert.deepEqual(await post(bridge.port, LIST, { authorization: `Bearer ${advertisement.token}`, origin: "https://example.com" }), { status: 403, body: { error: "browser_origin_refused" } });
  const unknown = await post(bridge.port, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "browser.observe", arguments: { sessionId: "missing" } } }, { authorization: `Bearer ${advertisement.token}` });
  assert.equal(unknown.status, 200);
  assert.equal((unknown.body.result as { isError?: boolean }).isError, true);

  await bridge.close();
  assert.equal(fs.existsSync(bridge.tokenFile), false, "closing removes the token file");
});

test("the bridge listens on loopback only and refuses a second bridge on the same data directory", async (t) => {
  const directory = temporaryDirectory(t);
  const bridge = await startLoopbackBridge({ host: unlaunchedHost(), directory });
  t.after(() => bridge.close());
  assert.equal(bridge.url, `http://127.0.0.1:${bridge.port}/mcp`);
  assert.deepEqual(["127.0.0.1", "::1", "::ffff:127.0.0.1", "192.168.1.20", "10.0.0.4", undefined].map(isLoopback), [true, true, true, false, false, false]);
  const external = Object.values(os.networkInterfaces()).flat().find(item => item && item.family === "IPv4" && !item.internal)?.address;
  if (external) await assert.rejects(post(bridge.port, LIST, {}, external), (error: NodeJS.ErrnoException) => error.code === "ECONNREFUSED", `not reachable on ${external}`);
  else t.diagnostic("no non-loopback IPv4 interface to probe");

  // Another process's live bridge owns the file: a second start is refused and leaves it alone.
  const before = fs.readFileSync(bridge.tokenFile, "utf8");
  const parent = process.ppid;
  fs.writeFileSync(bridge.tokenFile, JSON.stringify({ ...JSON.parse(before), pid: parent }), { mode: 0o600 });
  await assert.rejects(startLoopbackBridge({ host: unlaunchedHost(), directory }), (error: { code?: string }) => error.code === "bridge_already_running");
  fs.writeFileSync(bridge.tokenFile, before, { mode: 0o600 });
});

test("a session started through the bridge survives into the next call, and images become files", async (t) => {
  if (!discoverBrowserExecutable({ family: "chrome", env: process.env })) { t.skip("Chrome is unavailable"); return; }
  const directory = temporaryDirectory(t);
  const page = http.createServer((_request, response) => { response.setHeader("content-type", "text/html; charset=utf-8"); response.end("<!doctype html><title>Bridge fixture</title><button>Continue</button>"); });
  await new Promise<void>(resolve => page.listen(0, "127.0.0.1", resolve));
  t.after(() => { page.close(); });
  const bridge = await startLoopbackBridge({ host: createDefaultEngineHost({ ...process.env, NEWTON_BROWSER_CONFIG_DIR: directory }), directory });
  t.after(() => bridge.close());

  const url = `http://127.0.0.1:${(page.address() as { port: number }).port}/`;
  const started = await call(directory, ["browser.session.start", JSON.stringify({ url })]);
  assert.equal(started.code, 0, started.stderr);
  const { sessionId, nextCommandId } = JSON.parse(started.stdout);
  assert.match(sessionId, /^engine_/u);

  const observed = await call(directory, ["browser.observe", JSON.stringify({ sessionId })]);
  assert.equal(observed.code, 0, observed.stderr);
  const observation = JSON.parse(observed.stdout).observation;
  assert.equal(observation.title, "Bridge fixture");
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
});
