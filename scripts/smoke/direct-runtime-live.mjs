import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";

import { discoverBrowserExecutable } from "../../apps/mcp-server/src/browser-runtime/browser-discovery.ts";
import { createDefaultDirectBrowserHost } from "../../apps/mcp-server/src/browser-runtime/default-direct-host.ts";
import { handleMcpMessage } from "../../apps/mcp-server/src/mcp-server.ts";

const family = process.env.NEWTON_BROWSER_QA_BROWSER === "edge" ? "edge" : "chrome";
const browser = discoverBrowserExecutable({ family, env: process.env });
if (!browser) {
  process.stdout.write(`${JSON.stringify({ ok: false, browserFamily: family, errorCode: "direct_browser_unavailable" })}\n`);
  process.exit(1);
}
logStep("direct_runtime_browser_discovered");

const tempRoot = fs.realpathSync.native(os.tmpdir());
const runOwnership = createRunRoot(tempRoot);
const runRoot = runOwnership.root;
let destinationApplicationRequests = 0;
const destination = http.createServer((request, response) => {
  if (request.url === "/arrive") destinationApplicationRequests += 1;
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end("<!doctype html><title>Cross-origin destination</title><main>destination-ready</main>");
});
let destinationUrl = "";
const fixture = http.createServer((_request, response) => {
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end(`<!doctype html><title>Newton Direct Live</title>
    <button onclick="this.textContent='Verified'">Direct action</button>
    <button onclick="location.href='${destinationUrl}'">Cross-origin navigation</button>
    <button id="ref-churn" type="button">Churn refs</button>
    <section id="ref-churn-nodes"></section>
    <script>
      let refGeneration = 0;
      const refNodes = document.querySelector('#ref-churn-nodes');
      const renderRefGeneration = () => {
        refNodes.replaceChildren(...Array.from({ length: 260 }, (_, index) => {
          const button = document.createElement('button');
          button.type = 'button';
          button.textContent = 'Generated ' + refGeneration + ' control ' + index;
          return button;
        }));
      };
      document.querySelector('#ref-churn').addEventListener('click', () => {
        refGeneration += 1;
        renderRefGeneration();
      });
      renderRefGeneration();
    </script>`);
});
let origin = "";
let host = null;
let requestId = 0;
let receipt = null;
let terminalFailure = null;
let cleanupConfirmed = false;

