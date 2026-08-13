import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";

import { startFixtureServers } from "./fixtures/server.mjs";
import { classifyCompletedContainmentAttempt, classifyContainmentAttempt, classifyDestinationRequest, classifyFixtureObserveFailure, classifyFixturePrimaryCounter, classifyInitialNavigationFailure, classifySessionStartFailure, containmentFixtureDocumentChecks } from "../scripts/smoke/origin-containment-diagnostics.mjs";

test("containment acceptance requires an authoritative prevented outcome", () => {
  assert.equal(classifyContainmentAttempt({ outcome: "prevented", errorCode: "ungranted_mutation" }), "prevented");
  assert.equal(classifyContainmentAttempt({ outcome: "prevented", errorCode: "ungranted_target" }), "prevented");
  assert.equal(classifyContainmentAttempt({ outcome: "prevented", errorCode: "unsupported_ungranted_request" }), "prevented");
  assert.equal(classifyContainmentAttempt({ outcome: "prevented", errorCode: "post_action_network_write" }), "prevented");
  assert.equal(classifyContainmentAttempt({ outcome: "completed", errorCode: "ungranted_mutation" }), "completed");
  assert.equal(classifyContainmentAttempt({ outcome: "completed", status: "blocked" }), "completed");
  assert.equal(classifyContainmentAttempt({ outcome: "outcome_unknown", status: "blocked" }), "outcome_unknown");
  assert.equal(classifyContainmentAttempt({ result: { outcome: "prevented", errorCode: "ungranted_target" } }), "other");
  assert.equal(classifyContainmentAttempt({ outcome: "prevented", errorCode: "secret_page_value" }), "other");
  assert.equal(classifyCompletedContainmentAttempt({ ok: true, outcome: "completed", retrySafe: false, status: "verified" }), "completed");
  assert.equal(classifyCompletedContainmentAttempt({ outcome: "completed", retrySafe: false, status: "dispatched_unverified" }), "other");
  assert.equal(classifyCompletedContainmentAttempt({ result: { ok: false, outcome: "completed", retrySafe: false, status: "verified" } }), "other");
  assert.equal(classifyCompletedContainmentAttempt({ ok: true, outcome: "completed", retrySafe: true, status: "verified" }), "other");
  assert.equal(classifyCompletedContainmentAttempt({ ok: true, outcome: "completed", retrySafe: false, status: "blocked" }), "other");
});

test("containment session start diagnostics retain only exact closed setup codes", () => {
  assert.equal(classifySessionStartFailure({ errorCode: "browser_version_unsupported" }), "browser_version_unsupported");
  assert.equal(classifySessionStartFailure({ error: { code: "root_autoattach_failed" } }), "root_autoattach_failed");
  assert.equal(classifySessionStartFailure({ message: "root_autoattach_failed" }), "root_autoattach_failed");
  assert.equal(classifySessionStartFailure({ error: { message: "secret root_autoattach_failed" } }), "unknown");
  assert.equal(classifySessionStartFailure({ result: { errorCode: "hostile_page_secret" } }), "unknown");
});

test("containment initial navigation diagnostics retain closed codes and collapse CDP methods", () => {
  for (const code of ["origin_containment_unavailable", "containment_fence_failed", "debugger_conflict", "renderer_unresponsive"]) {
    assert.equal(classifyInitialNavigationFailure({ errorCode: code }), code);
  }
  assert.equal(classifyInitialNavigationFailure({ error: { code: "cdp_timeout_Page.navigate" } }), "cdp_timeout");
  assert.equal(classifyInitialNavigationFailure({ message: "failed: cdp_timeout_Page.navigate" }), "unknown");
  assert.equal(classifyInitialNavigationFailure({ errorCode: "cdp_timeout_Page.navigate secret" }), "unknown");
  assert.equal(classifyInitialNavigationFailure({ errorCode: "page_secret" }), "unknown");
  for (const [field, code] of [
    ["reason", "initial_navigation_uncommitted"],
    ["status", "initial_navigation_conflict"],
  ]) assert.equal(classifyInitialNavigationFailure({ [field]: code }), code);
  assert.equal(classifyInitialNavigationFailure({ status: "initial_navigation_download" }), "initial_navigation_download");
  assert.equal(classifyInitialNavigationFailure({ error: { reason: "initial_navigation_event_overflow" } }), "initial_navigation_event_overflow");
  assert.equal(classifyInitialNavigationFailure({ error: { status: "runner_contract_invalid" } }), "runner_contract_invalid");
  assert.equal(classifyInitialNavigationFailure({ reason: "secret initial_navigation_uncommitted" }), "unknown");
});

