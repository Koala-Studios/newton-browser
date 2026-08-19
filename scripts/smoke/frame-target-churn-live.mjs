import { createConfiguredDirectBrowserHost } from "../../apps/mcp-server/src/browser-runtime/configured-direct-host.ts";
import { discoverBrowserExecutable } from "../../apps/mcp-server/src/browser-runtime/browser-discovery.ts";
import { handleMcpMessage } from "../../apps/mcp-server/src/mcp-server.ts";
import { startFixtureServers } from "../../test/fixtures/server.mjs";
import { scheduler } from "node:timers/promises";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveLiveBrowserFamily } from "./live-config.mjs";

const fixturePort = Number(process.env.NEWTON_BROWSER_FRAME_FIXTURE_PORT ?? 18331);
const browserFamily = resolveLiveBrowserFamily();
let fixture;
let host;
let directRoot;

try {
  fixture = await startFixtureServers({ port: fixturePort, crossOriginPort: fixturePort + 1, thirdOriginPort: fixturePort + 2 });
  const crossSiteOrigin = fixture.crossOrigin;
  directRoot = createDirectRoot();
  const executable = discoverBrowserExecutable({ family: browserFamily, env: process.env });
  if (!executable) throw new Error("direct_browser_unavailable");
  host = createConfiguredDirectBrowserHost({
    env: process.env,
    browserFamily,
    executablePath: executable.path,
    profileStoreRoot: path.join(directRoot.root, "identities"),
  });
  log("frame_churn_servers_ready", { browserFamily });

  const sameProcessSession = await startSession(fixture.origin, fixture.origin);
  const sameProcessObserved = await observeUntil(sameProcessSession, (observation) => hasName(observation, "Nested-OOPIF frame button"), "same-process nested frame observation");
  const sameProcessButton = (sameProcessObserved.nodes ?? []).find((node) => String(node.name ?? "").trim() === "Nested-OOPIF frame button");
  assert(typeof sameProcessButton?.ref === "string", "missing same-process nested frame button", sameProcessObserved);
  const sameProcessClick = await mcp("browser.act", { sessionId: sameProcessSession, action: { kind: "click", ref: sameProcessButton.ref } });
  logActionFailure("same_process_nested_click", sameProcessClick);
  assertActionDispatched(sameProcessClick, "same-process nested frame click");
  await observeUntil(sameProcessSession, (observation) => hasName(observation, "Nested-OOPIF frame button clicked"), "same-process nested frame click effect");
  log("same_process_nested_route_ok");
  await stopSession(sameProcessSession);

  const crossSiteSession = await startSession(crossSiteOrigin, fixture.thirdOrigin);
  let observed = await observeUntil(crossSiteSession, (observation) => hasName(observation, "Cross-site-OOPIF-1 frame button")
    && hasName(observation, "Nested-OOPIF frame button"), "allowed nested OOPIF observation");
  log("oopif_nodes_ready");
  const crossButton = nodeByNameAndOrigin(observed, "Cross-site-OOPIF-1 frame button", crossSiteOrigin);
  log("oopif_cross_node_resolved");
  const nestedButton = nodeByNameAndOrigin(observed, "Nested-OOPIF frame button", fixture.thirdOrigin);
  log("oopif_nested_node_resolved");
  assert(/^d\d+:f\d+:e\d+$/.test(crossButton.ref), "OOPIF ref was not frame-qualified", crossButton);
  assert(/^d\d+:f\d+:e\d+$/.test(nestedButton.ref), "nested OOPIF ref was not frame-qualified", nestedButton);
  log("oopif_refs_qualified");
  const nestedClickEnvelope = await mcp("browser.act", { sessionId: crossSiteSession, action: { kind: "click", ref: nestedButton.ref } });
  log("oopif_action_returned");
  const nestedClick = nestedClickEnvelope;
  logActionFailure("cross_site_nested_click", nestedClick);
  assertActionDispatched(nestedClick, "nested OOPIF click");
  log(`cross_site_nested_action_${statusOf(nestedClick) === "verified" ? "verified" : "dispatched_unverified"}`);
  try {
    observed = await observeUntil(crossSiteSession, (observation) => hasName(observation, "Nested-OOPIF frame button clicked"), "cross-site nested frame click effect");
  } catch (error) {
    const clickDiagnostic = resultOf(await mcp("browser.observe", { sessionId: crossSiteSession, format: "json", maxNodes: 240 }));
    log(classifyInputBreadcrumb(clickDiagnostic, "cross_site_click"));
    throw error;
  }
  log("cross_site_nested_route_ok", { crossRef: crossButton.ref, nestedRef: nestedButton.ref });

  const staleTarget = nodeByNameAndOrigin(observed, "Frame stale target", crossSiteOrigin);
  const rerender = nodeByNameAndOrigin(observed, "Rerender frame target", crossSiteOrigin);
  const rerenderClick = resultOf(await mcp("browser.act", { sessionId: crossSiteSession, action: { kind: "click", ref: rerender.ref } }));
  const rerenderClickStatus = statusOf(rerenderClick);
  if (!["verified", "dispatched_unverified"].includes(rerenderClickStatus)) {
    const safeStatus = ["target_moved", "stale_target", "frame_detached", "target_gone", "blocked", "not_found"]
      .includes(rerenderClickStatus) ? rerenderClickStatus : "other";
    log(`frame_rerender_click_${safeStatus}`);
  }
  assertActionDispatched(rerenderClick, "child-frame rerender click");
  const rerenderWait = resultOf(await mcp("browser.act", {
    sessionId: crossSiteSession,
    action: { kind: "wait_for", waitFor: { name: "Frame fresh target", timeoutMs: 20_000 } },
  }));
  assert(statusOf(rerenderWait) === "verified", "child-frame rerender was not observed", { status: statusOf(rerenderWait) ?? "missing" });
  log("frame_rerender_observation_ok");
  const staleResult = await mcp("browser.act", { sessionId: crossSiteSession, action: { kind: "click", ref: staleTarget.ref } });
  assertStale(staleResult, "rerendered child-frame ref");
  log("frame_rerender_stale_ref_ok", { ref: staleTarget.ref, status: statusOf(staleResult) });

  observed = resultOf(await mcp("browser.observe", { sessionId: crossSiteSession, format: "json", maxNodes: 240 }));
  const beforeReplace = nodeByNameAndOrigin(observed, "Cross-site-OOPIF-1 frame button", crossSiteOrigin);
  const nestedBeforeReplace = nodeByNameAndOrigin(observed, "Nested-OOPIF frame button clicked", fixture.thirdOrigin);
  await actThenWait(crossSiteSession, { kind: "click", role: "button", name: "Replace OOPIF target", exact: true }, { text: "oopif-replaced:2" }, "OOPIF target replacement");
  const replacedResult = await mcp("browser.act", { sessionId: crossSiteSession, action: { kind: "click", ref: beforeReplace.ref } });
  assertStale(replacedResult, "replaced OOPIF ref");
  const nestedReplacedResult = await mcp("browser.act", { sessionId: crossSiteSession, action: { kind: "click", ref: nestedBeforeReplace.ref } });
  assertStale(nestedReplacedResult, "replaced nested OOPIF ref");
  const afterReplaceObservation = await observeUntil(crossSiteSession, (observation) => hasName(observation, "Cross-site-OOPIF-2 frame button") && hasName(observation, "Nested-OOPIF frame button"), "replacement nested OOPIF observation");
  const afterReplace = nodeByNameAndOrigin(afterReplaceObservation, "Cross-site-OOPIF-2 frame button", crossSiteOrigin);
  const nestedAfterReplace = nodeByNameAndOrigin(afterReplaceObservation, "Nested-OOPIF frame button", fixture.thirdOrigin);
  assert(afterReplace.ref !== beforeReplace.ref, "replacement reused a retired OOPIF ref", { beforeReplace, afterReplace });
  assert(nestedAfterReplace.ref !== nestedBeforeReplace.ref, "replacement reused a retired nested OOPIF ref", { nestedBeforeReplace, nestedAfterReplace });
  log("oopif_target_replacement_ok", { before: beforeReplace.ref, after: afterReplace.ref, nestedBefore: nestedBeforeReplace.ref, nestedAfter: nestedAfterReplace.ref, staleStatus: statusOf(replacedResult) });

  await actThenWait(crossSiteSession, { kind: "click", role: "button", name: "Detach OOPIF target", exact: true }, { text: "oopif-detached:2" }, "OOPIF target detach");
  const detachedResult = await mcp("browser.act", { sessionId: crossSiteSession, action: { kind: "click", ref: afterReplace.ref } });
  assertStale(detachedResult, "detached OOPIF ref");
  log("oopif_detach_ok", { ref: afterReplace.ref, status: statusOf(detachedResult) });

  await stopSession(crossSiteSession);
  log("frame_target_churn_live_pass", { sameProcessNested: true, crossSiteNested: true, staleRefs: true, normalCrossOriginFrames: true });
} catch (error) {
  log("frame_target_churn_live_fail", boundedFailure(error));
  process.exitCode = 1;
} finally {
  let directCleanupConfirmed = host === undefined;
  try {
    await host?.stopAll();
    await host?.close();
    directCleanupConfirmed = true;
  } catch {}
  try { await fixture?.close(); } catch {}
  if (directRoot && directCleanupConfirmed) removeDirectRoot(directRoot);
}
function createDirectRoot() {
  const parent = fs.realpathSync.native(os.tmpdir());
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(parent, "newton-direct-frame-live-")));
  const stat = fs.lstatSync(root);
  const nonce = randomBytes(32).toString("hex");
  fs.writeFileSync(path.join(root, ".owner"), nonce, { flag: "wx", mode: 0o600 });
  return Object.freeze({ root, parent, nonce, dev: stat.dev, ino: stat.ino });
}