try {
  await new Promise((resolve, reject) => {
    destination.once("error", reject);
    destination.listen(0, "127.0.0.1", resolve);
  });
  const destinationAddress = destination.address();
  if (!destinationAddress || typeof destinationAddress === "string") fail("direct_destination_fixture_unavailable");
  destinationUrl = `http://127.0.0.1:${destinationAddress.port}/arrive`;
  await new Promise((resolve, reject) => {
    fixture.once("error", reject);
    fixture.listen(0, "127.0.0.1", resolve);
  });
  const address = fixture.address();
  if (!address || typeof address === "string") fail("direct_fixture_unavailable");
  origin = `http://127.0.0.1:${address.port}`;
  host = createDefaultDirectBrowserHost({
    ...process.env,
    NEWTON_BROWSER_BROWSER: family,
    NEWTON_BROWSER_BROWSER_EXECUTABLE: browser.path,
    NEWTON_BROWSER_CONFIG_DIR: runRoot,
  });
  const status = await tool("browser.status", {});
  requireSuccess(status, "direct_idle_status_failed");
  if (status.value.configured !== true || status.value.ready !== true || status.value.runtimeState !== "idle") {
    fail("direct_idle_status_invalid");
  }
  logStep("direct_runtime_idle_verified");
  let started;
  try {
    started = await tool("browser.session.start", { origin });
  } catch (error) {
    logStep(`direct_runtime_start_${safeDirectStartFailure({ errorCode: safeCode(error) })}`);
    throw error;
  }
  if (started.envelope?.isError === true) {
    logStep(`direct_runtime_start_${safeDirectStartFailure(started.value)}`);
  }
  requireSuccess(started, "direct_session_start_failed");
  const sessionId = started.value.sessionId;
  if (typeof sessionId !== "string") fail("direct_session_id_missing");
  logStep("direct_runtime_session_started");
  const activeStatus = await tool("browser.status", {});
  requireSuccess(activeStatus, "direct_active_status_failed");
  if (activeStatus.value.ready !== true || activeStatus.value.runtimeState !== "ready") fail("direct_active_status_invalid");

  const observed = await tool("browser.observe", { sessionId, format: "json", maxNodes: 80 });
  requireSuccess(observed, "direct_observe_failed");
  const button = observationNodes(observed.value).find((node) => node.role === "button" && node.name === "Direct action");
  if (typeof button?.ref !== "string") fail("direct_button_ref_missing");
  logStep("direct_runtime_observed");

  const acted = await tool("browser.act", { sessionId, action: { kind: "click", ref: button.ref } });
  requireSuccess(acted, "direct_action_failed");
  const verified = await tool("browser.observe", { sessionId, format: "json", maxNodes: 80 });
  requireSuccess(verified, "direct_verify_failed");
  const effectVerified = observationNodes(verified.value).some((node) => node.role === "button" && node.name === "Verified");
  if (!effectVerified) fail("direct_effect_unverified");
  logStep("direct_runtime_action_verified");

  for (let cycle = 0; cycle < 4; cycle += 1) {
    requireSuccess(await tool("browser.act", {
      sessionId,
      action: { kind: "click", selector: "#ref-churn" },
    }), "direct_ref_cycle_action_failed");
    requireSuccess(await tool("browser.observe", {
      sessionId,
      format: "json",
      maxNodes: 250,
    }), "direct_ref_cycle_observe_failed");
  }
  logStep("direct_runtime_ref_budget_recycled");

  const navigationObservation = await tool("browser.observe", {
    sessionId,
    format: "json",
    maxNodes: 10,
    query: "Cross-origin navigation",
  });
  requireSuccess(navigationObservation, "direct_cross_origin_observe_failed");
  const navigationButton = observationNodes(navigationObservation.value).find((node) => node.role === "button" && node.name === "Cross-origin navigation");
  if (typeof navigationButton?.ref !== "string") fail("direct_cross_origin_ref_missing");
  requireSuccess(await tool("browser.act", { sessionId, action: { kind: "click", ref: navigationButton.ref } }), "direct_cross_origin_action_failed");
  requireSuccess(await tool("browser.act", { sessionId, action: { kind: "wait_for", waitFor: { text: "destination-ready", timeoutMs: 10_000 } } }), "direct_cross_origin_navigation_failed");
  if (destinationApplicationRequests !== 1) fail("direct_cross_origin_request_missing");
  logStep("direct_runtime_cross_origin_verified");

  const stopped = await tool("browser.session.stop", { sessionId });
  requireSuccess(stopped, "direct_stop_failed");
  if (stopped.value.stopped !== true || host.listSessions().length !== 0) fail("direct_cleanup_failed");
  receipt = {
    ok: true,
    browserFamily: family,
    mode: status.value.mode,
    configuredIdle: true,
    runtimeReadyAfterStart: true,
    observedRef: true,
    actionResultStatus: acted.value.status,
    effectVerified,
    refBudgetRecycled: true,
    refBudgetCycles: 4,
    crossOriginNavigation: "completed",
    destinationApplicationRequests: 1,
    stopped: true,
    remainingSessions: 0,
  };
} catch (error) {
  const errorCode = safeCode(error);
  logStep(`direct_runtime_failure_${safeDirectRuntimeFailure(errorCode)}`);
  terminalFailure = error;
  process.exitCode = 1;
} finally {
  try { if (host) await host.close(); cleanupConfirmed = true; } catch {
    terminalFailure = Object.assign(new Error("direct_cleanup_uncertain"), { code: "direct_cleanup_uncertain" });
    process.exitCode = 1;
  }
  await new Promise((resolve) => fixture.close(resolve));
  await new Promise((resolve) => destination.close(resolve));
  if (cleanupConfirmed) {
    try { removeRunRoot(runOwnership); } catch {
      terminalFailure = Object.assign(new Error("direct_runtime_temp_cleanup_refused"), { code: "direct_runtime_temp_cleanup_refused" });
      process.exitCode = 1;
    }
  }
}