test("containment fixture observation diagnostics use a closed failure classifier", () => {
  assert.equal(classifyFixtureObserveFailure({ error: { errorCode: "renderer_unresponsive" } }), "renderer_unresponsive");
  assert.equal(classifyFixtureObserveFailure({ code: "containment_fence_failed" }), "containment_fence_failed");
  assert.equal(classifyFixtureObserveFailure({ message: "cdp_timeout_DOM.getDocument" }), "cdp_timeout");
  assert.equal(classifyFixtureObserveFailure({ message: "secret renderer_unresponsive" }), "unknown");
});

test("containment fixture document checks reject hostile or incomplete observations", () => {
  const names = [
    "Cross-origin fetch mutation", "Cross-origin beacon", "Cross-origin form mutation", "Cross-origin controlled frame",
    "Cross-origin worker", "Cross-origin WebSocket", "Cross-origin EventSource", "Popup via window open",
    "Popup via anchor target blank", "Popup via form target blank", "Popup via programmatic anchor", "Popup via denied redirect",
    "Allowed same-origin popup", "Allowed granted-origin popup",
  ];
  assert.deepEqual(containmentFixtureDocumentChecks({
    origin: "http://127.0.0.1:18341", title: "Newton origin containment fixture", nodes: names.map((name) => ({ name })),
  }, "http://127.0.0.1:18341"), {
    originExact: true, titleExact: true, nodesNonempty: true, requiredNamesPresent: true,
  });
  assert.deepEqual(containmentFixtureDocumentChecks({
    origin: "http://hostile.invalid", title: "Newton origin containment fixture secret", nodes: [{ name: "Popup via window open secret" }], secret: "page-secret",
  }, "http://127.0.0.1:18341"), {
    originExact: false, titleExact: false, nodesNonempty: true, requiredNamesPresent: false,
  });
  assert.deepEqual(containmentFixtureDocumentChecks({ nodes: [] }, "http://127.0.0.1:18341"), {
    originExact: false, titleExact: false, nodesNonempty: false, requiredNamesPresent: false,
  });
});

test("containment fixture failure counter uses only the exact primary ledger identity", () => {
  assert.equal(classifyFixturePrimaryCounter({ entries: [{
    originRole: "main", method: "GET", pathname: "/origin-containment/primary.html", kind: "control", secret: "ledger-secret",
  }] }), "one");
  assert.equal(classifyFixturePrimaryCounter({ entries: [
    { originRole: "main", method: "GET", pathname: "/origin-containment/primary.html", kind: "application" },
    { originRole: "destination", method: "GET", pathname: "/origin-containment/primary.html", kind: "control" },
  ] }), "zero");
  assert.equal(classifyFixturePrimaryCounter({ entries: Array.from({ length: 2 }, () => ({
    originRole: "main", method: "GET", pathname: "/origin-containment/primary.html", kind: "control",
  })) }), "other");
});

