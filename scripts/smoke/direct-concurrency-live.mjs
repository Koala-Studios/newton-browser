import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { discoverBrowserExecutable } from "../../apps/mcp-server/src/browser-runtime/browser-discovery.ts";
import { createDefaultDirectBrowserHost } from "../../apps/mcp-server/src/browser-runtime/default-direct-host.ts";
import { listNewtonIdentities, openProfileStore } from "../../apps/mcp-server/src/browser-runtime/profile-store.ts";
import { handleMcpMessage } from "../../apps/mcp-server/src/mcp-server.ts";

const family = process.env.NEWTON_BROWSER_QA_BROWSER === "edge" ? "edge" : "chrome";
const browser = discoverBrowserExecutable({ family, env: process.env });
if (!browser) {
  process.stdout.write(`${JSON.stringify({ ok: false, browserFamily: family, errorCode: "direct_browser_unavailable" })}\n`);
  process.exit(1);
}

const tempParent = fs.realpathSync(os.tmpdir());
const runRoot = fs.mkdtempSync(path.join(tempParent, "newton-direct-concurrency-"));
const ownerNonce = crypto.randomBytes(24).toString("hex");
fs.writeFileSync(path.join(runRoot, ".newton-direct-concurrency-owner"), ownerNonce, { encoding: "utf8", flag: "wx", mode: 0o600 });

const fixtureA = createFixture("wait");
const fixtureB = createFixture("click");
let host;
let requestId = 0;
let receipt;
let failureCode = null;
let inFlightCommands = [];