function removeDirectRoot(owned) {
  const resolved = fs.realpathSync.native(owned.root);
  const stat = fs.lstatSync(resolved);
  const marker = path.join(resolved, ".owner");
  const markerStat = fs.lstatSync(marker);
  if (resolved !== owned.root || path.dirname(resolved) !== owned.parent
    || !/^newton-direct-frame-live-[^/\\]+$/u.test(path.basename(resolved))
    || !stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== owned.dev || stat.ino !== owned.ino
    || !markerStat.isFile() || markerStat.isSymbolicLink() || fs.readFileSync(marker, "utf8") !== owned.nonce) {
    throw new Error("direct frame live cleanup refused");
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}

async function startSession(oopifOrigin, nestedOrigin) {
  const started = await mcp("browser.session.start", {
    origin: fixture.origin,
  });
  assert(started.sessionId, "frame session did not start", started);
  const navigation = await mcp("browser.act", {
    sessionId: started.sessionId,
    action: {
      kind: "navigate",
      url: `${fixture.origin}/index.html?oopifOrigin=${encodeURIComponent(oopifOrigin)}&nestedOrigin=${encodeURIComponent(nestedOrigin)}`,
    },
  });
  resultOf(navigation);
  await waitFor(async () => {
    const listed = await mcp("browser.sessions.list", {});
    return listed.sessions?.some((session) => session.sessionId === started.sessionId && session.lifecycleState === "active") ? listed : null;
  }, "frame session binding", 20_000);
  return started.sessionId;
}

async function stopSession(sessionId) {
  const stopped = await mcp("browser.session.stop", { sessionId });
  assert(stopped.stopped === true, "frame session did not stop", stopped);
}

async function observeUntil(sessionId, predicate, label) {
  let lastObservation = null;
  try {
    return await waitFor(async () => {
      const observation = resultOf(await mcp("browser.observe", { sessionId, format: "json", maxNodes: 240 }));
      lastObservation = observation;
      return predicate(observation) ? observation : null;
    }, label, 20_000);
  } catch (error) {
    log("frame_observe_timeout_facts", {
      firstOopif: hasName(lastObservation, "Cross-site-OOPIF-1 frame button"),
      nestedOopif: hasName(lastObservation, "Nested-OOPIF frame button"),
      nodeCount: Math.min(240, Array.isArray(lastObservation?.nodes) ? lastObservation.nodes.length : 0),
      frameQualifiedCount: Math.min(240, Array.isArray(lastObservation?.nodes)
        ? lastObservation.nodes.filter((node) => typeof node?.frameOrigin === "string").length
        : 0),
    });
    throw error;
  }
}

async function mcp(name, args) {
  const response = await handleMcpMessage(host, { jsonrpc: "2.0", id: Math.floor(Math.random() * 1e9), method: "tools/call", params: { name, arguments: args, _meta: modernMcpMeta() } });
  const text = response?.result?.content?.find((item) => item.type === "text")?.text;
  if (typeof text !== "string") {
    const code = response?.error?.data?.errorCode;
    throw new Error(`mcp_${typeof code === "string" && /^[a-z][a-z0-9_]{0,79}$/u.test(code) ? code : "response_invalid"}`);
  }
  return JSON.parse(text);
}

function modernMcpMeta() {
  return { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} };
}

