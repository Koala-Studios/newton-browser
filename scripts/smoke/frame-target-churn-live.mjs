import { createNewtonBrowserHost } from "../../apps/mcp-server/src/bridge.ts";
import { handleMcpMessage } from "../../apps/mcp-server/src/mcp-server.ts";
import { startFixtureServers } from "../../test/fixtures/server.mjs";
import { scheduler } from "node:timers/promises";
import { resolveLiveBrowserTarget, resolveLiveHostPort } from "./live-config.mjs";

const fixturePort = Number(process.env.NEWTON_BROWSER_FRAME_FIXTURE_PORT ?? 18331);
const hostPort = resolveLiveHostPort();
const browserTarget = resolveLiveBrowserTarget();
let fixture;
let bridge;

try {
  fixture = await startFixtureServers({ port: fixturePort, crossOriginPort: fixturePort + 1, thirdOriginPort: fixturePort + 2 });
  bridge = createNewtonBrowserHost({ browserTarget });
  const listener = await bridge.listen(hostPort, "127.0.0.1");
  await waitFor(() => bridge.getStatus().extensionConnected ? bridge.getStatus() : null, "extension connection", 45_000);
  log("frame_churn_servers_ready", { browserTarget, hostPort: listener.port, origin: fixture.origin, crossOrigin: fixture.crossOrigin, thirdOrigin: fixture.thirdOrigin });

  const restrictedSession = await startSession([fixture.origin], "frame-excluded-provenance");
  const restricted = await observeUntil(restrictedSession, (observation) => hasName(observation, "Same-origin frame button") && (observation.excludedFrames ?? []).some((frame) => frame.frameOrigin === fixture.crossOrigin), "excluded OOPIF provenance");
  assert(hasName(restricted, "Same-origin frame button"), "same-origin frame was not observable", restricted);
  assert(!hasName(restricted, "Granted-OOPIF-1 frame button"), "ungranted OOPIF nodes escaped containment", restricted);
  assert((restricted.excludedFrames ?? []).some((frame) => frame.frameOrigin === fixture.crossOrigin && frame.reason === "origin_not_granted"), "excluded OOPIF provenance missing", restricted);
  log("excluded_frame_provenance_ok", { excludedFrames: restricted.excludedFrames });
  await stopSession(restrictedSession);

  const allowedSession = await startSession([fixture.origin, fixture.crossOrigin, fixture.thirdOrigin], "frame-allowed-provenance");
  let observed = await observeUntil(allowedSession, (observation) => hasName(observation, "Granted-OOPIF-1 frame button") && hasName(observation, "Nested-OOPIF frame button"), "allowed nested OOPIF observation");
  const crossButton = nodeByNameAndOrigin(observed, "Granted-OOPIF-1 frame button", fixture.crossOrigin);
  const nestedButton = nodeByNameAndOrigin(observed, "Nested-OOPIF frame button", fixture.thirdOrigin);
  assert(/^d\d+:f\d+:e\d+$/.test(crossButton.ref), "OOPIF ref was not frame-qualified", crossButton);
  assert(/^d\d+:f\d+:e\d+$/.test(nestedButton.ref), "nested OOPIF ref was not frame-qualified", nestedButton);
  resultOf(await mcp("browser.act", { sessionId: allowedSession, action: { kind: "click", target: { ref: nestedButton.ref } } }));
  log("nested_oopif_route_ok", { crossRef: crossButton.ref, nestedRef: nestedButton.ref });

  const staleTarget = nodeByNameAndOrigin(observed, "Frame stale target", fixture.crossOrigin);
  const rerender = nodeByNameAndOrigin(observed, "Rerender frame target", fixture.crossOrigin);
  resultOf(await mcp("browser.act", { sessionId: allowedSession, action: { kind: "click", target: { ref: rerender.ref }, waitFor: { text: "frame-target-rerendered" } } }));
  const staleResult = await mcp("browser.act", { sessionId: allowedSession, action: { kind: "click", target: { ref: staleTarget.ref } } });
  assertStale(staleResult, "rerendered child-frame ref");
  log("frame_rerender_stale_ref_ok", { ref: staleTarget.ref, status: statusOf(staleResult) });

  observed = resultOf(await mcp("browser.observe", { sessionId: allowedSession, format: "json", maxNodes: 320 }));
  const beforeReplace = nodeByNameAndOrigin(observed, "Granted-OOPIF-1 frame button", fixture.crossOrigin);
  const nestedBeforeReplace = nodeByNameAndOrigin(observed, "Nested-OOPIF frame button", fixture.thirdOrigin);
  resultOf(await mcp("browser.act", { sessionId: allowedSession, action: { kind: "click", name: "Replace OOPIF target", exact: true, waitFor: { text: "oopif-replaced:2" } } }));
  const replacedResult = await mcp("browser.act", { sessionId: allowedSession, action: { kind: "click", target: { ref: beforeReplace.ref } } });
  assertStale(replacedResult, "replaced OOPIF ref");
  const nestedReplacedResult = await mcp("browser.act", { sessionId: allowedSession, action: { kind: "click", target: { ref: nestedBeforeReplace.ref } } });
  assertStale(nestedReplacedResult, "replaced nested OOPIF ref");
  const afterReplaceObservation = await observeUntil(allowedSession, (observation) => hasName(observation, "Granted-OOPIF-2 frame button") && hasName(observation, "Nested-OOPIF frame button"), "replacement nested OOPIF observation");
  const afterReplace = nodeByNameAndOrigin(afterReplaceObservation, "Granted-OOPIF-2 frame button", fixture.crossOrigin);
  const nestedAfterReplace = nodeByNameAndOrigin(afterReplaceObservation, "Nested-OOPIF frame button", fixture.thirdOrigin);
  assert(afterReplace.ref !== beforeReplace.ref, "replacement reused a retired OOPIF ref", { beforeReplace, afterReplace });
  assert(nestedAfterReplace.ref !== nestedBeforeReplace.ref, "replacement reused a retired nested OOPIF ref", { nestedBeforeReplace, nestedAfterReplace });
  log("oopif_target_replacement_ok", { before: beforeReplace.ref, after: afterReplace.ref, nestedBefore: nestedBeforeReplace.ref, nestedAfter: nestedAfterReplace.ref, staleStatus: statusOf(replacedResult) });

  resultOf(await mcp("browser.act", { sessionId: allowedSession, action: { kind: "click", name: "Detach OOPIF target", exact: true, waitFor: { text: "oopif-detached:2" } } }));
  const detachedResult = await mcp("browser.act", { sessionId: allowedSession, action: { kind: "click", target: { ref: afterReplace.ref } } });
  assertStale(detachedResult, "detached OOPIF ref");
  log("oopif_detach_ok", { ref: afterReplace.ref, status: statusOf(detachedResult) });

  await stopSession(allowedSession);
  log("frame_target_churn_live_pass", { nested: true, staleRefs: true, allowedAndExcludedProvenance: true });
} catch (error) {
  log("frame_target_churn_live_fail", { message: error?.message ?? String(error), detail: error?.detail });
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
    goal: "frame target churn live proof",
    instanceLabel,
  });
  assert(started.sessionId, "frame session did not start", started);
  resultOf(await mcp("browser.act", {
    sessionId: started.sessionId,
    action: {
      kind: "navigate",
      url: `${fixture.origin}/index.html?oopifOrigin=${encodeURIComponent(fixture.crossOrigin)}&nestedOrigin=${encodeURIComponent(fixture.thirdOrigin)}`,
    },
  }));
  await waitFor(async () => {
    const listed = await mcp("browser.tabs.list", {});
    return listed.sessions?.some((session) => session.sessionId === started.sessionId && session.ownedTabId) ? listed : null;
  }, "frame session binding", 20_000);
  return started.sessionId;
}