try {
  const originA = await fixtureA.listen();
  const originB = await fixtureB.listen();
  host = createDefaultDirectBrowserHost({
    ...process.env,
    NEWTON_BROWSER_BROWSER: family,
    NEWTON_BROWSER_BROWSER_EXECUTABLE: browser.path,
    NEWTON_BROWSER_CONFIG_DIR: runRoot,
  });

  const startedA = await tool("browser.session.start", { origin: originA });
  requireSuccess(startedA, "direct_session_a_start_failed");
  const sessionA = requiredSessionId(startedA, "direct_session_a_id_missing");
  await fixtureA.ready;

  const startedB = await tool("browser.session.start", { origin: originB });
  requireSuccess(startedB, "direct_session_b_start_failed");
  const sessionB = requiredSessionId(startedB, "direct_session_b_id_missing");

  const readyStatus = host.getStatus();
  const readyIdentities = listNewtonIdentities(openProfileStore(path.join(runRoot, "identities"))).length;
  if (readyStatus.activeSessionCount !== 2 || readyIdentities !== 2) {
    fail("direct_isolation_not_proved");
  }

  const beforeB = await tool("browser.observe", { sessionId: sessionB, format: "json", maxNodes: 40 });
  requireSuccess(beforeB, "direct_session_b_observe_failed");
  const verifyButton = observationNodes(beforeB.value)
    .find((node) => node.role === "button" && node.name === "Verify B");
  if (typeof verifyButton?.ref !== "string") fail("direct_session_b_ref_missing");

  let waitSettled = false;
  let queuedSettled = false;
  const waitingA = tool("browser.act", {
    sessionId: sessionA,
    action: { kind: "wait_for", waitFor: { text: "A released", timeoutMs: 30_000 } },
  }).finally(() => {
    waitSettled = true;
  });
  const queuedA = tool("browser.observe", {
    sessionId: sessionA,
    format: "json",
    maxNodes: 40,
  }).finally(() => {
    queuedSettled = true;
  });
  inFlightCommands = [waitingA, queuedA];

  // Both direct-host dispatches cross the already-resolved provisioning promise
  // before reaching the per-session pump. Yield exactly once to that state edge.
  await Promise.resolve();
  const pendingStatus = await tool("browser.status", { detail: "full" });
  requireSuccess(pendingStatus, "direct_pending_status_failed");
  const aDiagnostics = diagnosticsFor(pendingStatus.value, sessionA);
  if (aDiagnostics?.runningCommands !== 1 || aDiagnostics.queuedCommands !== 1) {
    fail("direct_fifo_pending_not_proved");
  }
  if (waitSettled || queuedSettled) fail("direct_wait_settled_before_release");

  const clickedB = await tool("browser.act", {
    sessionId: sessionB,
    action: { kind: "click", ref: verifyButton.ref },
  });
  requireSuccess(clickedB, "direct_session_b_click_failed");
  const afterB = await tool("browser.observe", { sessionId: sessionB, format: "json", maxNodes: 40 });
  requireSuccess(afterB, "direct_session_b_verify_failed");
  if (!observationNodes(afterB.value).some((node) => node.role === "button" && node.name === "B verified")) {
    fail("direct_session_b_effect_unverified");
  }
  if (waitSettled || queuedSettled) fail("direct_cross_session_progress_not_proved");

  fixtureA.release();
  const waitedA = await waitingA;
  requireSuccess(waitedA, "direct_session_a_wait_failed");
  const observedA = await queuedA;
  requireSuccess(observedA, "direct_session_a_queued_observe_failed");
  if (!observationNodes(observedA.value).some((node) => node.role === "button" && node.name === "A released")) {
    fail("direct_session_a_transition_unverified");
  }
  if (!Number.isInteger(waitedA.value.sequence)
      || observedA.value.sequence !== waitedA.value.sequence + 1) {
    fail("direct_fifo_sequence_invalid");
  }

  const stoppedA = await tool("browser.session.stop", { sessionId: sessionA });
  requireSuccess(stoppedA, "direct_session_a_stop_failed");
  const stoppedB = await tool("browser.session.stop", { sessionId: sessionB });
  requireSuccess(stoppedB, "direct_session_b_stop_failed");
  if (stoppedA.value.stopped !== true || stoppedB.value.stopped !== true) fail("direct_stop_not_acknowledged");

  const stoppedStatus = host.getStatus();
  const remainingIdentities = listNewtonIdentities(openProfileStore(path.join(runRoot, "identities"))).length;
  if (host.listSessions().length !== 0
      || stoppedStatus.sessionCount !== 0
      || remainingIdentities !== 0
      || stoppedStatus.activeSessionCount !== 0
      || stoppedStatus.cleanupUncertainCount !== 0) {
    fail("direct_cleanup_residue");
  }

  receipt = {
    ok: true,
    browserFamily: family,
    mode: "direct",
    concurrentSessions: 2,
    distinctEphemeralIdentities: 2,
    concurrentRuntimeProcesses: 2,
    pendingWaitProved: true,
    sameSessionQueuedCommands: 1,
    sameSessionFifo: true,
    crossSessionVerifiedProgress: true,
    eventDrivenRelease: true,
    remainingSessions: 0,
    remainingIdentities,
    remainingRuntimeProcesses: 0,
  };
} catch (error) {
  failureCode = safeCode(error);
} finally {
  fixtureA.releaseForCleanup();
  await Promise.allSettled(inFlightCommands);
  let hostCleanupConfirmed = true;
  if (host) {
    try {
      await host.close();
    } catch {
      hostCleanupConfirmed = false;
      failureCode = "direct_concurrency_cleanup_uncertain";
    }
  }
  await fixtureA.close();
  await fixtureB.close();
  if (hostCleanupConfirmed) {
    try {
      removeRunRoot(runRoot, tempParent, ownerNonce);
    } catch {
      failureCode = failureCode ?? "direct_concurrency_cleanup_refused";
    }
  }
}