test("containment request diagnostics expose only a closed fixture category", () => {
  assert.equal(classifyDestinationRequest({ entries: [{ originRole: "destination", method: "GET", pathname: "/origin-containment/application/popup.html", kind: "application", secret: "do-not-log" }] }), "popup_document");
  assert.equal(classifyDestinationRequest({ entries: [{ originRole: "destination", method: "GET", pathname: "/origin-containment/application/private-customer-name", kind: "application" }] }), "other");
  assert.equal(classifyDestinationRequest({ entries: [{ originRole: "main", method: "GET", pathname: "/origin-containment/application/popup.html", kind: "application" }] }), "other");
  assert.equal(classifyDestinationRequest({ entries: [{ originRole: "destination", method: "GET", pathname: "/origin-containment/application/popup-window.html", kind: "application" }] }), "popup_window_document");
  assert.equal(classifyDestinationRequest({ entries: [{ originRole: "destination", method: "GET", pathname: "/origin-containment/application/popup-anchor.html", kind: "application" }] }), "popup_anchor_document");
  assert.equal(classifyDestinationRequest({ entries: [{ originRole: "destination", method: "GET", pathname: "/origin-containment/application/popup-form.html", kind: "application" }] }), "popup_form_document");
  assert.equal(classifyDestinationRequest({ entries: [{ originRole: "destination", method: "GET", pathname: "/origin-containment/application/popup-programmatic-anchor.html", kind: "application" }] }), "popup_programmatic_anchor_document");
  assert.equal(classifyDestinationRequest({ entries: [{ originRole: "main", method: "GET", pathname: "/origin-containment/application/popup-same.html", kind: "application" }] }), "popup_same_document");
  assert.equal(classifyDestinationRequest({ entries: [{ originRole: "destination", method: "GET", pathname: "/origin-containment/application/popup-granted.html", kind: "application" }] }), "popup_granted_document");
});