process.stdout.write(`${JSON.stringify(terminalFailure ? {
  ok: false,
  browserFamily: family,
  errorCode: safeCode(terminalFailure),
  cleanupConfirmed,
  temporaryRootRemoved: !fs.existsSync(runRoot),
} : {
  ...receipt,
  cleanupConfirmed: true,
  temporaryRootRemoved: true,
})}\n`);

async function tool(name, args) {
  if (!host) fail("direct_host_unavailable");
  const response = await handleMcpMessage(host, {
    jsonrpc: "2.0",
    id: ++requestId,
    method: "tools/call",
    params: { name, arguments: args, _meta: modernMcpMeta() },
  });
  const payload = response?.result;
  const text = payload?.content?.[0]?.text;
  if (typeof text !== "string") fail("direct_mcp_result_invalid");
  return { envelope: payload, value: JSON.parse(text) };
}

function modernMcpMeta() {
  return { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} };
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
    : error instanceof Error ? error.message : "direct_live_failed";
  return /^[a-z][a-z0-9_]{0,79}$/u.test(value) ? value : "direct_live_failed";
}

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

function logStep(step) {
  process.stdout.write(`${JSON.stringify({ step })}\n`);
}

function safeDirectStartFailure(value) {
  const candidate = value?.errorCode;
  return new Set([
    "configured_browser_unavailable",
    "configured_identity_create_failed",
    "configured_identity_unavailable",
    "configured_profile_store_invalid",
    "configured_profile_store_required",
    "configured_runtime_start_failed",
    "configured_runtime_start_uncertain",
    "direct_cleanup_uncertain",
    "direct_driver_start_failed",
    "owned_browser_runtime_failed",
  ]).has(candidate) ? candidate : "unknown";
}

function safeDirectRuntimeFailure(candidate) {
  return new Set([
    "direct_action_failed",
    "direct_active_status_failed",
    "direct_active_status_invalid",
    "direct_button_ref_missing",
    "direct_cleanup_failed",
    "direct_cross_origin_action_failed",
    "direct_cross_origin_navigation_failed",
    "direct_cross_origin_ref_missing",
    "direct_cross_origin_request_missing",
    "direct_effect_unverified",
    "direct_host_unavailable",
    "direct_mcp_result_invalid",
    "direct_observe_failed",
    "direct_session_id_missing",
    "direct_session_start_failed",
    "direct_stop_failed",
    "direct_verify_failed",
  ]).has(candidate) ? candidate : safeDirectStartFailure({ errorCode: candidate });
}

function createRunRoot(parent) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(parent, "newton-direct-live-")));
  const stat = fs.lstatSync(root);
  const nonce = randomBytes(32).toString("hex");
  fs.writeFileSync(path.join(root, ".owner"), nonce, { flag: "wx", mode: 0o600 });
  return Object.freeze({ root, parent, nonce, dev: stat.dev, ino: stat.ino });
}

function removeRunRoot(owned) {
  const resolved = fs.realpathSync.native(owned.root);
  const stat = fs.lstatSync(resolved);
  const marker = path.join(resolved, ".owner");
  const markerStat = fs.lstatSync(marker);
  if (resolved !== owned.root || path.dirname(resolved) !== owned.parent
    || !/^newton-direct-live-[^/\\]+$/u.test(path.basename(resolved))
    || !stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== owned.dev || stat.ino !== owned.ino
    || !markerStat.isFile() || markerStat.isSymbolicLink() || fs.readFileSync(marker, "utf8") !== owned.nonce) {
    throw new Error("direct_live_cleanup_refused");
  }
  fs.rmSync(resolved, { recursive: true });
}
