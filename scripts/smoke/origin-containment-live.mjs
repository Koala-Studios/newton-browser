import { createNewtonBrowserHost } from "../../apps/mcp-server/src/bridge.ts";
import { handleMcpMessage } from "../../apps/mcp-server/src/mcp-server.ts";
import { startFixtureServers } from "../../test/fixtures/server.mjs";
import { scheduler } from "node:timers/promises";
import { resolveLiveBrowserTarget, resolveLiveHostPort } from "./live-config.mjs";

const fixturePort = Number(process.env.NEWTON_BROWSER_CONTAINMENT_FIXTURE_PORT ?? 18341);
const hostPort = resolveLiveHostPort();
const browserTarget = resolveLiveBrowserTarget();
let fixture;
let bridge;

try {
  fixture = await startFixtureServers({ port: fixturePort, crossOriginPort: fixturePort + 1 });
  bridge = createNewtonBrowserHost({ browserTarget });
  const listener = await bridge.listen(hostPort, "127.0.0.1");
  await waitFor(() => bridge.getStatus().extensionConnected ? bridge.getStatus() : null, "extension connection", 45_000);
  log("origin_containment_servers_ready", { browserTarget, hostPort: listener.port, origin: fixture.origin, destination: fixture.crossOrigin });

  const restrictedSession = await startSession([fixture.origin], "origin-containment-restricted");
  resultOf(await mcp("browser.act", { sessionId: restrictedSession, action: { kind: "navigate", url: `${fixture.origin}/origin-containment/primary.html` } }));
  const initial = await waitFor(() => {
    const snapshot = fixture.containment.snapshot();
    return snapshot.destinationResourceRequests >= 2 ? snapshot : null;
  }, "read-only destination resources", 10_000);
  assert(initial.destinationApplicationRequests === 0, "read-only resources reached an application endpoint", initial);
  log("read_only_resources_ok", { destinationResourceRequests: initial.destinationResourceRequests, destinationApplicationRequests: 0 });

  fixture.containment.reset();
  for (const [name, marker] of [
    ["Cross-origin fetch mutation", "fetch-dispatched"],
    ["Cross-origin beacon", "beacon-dispatched"],
    ["Cross-origin form mutation", "form-dispatched"],
    ["Cross-origin popup", "popup-dispatched"],
    ["Cross-origin controlled frame", "frame-dispatched"],
    ["Cross-origin worker", "worker-dispatched"],
    ["Cross-origin WebSocket", "websocket-dispatched"],
    ["Cross-origin EventSource", "eventsource-dispatched"],
  ]) {
    const attempted = await mcp("browser.act", { sessionId: restrictedSession, action: { kind: "click", name, exact: true, waitFor: { text: marker } } });
    assertAttemptClassified(attempted, name);
    assertZeroDestinationApplications(name);
  }

  const redirected = await mcp("browser.act", {
    sessionId: restrictedSession,
    action: { kind: "navigate", url: `${fixture.origin}/origin-containment/redirect-to-destination` },
  });
  assertAttemptClassified(redirected, "ungranted redirect");
  assertZeroDestinationApplications("ungranted redirect");
  log("preventive_zero_request_ok", { attemptedPaths: 9, destinationApplicationRequests: 0 });
  await stopSession(restrictedSession);

  fixture.containment.reset();
  const allowedSession = await startSession([fixture.origin, fixture.crossOrigin], "origin-containment-allowed");
  resultOf(await mcp("browser.act", { sessionId: allowedSession, action: { kind: "navigate", url: `${fixture.origin}/origin-containment/primary.html` } }));
  fixture.containment.reset();
  resultOf(await mcp("browser.act", { sessionId: allowedSession, action: { kind: "click", name: "Cross-origin controlled frame", exact: true, waitFor: { text: "frame-dispatched" } } }));
  await waitFor(() => fixture.containment.snapshot().destinationApplicationRequests === 1 ? fixture.containment.snapshot() : null, "allowed destination frame request", 10_000);
  const allowedFrame = await observeUntil(allowedSession, (observation) => (observation.nodes ?? []).some((node) => String(node.name ?? "").includes("frame destination control") && node.frameOrigin === fixture.crossOrigin), "allowed destination frame observation");
  assert((allowedFrame.nodes ?? []).some((node) => String(node.name ?? "").includes("frame destination control") && node.frameOrigin === fixture.crossOrigin), "allowed destination frame was not observable with provenance", allowedFrame);
  log("allowed_frame_ok", { destinationApplicationRequests: 1 });

  fixture.containment.reset();
  resultOf(await mcp("browser.act", { sessionId: allowedSession, action: { kind: "navigate", url: `${fixture.origin}/origin-containment/redirect-to-destination` } }));
  const allowedRedirect = await waitFor(() => fixture.containment.snapshot().destinationApplicationRequests === 1 ? fixture.containment.snapshot() : null, "allowed redirect destination", 10_000);
  assert(allowedRedirect.entries.some((entry) => entry.pathname.endsWith("/redirect.html")), "allowed redirect destination was not recorded", allowedRedirect);
  log("allowed_redirect_ok", { destinationApplicationRequests: allowedRedirect.destinationApplicationRequests });

  await stopSession(allowedSession);
  log("origin_containment_live_pass", { zeroUnintendedRequests: true, allowedOriginContinues: true });
} catch (error) {
  log("origin_containment_live_fail", { message: error?.message ?? String(error), detail: error?.detail });
  process.exitCode = 1;
} finally {
  try { bridge?.stopAll(); await bridge?.close(); } catch {}
  try { await fixture?.close(); } catch {}
}

