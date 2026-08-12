import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { discoverBrowserExecutable } from "../../apps/mcp-server/src/browser-runtime/browser-discovery.ts";

const PACKAGE_VERSION = JSON.parse(fs.readFileSync("apps/mcp-server/package.json", "utf8")).version;
if (typeof PACKAGE_VERSION !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(PACKAGE_VERSION)) {
  throw new Error("packed_package_version_invalid");
}
const TAR_NAME = `newton-browser-${PACKAGE_VERSION}.tgz`;
const INSTALL_DEADLINE_MS = 120_000;
const COMMAND_DEADLINE_MS = 30_000;
const EXIT_DEADLINE_MS = 30_000;
const MAX_LINE_BYTES = 2 * 1024 * 1024;
const MAX_CAPTURE_BYTES = 64 * 1024;
const TEMP_PREFIX = "newton packed direct ";
const OWNER_MARKER = ".newton-packed-direct-owner";

const family = process.env.NEWTON_BROWSER_QA_BROWSER === "edge" ? "edge" : "chrome";
const tempParent = fs.realpathSync.native(os.tmpdir());
const tempOwnership = createOwnedTempRoot(tempParent);
const runRoot = tempOwnership.root;
const installRoot = path.join(runRoot, "Packed CLI Install");
const configRoot = path.join(runRoot, "Newton Identity Config");
const profileStoreRoot = path.join(runRoot, "Newton Identity Store");
const tarball = path.resolve("artifacts", TAR_NAME);
let fixture = null;
let denied = null;
let client = null;
let deniedRequests = 0;
let receipt = null;
let failureCode = null;

