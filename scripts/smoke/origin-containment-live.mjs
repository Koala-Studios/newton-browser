import { createDefaultDirectBrowserHost } from "../../apps/mcp-server/src/browser-runtime/default-direct-host.ts";
import { discoverBrowserExecutable } from "../../apps/mcp-server/src/browser-runtime/browser-discovery.ts";
import { handleMcpMessage } from "../../apps/mcp-server/src/mcp-server.ts";
import { startFixtureServers } from "../../test/fixtures/server.mjs";
import { scheduler } from "node:timers/promises";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveLiveBrowserFamily } from "./live-config.mjs";
import { classifyCompletedContainmentAttempt, classifyContainmentAttempt, classifyDestinationRequest, classifyFixtureObserveFailure, classifyFixturePrimaryCounter, classifyInitialNavigationFailure, classifySessionStartFailure, containmentFixtureDocumentChecks } from "./origin-containment-diagnostics.mjs";

const fixturePort = Number(process.env.NEWTON_BROWSER_CONTAINMENT_FIXTURE_PORT ?? 18341);
const browserFamily = resolveLiveBrowserFamily();
let fixture;
let host;
let directRoot;

try {
  fixture = await startFixtureServers({ port: fixturePort, crossOriginPort: fixturePort + 1 });
  directRoot = createDirectRoot();
  writeContainmentQaPolicy(directRoot.root, fixture.origin, fixture.crossOrigin);
  const executable = discoverBrowserExecutable({ family: browserFamily, env: process.env });
  if (!executable) throw new Error("direct_browser_unavailable");
  host = createDefaultDirectBrowserHost({
    ...process.env,
    NEWTON_BROWSER_BROWSER: browserFamily,
    NEWTON_BROWSER_BROWSER_EXECUTABLE: executable.path,
    NEWTON_BROWSER_CONFIG_DIR: directRoot.root,
    NEWTON_BROWSER_PROFILE_STORE_DIR: path.join(directRoot.root, "identities"),
  });
  log("origin_containment_servers_ready", { browserFamily });

  await runRestrictedSanityAndNonPopupCoverage();

  for (const popupCase of [
    { id: "popup_window", name: "Popup via window open", endpoint: "/origin-containment/application/popup-window.html" },
    { id: "popup_anchor", name: "Popup via anchor target blank", endpoint: "/origin-containment/application/popup-anchor.html" },
    { id: "popup_form", name: "Popup via form target blank", endpoint: "/origin-containment/application/popup-form.html" },
    { id: "popup_programmatic_anchor", name: "Popup via programmatic anchor", endpoint: "/origin-containment/application/popup-programmatic-anchor.html" },
    { id: "popup_redirect", name: "Popup via denied redirect", endpoint: "/origin-containment/application/redirect.html", mainControl: "/origin-containment/redirect-to-destination" },
  ]) await runRestrictedPopupCase(popupCase);

  await runAllowedNonPopupCoverage();

  await runPolicyBlockedPopupCase({
    id: "popup_same_policy_blocked",
    name: "Allowed same-origin popup",
    allowedOrigins: [],
    endpoint: "/origin-containment/application/popup-same.html",
    originRole: "main",
  });
  await runPolicyBlockedPopupCase({
    id: "popup_granted_policy_blocked",
    name: "Allowed granted-origin popup",
    allowedOrigins: [fixture.crossOrigin],
    endpoint: "/origin-containment/application/popup-granted.html",
    originRole: "destination",
  });
  log("origin_containment_live_pass", { zeroUnintendedRequests: true, allowedOriginContinues: true });
} catch (error) {
  log("origin_containment_live_fail", boundedFailure(error));
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
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(parent, "newton-direct-containment-live-")));
  const stat = fs.lstatSync(root);
  const nonce = randomBytes(32).toString("hex");
  fs.writeFileSync(path.join(root, ".owner"), nonce, { flag: "wx", mode: 0o600 });
  return Object.freeze({ root, parent, nonce, dev: stat.dev, ino: stat.ino });
}

function writeContainmentQaPolicy(directory, origin, crossOrigin) {
  const actionNames = [
    "Cross-origin fetch mutation", "Cross-origin beacon", "Cross-origin form mutation",
    "Cross-origin controlled frame", "Cross-origin worker", "Cross-origin WebSocket",
    "Cross-origin EventSource", "Popup via window open", "Popup via anchor target blank",
    "Popup via form target blank", "Popup via programmatic anchor", "Popup via denied redirect",
    "Allowed same-origin popup", "Allowed granted-origin popup",
  ];
  fs.writeFileSync(path.join(directory, "config.json"), `${JSON.stringify({
    browser: browserFamily,
    hostPolicies: [{
      origins: [origin, crossOrigin],
      commitRules: actionNames.map((name) => ({ match: { role: "button", name }, effect: "external_effect", reason: "qa_containment_fixture" })),
    }],
  })}\n`, { flag: "wx", mode: 0o600 });
}