test("live containment logs closed action and counter stages before asserting", () => {
  const source = fs.readFileSync(path.resolve(import.meta.dirname, "../scripts/smoke/origin-containment-live.mjs"), "utf8");
  for (const attemptId of ["fetch_mutation", "beacon", "form_mutation", "controlled_frame", "worker", "websocket", "eventsource"]) {
    assert.match(source, new RegExp(`\\["${attemptId}"`));
  }
  assert.match(source, /assertPreventedAttempt\("redirect"/);
  const helperStart = source.indexOf("async function assertPreventedAttempt");
  const helperEnd = source.indexOf("async function mcp", helperStart);
  const helper = source.slice(helperStart, helperEnd);
  assert.ok(helperStart > 0 && helperEnd > helperStart);
  assert.ok(helper.indexOf("log(`${attemptId}_action_${classification}`)") < helper.indexOf("assert(validOutcome"));
  assert.ok(helper.indexOf("log(`${attemptId}_counter_${counterStatus}`)") < helper.indexOf("assert(snapshot.destinationApplicationRequests === 0"));
  assert.match(helper, /counterStatus = snapshot\.destinationApplicationRequests === 0 \? "zero" : "nonzero"/);
  assert.match(helper, /counterStatus === "nonzero".*classifyDestinationRequest\(snapshot\)/);
});

test("containment fixture counts destination application effects separately from read-only resources", async (context) => {
  const fixture = await startFixtureServers({ port: 0, crossOriginPort: 0 });
  context.after(() => fixture.close());

  fixture.containment.reset();
  const resource = await fetch(`${fixture.crossOrigin}/origin-containment/resource/pixel.svg`);
  assert.equal(resource.status, 200);
  assert.equal((await resource.text()).includes("<svg"), true);
  assert.deepEqual(fixture.containment.snapshot(), {
    destinationApplicationRequests: 0,
    destinationResourceRequests: 1,
    entries: [{
      sequence: 1,
      originRole: "destination",
      method: "GET",
      pathname: "/origin-containment/resource/pixel.svg",
      kind: "resource",
    }],
  });

  const mutation = await fetch(`${fixture.crossOrigin}/origin-containment/application/mutation`, {
    method: "POST",
    body: "fixture=1",
  });
  assert.equal(mutation.status, 204);
  const counted = fixture.containment.snapshot();
  assert.equal(counted.destinationApplicationRequests, 1);
  assert.equal(counted.destinationResourceRequests, 1);
  assert.equal(counted.entries.at(-1).method, "POST");
});

test("redirect destination count remains zero until a client follows the redirect", async (context) => {
  const fixture = await startFixtureServers({ port: 0, crossOriginPort: 0 });
  context.after(() => fixture.close());

  fixture.containment.reset();
  const paused = await fetch(`${fixture.origin}/origin-containment/redirect-to-destination`, { redirect: "manual" });
  assert.equal(paused.status, 302);
  assert.equal(paused.headers.get("location"), `${fixture.crossOrigin}/origin-containment/application/redirect.html`);
  assert.equal(fixture.containment.snapshot().destinationApplicationRequests, 0);

  const followed = await fetch(paused.headers.get("location"));
  assert.equal(followed.status, 200);
  assert.equal(fixture.containment.snapshot().destinationApplicationRequests, 1);

  fixture.containment.reset();
  assert.deepEqual(fixture.containment.snapshot(), {
    destinationApplicationRequests: 0,
    destinationResourceRequests: 0,
    entries: [],
  });
});

test("destination WebSocket upgrades are counted as application requests", async (context) => {
  const fixture = await startFixtureServers({ port: 0, crossOriginPort: 0 });
  context.after(() => fixture.close());

  await websocketUpgrade(`${fixture.crossOrigin}/origin-containment/application/connection`);
  const snapshot = fixture.containment.snapshot();
  assert.equal(snapshot.destinationApplicationRequests, 1);
  assert.deepEqual(snapshot.entries[0], {
    sequence: 1,
    originRole: "destination",
    method: "GET",
    pathname: "/origin-containment/application/connection",
    kind: "application",
  });
});

test("primary containment page exposes every preventive path deterministically", async (context) => {
  const fixture = await startFixtureServers({ port: 0, crossOriginPort: 0 });
  context.after(() => fixture.close());

  const response = await fetch(`${fixture.origin}/origin-containment/primary.html`);
  assert.equal(response.status, 200);
  const html = await response.text();
  for (const id of [
    "cross-fetch",
    "cross-beacon",
    "cross-popup",
    "cross-frame",
    "cross-worker",
    "cross-websocket",
    "cross-eventsource",
    "cross-form",
    "cross-image",
    "popup-window",
    "popup-anchor",
    "popup-form",
    "popup-programmatic-anchor",
    "popup-redirect",
    "popup-same",
    "popup-granted",
  ]) assert.match(html, new RegExp(`id=["']${id}["']`));
  assert.match(html, /new Worker\("\/origin-containment\/worker-launcher\.js"\)/);
  assert.match(html, /id="popup-form" method="get" target="_blank"/);
  assert.match(html, /id="popup-same" target="_blank"/);
  assert.match(html, /id="popup-granted" target="_blank"/);
  assert.doesNotMatch(html, /popup_(?:same|granted)_executed|postMessage/);

  const worker = await fetch(`${fixture.origin}/origin-containment/worker-launcher.js`);
  assert.equal(worker.status, 200);
  const workerSource = await worker.text();
  assert.match(workerSource, /origin-containment\/application\/worker\.js/);
  assert.match(workerSource, /worker-blocked/);
});

test("popup matrix endpoints have exact fixed ledger identities", async (context) => {
  const fixture = await startFixtureServers({ port: 0, crossOriginPort: 0 });
  context.after(() => fixture.close());
  for (const [originRole, origin, pathname] of [
    ["destination", fixture.crossOrigin, "/origin-containment/application/popup-window.html"],
    ["destination", fixture.crossOrigin, "/origin-containment/application/popup-anchor.html"],
    ["destination", fixture.crossOrigin, "/origin-containment/application/popup-form.html"],
    ["destination", fixture.crossOrigin, "/origin-containment/application/popup-programmatic-anchor.html"],
    ["main", fixture.origin, "/origin-containment/application/popup-same.html"],
    ["destination", fixture.crossOrigin, "/origin-containment/application/popup-granted.html"],
  ]) {
    fixture.containment.reset();
    const response = await fetch(`${origin}${pathname}`);
    assert.equal(response.status, 200);
    assert.deepEqual(fixture.containment.snapshot().entries, [{ sequence: 1, originRole, method: "GET", pathname, kind: "application" }]);
  }
  for (const file of ["popup-same.html", "popup-granted.html"]) {
    const source = fs.readFileSync(path.resolve(import.meta.dirname, `fixtures/origin-containment/application/${file}`), "utf8");
    assert.doesNotMatch(source, /script|postMessage|sendBeacon|fetch\(/i, `${file} must remain a static allowed-document fixture`);
  }
});

function websocketUpgrade(url) {
  return new Promise((resolve, reject) => {
    const request = http.request(url, { headers: { Connection: "Upgrade", Upgrade: "websocket" } });
    request.on("response", (response) => {
      response.resume();
      response.once("end", resolve);
    });
    request.on("upgrade", (_response, socket) => {
      socket.destroy();
      resolve();
    });
    request.once("error", reject);
    request.end();
  });
}