try {
  requireState(fs.existsSync(tarball), "packed_artifact_missing");
  const packedArtifactBytes = fs.statSync(tarball).size;
  const packedArtifactSha256 = createHash("sha256").update(fs.readFileSync(tarball)).digest("hex");
  fs.mkdirSync(installRoot, { recursive: true });
  fs.writeFileSync(path.join(installRoot, "package.json"), JSON.stringify({
    name: "newton-packed-direct-runtime-check",
    private: true,
  }));

  const isolatedEnv = identityEnvironment(runRoot, configRoot, profileStoreRoot);
  await runInstall(isolatedEnv);
  const entry = path.join(installRoot, "node_modules", "newton-browser", "dist", "index.js");
  requireState(fs.existsSync(entry), "packed_entry_missing");

  denied = http.createServer((_request, response) => {
    deniedRequests += 1;
    response.statusCode = 204;
    response.end();
  });
  const deniedAddress = await listen(denied);
  const deniedUrl = `http://127.0.0.1:${deniedAddress.port}/must-not-arrive`;

  fixture = http.createServer((_request, response) => {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(`<!doctype html><meta charset="utf-8"><title>Packed direct fixture</title>
      <button onclick="this.textContent='Verified'">Direct action</button>
      <button onclick="location.href='${deniedUrl}'">Blocked navigation</button>`);
  });
  const fixtureAddress = await listen(fixture);
  const origin = `http://127.0.0.1:${fixtureAddress.port}`;
  const browserExecutable = installedBrowser(family);
  requireState(browserExecutable !== null, "direct_browser_unavailable");

  client = createMcpClient(entry, {
    ...isolatedEnv,
    NEWTON_BROWSER_BROWSER: family,
    NEWTON_BROWSER_BROWSER_EXECUTABLE: browserExecutable,
  });
  const discovered = await client.request("server/discover", {});
  requireState(Array.isArray(discovered?.result?.supportedVersions)
    && discovered.result.supportedVersions.length === 1
    && discovered.result.supportedVersions[0] === "2026-07-28", "packed_discovery_failed");

  const status = await client.tool("browser.status", {});
  requireSuccess(status, "packed_direct_status_failed");
  requireState(status.value?.mode === "direct"
    && status.value?.configured === true
    && status.value?.ready === true
    && status.value?.runtimeState === "idle", "packed_direct_idle_status_invalid");

  const started = await client.tool("browser.session.start", { origin });
  requireSuccess(started, "packed_direct_session_start_failed");
  const sessionId = started.value?.sessionId;
  requireState(typeof sessionId === "string" && sessionId.length > 0, "packed_direct_session_id_missing");
  const activeStatus = await client.tool("browser.status", {});
  requireSuccess(activeStatus, "packed_direct_active_status_failed");
  requireState(activeStatus.value?.ready === true && activeStatus.value?.runtimeState === "ready", "packed_direct_not_ready");

  const observed = await client.tool("browser.observe", { sessionId, format: "json", maxNodes: 80 });
  requireSuccess(observed, "packed_direct_observe_failed");
  const actionButton = observationNodes(observed.value).find((node) => node.role === "button" && node.name === "Direct action");
  requireState(typeof actionButton?.ref === "string", "packed_direct_action_ref_missing");

  const clicked = await client.tool("browser.act", {
    sessionId,
    action: { kind: "click", ref: actionButton.ref },
  });
  requireSuccess(clicked, "packed_direct_click_failed");
  requireState(clicked.value?.status === "verified", "packed_direct_click_unverified");

  const verified = await client.tool("browser.observe", { sessionId, format: "json", maxNodes: 80 });
  requireSuccess(verified, "packed_direct_verify_failed");
  const nodes = observationNodes(verified.value);
  requireState(nodes.some((node) => node.role === "button" && node.name === "Verified"), "packed_direct_effect_unverified");
  const blockedButton = nodes.find((node) => node.role === "button" && node.name === "Blocked navigation");
  requireState(typeof blockedButton?.ref === "string", "packed_direct_blocked_ref_missing");

  const contained = await client.tool("browser.act", {
    sessionId,
    action: { kind: "click", ref: blockedButton.ref },
  });
  const containmentOutcome = contained.value?.outcome;
  requireState(contained.envelope?.isError !== true
    && containmentOutcome === "completed"
    && contained.value?.retrySafe === false
    && contained.value?.status === "verified", "packed_direct_denied_outcome_invalid");
  requireState(deniedRequests === 0, "packed_direct_denied_request_leaked");

  const stopped = await client.tool("browser.session.stop", { sessionId });
  requireSuccess(stopped, "packed_direct_stop_failed");
  requireState(stopped.value?.stopped === true, "packed_direct_stop_unacknowledged");
  requireState(remainingIdentityDirectories(profileStoreRoot) === 0, "packed_direct_identity_residue");
  const sessions = await client.tool("browser.sessions.list", {});
  requireSuccess(sessions, "packed_direct_session_list_failed");
  requireState(Array.isArray(sessions.value?.sessions) && sessions.value.sessions.length === 0, "packed_direct_session_residue");

  const exit = await client.close();
  requireState(exit.code === 0 && exit.signal === null, "packed_direct_cli_exit_failed");
  client = null;
  receipt = {
    ok: true,
    browserFamily: family,
    packedArtifactExact: true,
    packedArtifactBytes,
    packedArtifactSha256,
    scriptsDisabled: true,
    isolatedIdentityRoot: true,
    configuredIdle: true,
    directReadyAfterStart: true,
    sessionStarted: true,
    jsonObserved: true,
    clickVerified: true,
    containmentOutcome,
    navigationBoundaryEnforced: true,
    deniedDestinationRequests: 0,
    sessionStopped: true,
    remainingSessions: 0,
    childExited: true,
    processCleanupConfirmed: true,
  };
} catch (error) {
  failureCode = safeCode(error);
  process.exitCode = 1;
} finally {
  let clientCleanupConfirmed = true;
  if (client) {
    clientCleanupConfirmed = await client.abort();
    if (!clientCleanupConfirmed) {
      failureCode = "packed_direct_process_cleanup_uncertain";
      receipt = null;
    }
  }
  if (fixture) await closeServer(fixture);
  if (denied) await closeServer(denied);
  if (clientCleanupConfirmed) {
    try {
      await removeRunRoot(tempOwnership);
    } catch {
      failureCode = "packed_direct_temp_cleanup_failed";
      receipt = null;
      process.exitCode = 1;
    }
  }
}

if (receipt && !fs.existsSync(runRoot)) {
  process.stdout.write(`${JSON.stringify({ ...receipt, tempCleanupConfirmed: true })}\n`);
} else {
  process.stdout.write(`${JSON.stringify({
    ok: false,
    browserFamily: family,
    errorCode: failureCode ?? "packed_direct_runtime_failed",
    deniedDestinationRequests: Math.min(deniedRequests, 64),
    tempCleanupConfirmed: !fs.existsSync(runRoot),
  })}\n`);
}