async function actThenWait(sessionId, action, waitFor, label) {
  resultOf(await mcp("browser.act", { sessionId, action }));
  const waited = resultOf(await mcp("browser.act", { sessionId, action: { kind: "wait_for", waitFor } }));
  assert(statusOf(waited) === "verified", `${label} was not verified`, { status: statusOf(waited) ?? "missing" });
  return waited;
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
  return (observation?.nodes ?? []).some((node) => String(node.name ?? "").trim() === name);
}

function classifyInputBreadcrumb(observation, prefix) {
  if (hasName(observation, "Nested-OOPIF click frame-button")) return `${prefix}_nested_click_event`;
  if (hasName(observation, "Nested-OOPIF mouseup frame-button")) return `${prefix}_nested_mouseup_event`;
  if (hasName(observation, "Nested-OOPIF mousedown frame-button")) return `${prefix}_nested_mousedown_event`;
  if (hasName(observation, "Cross-site-OOPIF-1 click other")) return `${prefix}_hit_parent_document`;
  if (hasName(observation, "main click oopif-churn-frame")) return `${prefix}_hit_root_owner`;
  return `${prefix}_no_frame_event`;
}

function assertStale(result, label) {
  const status = statusOf(result);
  assert(["stale_target", "frame_detached", "target_gone", "not_found"].includes(status), `${label} was not rejected`, result);
}