if (failureCode) {
  process.stdout.write(`${JSON.stringify({ ok: false, browserFamily: family, errorCode: failureCode })}\n`);
  process.exitCode = 1;
} else {
  if (fs.existsSync(runRoot)) {
    process.stdout.write(`${JSON.stringify({ ok: false, browserFamily: family, errorCode: "direct_concurrency_temp_residue" })}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`${JSON.stringify({ ...receipt, remainingTempRoots: 0 })}\n`);
  }
}

async function tool(name, args) {
  const response = await handleMcpMessage(host, {
    jsonrpc: "2.0",
    id: ++requestId,
    method: "tools/call",
    params: { name, arguments: args, _meta: modernMcpMeta() },
  });
  const payload = response?.result;
  const text = payload?.content?.[0]?.text;
  if (typeof text !== "string") fail("direct_mcp_result_invalid");
  try {
    return { envelope: payload, value: JSON.parse(text) };
  } catch {
    fail("direct_mcp_json_invalid");
  }
}

function modernMcpMeta() {
  return { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} };
}

function createFixture(kind) {
  const sockets = new Set();
  let eventStream = null;
  let readyResolve;
  const ready = new Promise((resolve) => {
    readyResolve = resolve;
  });
  const server = http.createServer((request, response) => {
    if (kind === "wait" && request.url === "/events") {
      if (eventStream) {
        response.writeHead(409).end();
        return;
      }
      response.writeHead(200, {
        "cache-control": "no-store",
        connection: "keep-alive",
        "content-type": "text/event-stream",
      });
      response.write(": ready\n\n");
      eventStream = response;
      readyResolve();
      return;
    }
    response.writeHead(200, {
      "cache-control": "no-store",
      "content-type": "text/html; charset=utf-8",
    });
    response.end(kind === "wait"
      ? `<!doctype html><title>Direct concurrency A</title><button id="state" disabled>A waiting</button><script>const stream=new EventSource('/events');stream.onmessage=()=>{stream.close();document.querySelector('#state').textContent='A released';};</script>`
      : `<!doctype html><title>Direct concurrency B</title><button id="verify">Verify B</button><script>document.querySelector('#verify').onclick=(event)=>{event.currentTarget.textContent='B verified';};</script>`);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  return {
    ready,
    async listen() {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string") fail("direct_fixture_unavailable");
      return `http://127.0.0.1:${address.port}`;
    },
    release() {
      if (!eventStream || eventStream.writableEnded) fail("direct_event_stream_not_ready");
      eventStream.write("data: released\n\n");
      eventStream.end();
    },
    releaseForCleanup() {
      if (!eventStream || eventStream.writableEnded) return;
      eventStream.write("data: released\n\n");
      eventStream.end();
    },
    async close() {
      eventStream?.end();
      for (const socket of sockets) socket.destroy();
      if (!server.listening) return;
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function requiredSessionId(started, code) {
  const sessionId = started.value?.sessionId;
  if (typeof sessionId !== "string" || sessionId.length === 0) fail(code);
  return sessionId;
}

function diagnosticsFor(value, sessionId) {
  return Array.isArray(value?.sessionDiagnostics)
    ? value.sessionDiagnostics.find((candidate) => candidate?.sessionId === sessionId)
    : undefined;
}

function requireSuccess(result, code) {
  if (result.envelope?.isError === true) fail(code);
}

function observationNodes(value) {
  return Array.isArray(value?.result?.nodes) ? value.result.nodes : [];
}

function safeCode(error) {
  const value = error && typeof error === "object" && typeof error.code === "string"
    ? error.code
    : error instanceof Error ? error.message : "direct_concurrency_live_failed";
  return /^[a-z][a-z0-9_]{0,79}$/u.test(value) ? value : "direct_concurrency_live_failed";
}

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

function removeRunRoot(root, expectedParent, expectedNonce) {
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("direct_concurrency_cleanup_refused");
  const resolved = fs.realpathSync(root);
  if (path.dirname(resolved) !== expectedParent
      || !/^newton-direct-concurrency-[^/\\]+$/u.test(path.basename(resolved))) {
    throw new Error("direct_concurrency_cleanup_refused");
  }
  const marker = path.join(resolved, ".newton-direct-concurrency-owner");
  const markerStat = fs.lstatSync(marker);
  if (!markerStat.isFile() || markerStat.isSymbolicLink() || fs.readFileSync(marker, "utf8") !== expectedNonce) {
    throw new Error("direct_concurrency_cleanup_refused");
  }
  fs.rmSync(resolved, { recursive: true });
}