function createMcpClient(entry, environment) {
  const child = spawn(process.execPath, [entry], {
    cwd: installRoot,
    env: environment,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let nextId = 0;
  let stdoutBuffer = Buffer.alloc(0);
  let stderrBytes = 0;
  let exited = false;
  const pending = new Map();
  let exitResult = { code: null, signal: null };
  const closePromise = new Promise((resolve) => {
    child.once("exit", (code, signal) => {
      exited = true;
      exitResult = { code, signal };
      for (const waiter of pending.values()) waiter.reject(coded("packed_direct_cli_exited"));
      pending.clear();
    });
    child.once("close", () => resolve(exitResult));
  });
  child.once("error", () => {
    for (const waiter of pending.values()) waiter.reject(coded("packed_direct_cli_spawn_failed"));
    pending.clear();
  });
  child.stderr.on("data", (chunk) => {
    stderrBytes = Math.min(MAX_CAPTURE_BYTES, stderrBytes + Math.min(Buffer.byteLength(chunk), MAX_CAPTURE_BYTES));
  });
  child.stdout.on("data", (chunk) => {
    stdoutBuffer = Buffer.concat([stdoutBuffer, Buffer.from(chunk)]);
    if (stdoutBuffer.length > MAX_LINE_BYTES) {
      terminalFail("packed_direct_mcp_output_exceeded");
      return;
    }
    while (true) {
      const newline = stdoutBuffer.indexOf(0x0a);
      if (newline < 0) break;
      const line = stdoutBuffer.subarray(0, newline).toString("utf8").trim();
      stdoutBuffer = stdoutBuffer.subarray(newline + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { terminalFail("packed_direct_mcp_output_invalid"); return; }
      const waiter = pending.get(message?.id);
      if (!waiter) { terminalFail("packed_direct_mcp_response_unmatched"); return; }
      pending.delete(message.id);
      waiter.resolve(message);
    }
  });

  function terminalFail(code) {
    for (const waiter of pending.values()) waiter.reject(coded(code));
    pending.clear();
    if (!exited) child.stdin.end();
  }

  async function request(method, params) {
    requireState(!exited && child.stdin.writable, "packed_direct_cli_unavailable");
    const id = ++nextId;
    const response = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": {},
          "io.modelcontextprotocol/clientInfo": { name: "packed-direct-runtime", version: PACKAGE_VERSION },
        },
      },
    })}\n`);
    return deadline(response, COMMAND_DEADLINE_MS, "packed_direct_mcp_timeout");
  }

  return {
    request,
    async tool(name, args) {
      const response = await request("tools/call", { name, arguments: args });
      const envelope = response?.result;
      const text = envelope?.content?.[0]?.text;
      requireState(typeof text === "string", "packed_direct_tool_result_invalid");
      let value;
      try { value = JSON.parse(text); } catch { throw coded("packed_direct_tool_json_invalid"); }
      return { envelope, value };
    },
    async close() {
      if (!exited) child.stdin.end();
      return deadline(closePromise, EXIT_DEADLINE_MS, "packed_direct_cli_exit_timeout");
    },
    async abort() {
      if (!exited) {
        child.stdin.end();
        try {
          const result = await deadline(closePromise, EXIT_DEADLINE_MS, "packed_direct_cli_abort_timeout");
          return result.code === 0 && result.signal === null;
        } catch {
          child.kill();
          await deadline(closePromise, EXIT_DEADLINE_MS, "packed_direct_cli_abort_timeout").catch(() => {});
          return false;
        }
      }
      const result = await deadline(closePromise, EXIT_DEADLINE_MS, "packed_direct_cli_abort_timeout").catch(() => null);
      void stderrBytes;
      return result?.code === 0 && result.signal === null;
    },
  };
}

async function runInstall(environment) {
  const child = spawn(process.execPath, [npmCli(), "install", "--ignore-scripts", "--no-audit", "--no-fund", "--offline", tarball], {
    cwd: installRoot,
    env: cleanPackageManagerEnv(environment),
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let capturedBytes = 0;
  child.stdout.on("data", (chunk) => { capturedBytes = Math.min(MAX_CAPTURE_BYTES, capturedBytes + Math.min(Buffer.byteLength(chunk), MAX_CAPTURE_BYTES)); });
  child.stderr.on("data", (chunk) => { capturedBytes = Math.min(MAX_CAPTURE_BYTES, capturedBytes + Math.min(Buffer.byteLength(chunk), MAX_CAPTURE_BYTES)); });
  const exit = await deadline(new Promise((resolve, reject) => {
    child.once("error", () => reject(coded("packed_install_spawn_failed")));
    child.once("close", (code, signal) => resolve({ code, signal }));
  }), INSTALL_DEADLINE_MS, "packed_install_timeout", () => child.kill());
  void capturedBytes;
  requireState(exit.code === 0 && exit.signal === null, "packed_install_failed");
}

function identityEnvironment(root, config, store) {
  return {
    ...process.env,
    npm_config_cache: path.join(root, "NPM Cache"),
    NEWTON_BROWSER_CONFIG_DIR: config,
    NEWTON_BROWSER_PROFILE_STORE_DIR: store,
  };
}

function listen(server) {
  return new Promise((resolve, reject) => {
    const onError = () => reject(coded("packed_direct_fixture_unavailable"));
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      const address = server.address();
      if (!address || typeof address === "string") reject(coded("packed_direct_fixture_unavailable"));
      else resolve(address);
    });
  });
}

function closeServer(server) {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve) => server.close(() => resolve()));
}

function remainingIdentityDirectories(storeRoot) {
  if (!fs.existsSync(storeRoot)) return 0;
  return fs.readdirSync(storeRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^nbi_[a-f0-9]{32}$/u.test(entry.name))
    .length;
}

function observationNodes(value) {
  return Array.isArray(value?.result?.nodes) ? value.result.nodes : [];
}

function requireSuccess(result, code) {
  if (result.envelope?.isError === true) {
    const bounded = typeof result.value?.errorCode === "string" && /^[a-z][a-z0-9_]{0,79}$/u.test(result.value.errorCode)
      ? result.value.errorCode
      : code;
    throw coded(bounded);
  }
}

function requireState(condition, code) {
  if (!condition) throw coded(code);
}

function coded(code) {
  return Object.assign(new Error(code), { code });
}

function safeCode(error) {
  const value = error && typeof error === "object" && typeof error.code === "string" ? error.code : "packed_direct_runtime_failed";
  return /^[a-z][a-z0-9_]{0,79}$/u.test(value) ? value : "packed_direct_runtime_failed";
}

function deadline(promise, milliseconds, code, onTimeout = () => {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout();
      reject(coded(code));
    }, milliseconds);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

function npmCli() {
  const bin = path.dirname(process.execPath);
  const candidates = [
    path.join(bin, "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(bin, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];
}

function installedBrowser(browserFamily) {
  return discoverBrowserExecutable({ family: browserFamily, env: process.env })?.path ?? null;
}

function cleanPackageManagerEnv(environment) {
  const output = { ...environment, npm_config_update_notifier: "false" };
  delete output.npm_config_verify_deps_before_run;
  return output;
}

function createOwnedTempRoot(expectedParent) {
  const created = fs.mkdtempSync(path.join(expectedParent, TEMP_PREFIX));
  const resolved = fs.realpathSync.native(created);
  const stat = fs.lstatSync(resolved);
  requireState(stat.isDirectory() && !stat.isSymbolicLink() && path.dirname(resolved) === expectedParent, "packed_direct_temp_identity_invalid");
  const nonce = randomBytes(32).toString("hex");
  fs.writeFileSync(path.join(resolved, OWNER_MARKER), nonce, { encoding: "utf8", flag: "wx", mode: 0o600 });
  return Object.freeze({ root: resolved, expectedParent, nonce, dev: stat.dev, ino: stat.ino });
}

async function removeRunRoot(ownership) {
  const currentParent = fs.realpathSync.native(os.tmpdir());
  const stat = fs.lstatSync(ownership.root);
  const resolved = fs.realpathSync.native(ownership.root);
  const marker = path.join(resolved, OWNER_MARKER);
  const markerStat = fs.lstatSync(marker);
  const valid = currentParent === ownership.expectedParent
    && resolved === ownership.root
    && path.dirname(resolved) === ownership.expectedParent
    && path.basename(resolved).startsWith(TEMP_PREFIX)
    && stat.isDirectory()
    && !stat.isSymbolicLink()
    && stat.dev === ownership.dev
    && stat.ino === ownership.ino
    && markerStat.isFile()
    && !markerStat.isSymbolicLink()
    && fs.readFileSync(marker, "utf8") === ownership.nonce;
  if (!valid) {
    throw coded("packed_direct_temp_cleanup_refused");
  }
  await fs.promises.rm(resolved, { recursive: true, force: true });
}