async function startSession(allowedOrigins, instanceLabel) {
  const started = await mcp("browser.session.start", {
    origin: fixture.origin,
    allowedOrigins,
    tabMode: "owned_group",
    goal: "preventive origin containment live proof",
    instanceLabel,
  });
  assert(started.sessionId, "containment session did not start", started);
  await waitFor(async () => {
    const listed = await mcp("browser.tabs.list", {});
    return listed.sessions?.some((session) => session.sessionId === started.sessionId && session.ownedTabId) ? listed : null;
  }, "containment session binding", 20_000);
  return started.sessionId;
}

async function stopSession(sessionId) {
  const stopped = await mcp("browser.session.stop", { sessionId });
  assert(stopped.stopped === true, "containment session did not stop", stopped);
}

function assertAttemptClassified(result, label) {
  const status = result?.errorCode ?? result?.result?.errorCode ?? result?.result?.status ?? result?.status ?? result?.result?.actionStatus;
  const outcome = result?.outcome ?? result?.result?.outcome;
  assert(outcome === "prevented" || ["blocked", "prevented", "ungranted_navigation", "origin_not_granted"].includes(status), `${label} was not classified as prevented`, result);
}

function assertZeroDestinationApplications(label) {
  const snapshot = fixture.containment.snapshot();
  assert(snapshot.destinationApplicationRequests === 0, `${label} reached the destination application`, snapshot);
}

async function mcp(name, args) {
  const response = await handleMcpMessage(bridge, { jsonrpc: "2.0", id: Math.floor(Math.random() * 1e9), method: "tools/call", params: { name, arguments: args } });
  const text = response?.result?.content?.find((item) => item.type === "text")?.text;
  assert(typeof text === "string", `missing MCP result for ${name}`, response);
  return JSON.parse(text);
}

async function observeUntil(sessionId, predicate, label) {
  return waitFor(async () => {
    const observation = resultOf(await mcp("browser.observe", { sessionId, format: "json", maxNodes: 240 }));
    return predicate(observation) ? observation : null;
  }, label, 10_000);
}

async function waitFor(predicate, label, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await scheduler.yield();
  }
  throw new Error(`timed out waiting for ${label}`);
}

function resultOf(value) {
  assert(value?.ok !== false, "MCP tool failed", value);
  return value.result ?? value;
}

function assert(condition, message, detail = {}) {
  if (condition) return;
  const error = new Error(message);
  error.detail = detail;
  throw error;
}

function log(step, detail = {}) {
  console.log(JSON.stringify({ step, ...detail }));
}