function assertActionDispatched(result, label) {
  const status = statusOf(result);
  assert(["verified", "dispatched_unverified"].includes(status), `${label} did not dispatch`, { status: status ?? "missing" });
}

function logActionFailure(prefix, result) {
  const status = statusOf(result);
  if (["verified", "dispatched_unverified"].includes(status)) return;
  const safeStatus = [
    "target_moved", "stale_target", "frame_detached", "target_gone", "blocked", "not_found",
    "frame_conflict", "child_routing_unavailable", "session_detached", "target_detached",
  ]
    .includes(status) ? status : "other";
  const safeReason = [
    "frame_topology_unavailable", "frame_owner_unavailable", "frame_owner_hit_failed",
    "frame_owner_geometry_unavailable", "frame_owner_geometry_changed", "frame_viewport_mismatch", "frame_topology_changed",
    "frame_chain_unavailable", "target_local_hit_failed", "target_geometry_unavailable", "target_moved",
  ].includes(result?.reason) ? result.reason : "other";
  log(`${prefix}_${safeStatus}`);
  log(`${prefix}_reason_${safeReason}`);
}

function statusOf(result) {
  return result?.errorCode ?? result?.status;
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

function boundedFailure(error) {
  return { message: String(error?.message ?? error).slice(0, 240) };
}