function removeDirectRoot(owned) {
  const resolved = fs.realpathSync.native(owned.root);
  const stat = fs.lstatSync(resolved);
  const marker = path.join(resolved, ".owner");
  const markerStat = fs.lstatSync(marker);
  if (resolved !== owned.root || path.dirname(resolved) !== owned.parent
    || !/^newton-direct-containment-live-[^/\\]+$/u.test(path.basename(resolved))
    || !stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== owned.dev || stat.ino !== owned.ino
    || !markerStat.isFile() || markerStat.isSymbolicLink() || fs.readFileSync(marker, "utf8") !== owned.nonce) {
    throw new Error("direct containment live cleanup refused");
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}

async function runRestrictedSanityAndNonPopupCoverage() {
  let restrictedSession;
  let primaryFailed = false;
  try {
    restrictedSession = await startSession([], "origin-containment-restricted");
    await navigateToContainmentFixture(restrictedSession);
    const initial = fixture.containment.snapshot();
    assert(initial.destinationResourceRequests === 0, "ungranted resource reached destination", initial);
    assert(initial.destinationApplicationRequests === 0, "ungranted application request reached destination", initial);
    log("ungranted_resources_zero", { destinationResourceRequests: 0, destinationApplicationRequests: 0 });
    fixture.containment.reset();
    for (const [attemptId, name] of [
      ["fetch_mutation", "Cross-origin fetch mutation"],
      ["beacon", "Cross-origin beacon"],
      ["form_mutation", "Cross-origin form mutation"],
      ["controlled_frame", "Cross-origin controlled frame"],
      ["worker", "Cross-origin worker"],
      ["websocket", "Cross-origin WebSocket"],
      ["eventsource", "Cross-origin EventSource"],
    ]) {
      await assertPreventedAttempt(attemptId, () => mcp("browser.act", {
        sessionId: restrictedSession,
        action: { kind: "click", role: "button", name, exact: true, ...(attemptId === "worker" ? { waitFor: { text: "worker-blocked" } } : {}) },
      }), { requirePrevented: false });
    }
    await assertPreventedAttempt("redirect", () => mcp("browser.act", {
      sessionId: restrictedSession,
      action: { kind: "navigate", url: `${fixture.origin}/origin-containment/redirect-to-destination` },
    }), { requirePrevented: true });
    log("preventive_zero_request_ok", { attemptedPaths: 8, destinationApplicationRequests: 0 });
  } catch (error) {
    primaryFailed = true;
    throw error;
  } finally {
    if (restrictedSession) {
      try { await stopSession(restrictedSession, "initial_restricted"); }
      catch (error) {
        if (!primaryFailed) throw error;
        log("initial_restricted_cleanup_failed");
      }
    }
  }
}

async function runAllowedNonPopupCoverage() {
  let allowedSession;
  let primaryFailed = false;
  try {
    fixture.containment.reset();
    allowedSession = await startSession([fixture.crossOrigin], "origin-containment-allowed");
    resultOf(await mcp("browser.act", { sessionId: allowedSession, action: { kind: "navigate", url: `${fixture.origin}/origin-containment/primary.html` } }));
    fixture.containment.reset();
    await actThenWait(allowedSession, { kind: "click", role: "button", name: "Cross-origin controlled frame", exact: true }, { text: "frame-dispatched" }, "allowed controlled-frame dispatch");
    await waitFor(() => fixture.containment.snapshot().destinationApplicationRequests === 1 ? fixture.containment.snapshot() : null, "allowed destination frame request", 10_000);
    const allowedFrame = await observeUntil(allowedSession, (observation) => (observation.nodes ?? []).some((node) => String(node.name ?? "").includes("frame destination control") && node.frameOrigin === fixture.crossOrigin), "allowed destination frame observation");
    assert((allowedFrame.nodes ?? []).some((node) => String(node.name ?? "").includes("frame destination control") && node.frameOrigin === fixture.crossOrigin), "allowed destination frame was not observable with provenance", allowedFrame);
    log("allowed_frame_ok", { destinationApplicationRequests: 1 });

    fixture.containment.reset();
    resultOf(await mcp("browser.act", { sessionId: allowedSession, action: { kind: "navigate", url: `${fixture.origin}/origin-containment/redirect-to-destination` } }));
    const allowedRedirect = await waitFor(() => fixture.containment.snapshot().destinationApplicationRequests === 1 ? fixture.containment.snapshot() : null, "allowed redirect destination", 10_000);
    assert(allowedRedirect.entries.some((entry) => entry.pathname.endsWith("/redirect.html")), "allowed redirect destination was not recorded", allowedRedirect);
    log("allowed_redirect_ok", { destinationApplicationRequests: allowedRedirect.destinationApplicationRequests });
  } catch (error) {
    primaryFailed = true;
    throw error;
  } finally {
    if (allowedSession) {
      try { await stopSession(allowedSession, "allowed_non_popup"); }
      catch (error) {
        if (!primaryFailed) throw error;
        log("allowed_non_popup_cleanup_failed");
      }
    }
  }
}

async function startSession(allowedOrigins, _scenario) {
  const started = await mcp("browser.session.start", {
    origin: fixture.origin,
    allowedOrigins,
  });
  if (!started.sessionId) log(`containment_session_start_${classifySessionStartFailure(started)}`);
  assert(started.sessionId, "containment session did not start", started);
  await waitFor(async () => {
    const listed = await mcp("browser.sessions.list", {});
    return listed.sessions?.some((session) => session.sessionId === started.sessionId && session.lifecycleState === "active") ? listed : null;
  }, "containment session binding", 20_000);
  return started.sessionId;
}

async function stopSession(sessionId, label = "session") {
  let stopped = await mcp("browser.session.stop", { sessionId });
  if (stopped?.ok === false && stopped?.errorCode === "direct_cleanup_uncertain") {
    log(`${label}_cleanup_retry`);
    stopped = await mcp("browser.session.stop", { sessionId });
  }
  assert(stopped.stopped === true, "containment session did not stop", stopped);
  await waitFor(() => !host.listSessions().some((session) => session.sessionId === sessionId), `${label} teardown`, 10_000);
  log(`${label}_teardown_clean`);
}

async function runRestrictedPopupCase(popupCase) {
  let sessionId;
  let primaryFailed = false;
  try {
    sessionId = await startSession([], `containment-${popupCase.id}`);
    await navigateToContainmentFixture(sessionId);
    fixture.containment.reset();
    await assertPreventedAttempt(popupCase.id, () => mcp("browser.act", {
      sessionId,
      action: {
        kind: "click",
        role: "button",
        name: popupCase.name,
        exact: true,
        ...(popupCase.id === "popup_form" ? { waitFor: { text: "popup-form-dispatched" } } : {}),
      },
    }), { requirePrevented: false, endpoint: popupCase.endpoint, ...(popupCase.mainControl ? { mainControl: popupCase.mainControl } : {}) });
  } catch (error) {
    primaryFailed = true;
    throw error;
  } finally {
    if (sessionId) {
      try {
        await stopSession(sessionId, popupCase.id);
      } catch (error) {
        if (!primaryFailed) throw error;
        log(`${popupCase.id}_cleanup_failed`);
      }
    }
  }
}

async function runPolicyBlockedPopupCase(popupCase) {
  let sessionId;
  let primaryFailed = false;
  try {
    sessionId = await startSession(popupCase.allowedOrigins, `containment-${popupCase.id}`);
    await navigateToContainmentFixture(sessionId);
    fixture.containment.reset();
    log(`${popupCase.id}_attempt_start`);
    const result = await mcp("browser.act", {
      sessionId,
      action: { kind: "click", role: "button", name: popupCase.name, exact: true },
    });
    const classification = classifyContainmentAttempt(result);
    log(`${popupCase.id}_action_${classification}`);
    assert(classification === "not_started" && result?.retrySafe === true,
      `${popupCase.id} was not blocked before dispatch`);
    const snapshot = fixture.containment.snapshot();
    const endpointCount = fixedRequestCount(snapshot, popupCase.originRole, "GET", popupCase.endpoint, "application");
    log(`${popupCase.id}_counter_${endpointCount === 0 ? "zero" : "nonzero"}`);
    assert(endpointCount === 0, `${popupCase.id} reached the network despite the commit floor`);
  } catch (error) {
    primaryFailed = true;
    throw error;
  } finally {
    if (sessionId) {
      try {
        await stopSession(sessionId, popupCase.id);
      } catch (error) {
        if (!primaryFailed) throw error;
        log(`${popupCase.id}_cleanup_failed`);
      }
    }
  }
}

async function navigateToContainmentFixture(sessionId) {
  const navigated = await mcp("browser.act", {
    sessionId,
    action: { kind: "navigate", url: `${fixture.origin}/origin-containment/primary.html` },
  });
  if (navigated?.ok === false) {
    log(`containment_initial_navigation_class_${classifyContainmentAttempt(navigated)}`);
    log(`containment_initial_navigation_${classifyInitialNavigationFailure(navigated)}`);
  }
  resultOf(navigated);
  log("containment_initial_navigation_completed");
  await waitForContainmentFixtureMarker(sessionId);
}

async function waitForContainmentFixtureMarker(sessionId) {
  const observed = await mcp("browser.observe", { sessionId, format: "json", maxNodes: 240 });
  if (observed?.ok === false) {
    log(`containment_fixture_observe_${classifyFixtureObserveFailure(observed)}`);
    logContainmentFixturePrimaryCounter();
  }
  const observation = resultOf(observed);
  const checks = containmentFixtureDocumentChecks(observation, fixture.origin);
  assert(checks.originExact, "containment fixture origin was not exact");
  assert(checks.titleExact, "containment fixture title was not exact");
  assert(checks.nodesNonempty, "containment fixture observation had no nodes");
  assert(checks.requiredNamesPresent, "containment fixture controls were incomplete");
  log("containment_fixture_document_verified");
  return observation;
}

function logContainmentFixturePrimaryCounter() {
  const category = classifyFixturePrimaryCounter(fixture.containment.snapshot());
  log(`containment_fixture_primary_counter_${category}`);
}

async function assertPreventedAttempt(attemptId, attempt, expected = {}) {
  log(`${attemptId}_attempt_start`);
  const result = await attempt();
  const classification = classifyContainmentAttempt(result);
  const snapshot = fixture.containment.snapshot();
  const counterStatus = snapshot.destinationApplicationRequests === 0 ? "zero" : "nonzero";
  log(`${attemptId}_action_${classification}`);
  if (classification === "other") {
    const outcome = result?.outcome;
    const code = result?.errorCode;
    const status = result?.status;
    log(`${attemptId}_fact_outcome_${["completed", "prevented", "outcome_unknown", "not_started"].includes(outcome) ? outcome : "other"}`);
    log(`${attemptId}_fact_code_${["ungranted_navigation", "ungranted_mutation", "ungranted_connection", "ungranted_target", "unsupported_ungranted_request", "post_action_network_write", "post_action_dialog", "not_found", "ambiguous", "stale_target", "timed_out", "runner_contract_invalid"].includes(code) ? code : "other"}`);
    log(`${attemptId}_fact_status_${["verified", "dispatched_unverified", "blocked", "not_found", "ambiguous", "stale_target", "timed_out", "failed"].includes(status) ? status : "other"}`);
  }
  log(`${attemptId}_counter_${counterStatus}`);
  const completed = classifyCompletedContainmentAttempt(result) === "completed";
  const preventive = classification === "prevented" || classification === "not_started";
  const validOutcome = expected.requirePrevented === false
    ? preventive || completed
    : classification === "prevented";
  if (!validOutcome) {
    log(`${attemptId}_failure_${classifyInitialNavigationFailure(result)}`);
  }
  if (counterStatus === "nonzero") log(`${attemptId}_request_${classifyDestinationRequest(snapshot)}`);
  assert(validOutcome, `${attemptId} action outcome was not honest`);
  assert(preventive ? result?.retrySafe === true : result?.retrySafe === false,
    `${attemptId} action retry classification was not honest`);
  assert(snapshot.destinationApplicationRequests === 0, `${attemptId} reached the destination application`);
  if (expected.endpoint) assert(fixedRequestCount(snapshot, "destination", "GET", expected.endpoint, "application") === 0, `${attemptId} reached its denied endpoint`);
  if (expected.mainControl) {
    const sourceCount = fixedRequestCount(snapshot, "main", "GET", expected.mainControl, "control");
    log(`${attemptId}_redirect_source_${sourceCount === 0 ? "zero" : sourceCount === 1 ? "one" : "other"}`);
    assert(sourceCount <= 1, `${attemptId} redirect source count exceeded one`);
  }
}

function fixedRequestCount(snapshot, originRole, method, pathname, kind) {
  return (snapshot?.entries ?? []).filter((entry) => entry?.originRole === originRole
    && entry?.method === method && entry?.pathname === pathname && entry?.kind === kind).length;
}

function hasName(observation, name) {
  return (observation?.nodes ?? []).some((node) => String(node?.name ?? "").trim() === name);
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
  const actedEnvelope = await mcp("browser.act", { sessionId, action });
  resultOf(actedEnvelope);
  const waitedEnvelope = await mcp("browser.act", { sessionId, action: { kind: "wait_for", waitFor } });
  if (waitedEnvelope?.ok === false) log(`allowed_frame_wait_${classifyInitialNavigationFailure(waitedEnvelope)}`);
  const waited = resultOf(waitedEnvelope);
  const status = waited?.status;
  assert(status === "verified", `${label} was not verified`, { status: status ?? "missing" });
  return waited;
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

function boundedFailure(error) {
  return { message: String(error?.message ?? error).slice(0, 240) };
}