async function stopSession(sessionId) {
  const stopped = await mcp("browser.session.stop", { sessionId });
  assert(stopped.stopped === true, "frame session did not stop", stopped);
}

async function observeUntil(sessionId, predicate, label) {
  return waitFor(async () => {
    const observation = resultOf(await mcp("browser.observe", { sessionId, format: "json", maxNodes: 320 }));
    return predicate(observation) ? observation : null;
  }, label, 20_000);
}

async function mcp(name, args) {
  const response = await handleMcpMessage(bridge, { jsonrpc: "2.0", id: Math.floor(Math.random() * 1e9), method: "tools/call", params: { name, arguments: args } });
  const text = response?.result?.content?.find((item) => item.type === "text")?.text;
  assert(typeof text === "string", `missing MCP result for ${name}`, response);
  return JSON.parse(text);
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

function nodeByNameAndOrigin(observation, name, frameOrigin) {
  const node = (observation.nodes ?? []).find((candidate) => String(candidate.name ?? "").trim() === name && candidate.frameOrigin === frameOrigin);
  assert(node?.ref, `missing ${name} from ${frameOrigin}`, observation);
  return node;
}

function hasName(observation, name) {
  return (observation.nodes ?? []).some((node) => String(node.name ?? "").trim() === name);
}

function assertStale(result, label) {
  const status = statusOf(result);
  assert(["stale_target", "frame_detached", "target_gone", "not_found"].includes(status), `${label} was not rejected`, result);
}

function statusOf(result) {
  return result?.errorCode ?? result?.result?.errorCode ?? result?.result?.status ?? result?.status ?? result?.result?.actionStatus;
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
