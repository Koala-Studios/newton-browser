const PREVENTED_STATUSES = new Set([
  "blocked",
  "prevented",
  "ungranted_navigation",
  "origin_not_granted",
  "ungranted_mutation",
  "ungranted_connection",
  "ungranted_target",
  "unsupported_ungranted_request",
  "post_action_network_write",
  "post_action_dialog",
]);

const SAFE_OUTCOMES = new Set(["completed", "outcome_unknown", "not_started"]);
const SAFE_STATUSES = new Set([
  "verified",
  "dispatched_unverified",
  "blocked",
  "not_found",
  "ambiguous",
  "stale_target",
  "timed_out",
  "failed",
]);

const SAFE_SESSION_START_FAILURE_CODES = new Set([
  "session_setup_failed",
  "session_setup_timeout",
  "browser_version_unsupported",
  "frame_conflict",
  "containment_fence_failed",
  "origin_containment_unavailable",
  "debugger_conflict",
  "shutdown_detach_failed",
  "root_debugger_attach_failed",
  "root_protocol_setup_failed",
  "browser_control_attach_failed",
  "browser_page_autoattach_failed",
  "browser_control_fence_failed",
  "root_autoattach_failed",
  "calibration_failed",
  "initial_navigation_failed",
]);

export function classifySessionStartFailure(value) {
  const candidates = fixedFailureCandidates(value);
  return candidates.find((candidate) => SAFE_SESSION_START_FAILURE_CODES.has(candidate)) ?? "unknown";
}

const SAFE_INITIAL_NAVIGATION_FAILURE_CODES = new Set([
  ...SAFE_SESSION_START_FAILURE_CODES,
  "renderer_unresponsive",
  "initial_navigation_uncommitted",
  "initial_navigation_conflict",
  "initial_navigation_download",
  "initial_navigation_event_overflow",
  "runner_contract_invalid",
]);

export function classifyInitialNavigationFailure(value) {
  const candidates = [
    ...fixedFailureCandidates(value),
    value?.reason, value?.status,
    value?.error?.reason, value?.error?.status,
  ];
  const exact = candidates.find((candidate) => SAFE_INITIAL_NAVIGATION_FAILURE_CODES.has(candidate));
  if (exact) return exact;
  return candidates.some((candidate) => typeof candidate === "string" && /^cdp_timeout_[a-zA-Z][a-zA-Z0-9.]{0,79}$/.test(candidate))
    ? "cdp_timeout"
    : "unknown";
}

export function classifyFixtureObserveFailure(value) {
  return classifyInitialNavigationFailure(value);
}

export function classifyFixturePrimaryCounter(snapshot) {
  const primaryCount = Array.isArray(snapshot?.entries)
    ? snapshot.entries.filter((entry) => entry?.originRole === "main"
      && entry?.method === "GET"
      && entry?.pathname === "/origin-containment/primary.html"
      && entry?.kind === "control").length
    : 0;
  return primaryCount === 0 ? "zero" : primaryCount === 1 ? "one" : "other";
}

const REQUIRED_CONTAINMENT_FIXTURE_NAMES = Object.freeze([
  "Cross-origin fetch mutation",
  "Cross-origin beacon",
  "Cross-origin form mutation",
  "Cross-origin controlled frame",
  "Cross-origin worker",
  "Cross-origin WebSocket",
  "Cross-origin EventSource",
  "Popup via window open",
  "Popup via anchor target blank",
  "Popup via form target blank",
  "Popup via programmatic anchor",
  "Popup via denied redirect",
  "Allowed same-origin popup",
  "Allowed granted-origin popup",
]);

export function containmentFixtureDocumentChecks(observation, expectedOrigin) {
  const nodes = Array.isArray(observation?.nodes) ? observation.nodes : [];
  const names = new Set(nodes.map((node) => typeof node?.name === "string" ? node.name.trim() : ""));
  return Object.freeze({
    originExact: observation?.origin === expectedOrigin,
    titleExact: observation?.title === "Newton origin containment fixture",
    nodesNonempty: nodes.length > 0,
    requiredNamesPresent: REQUIRED_CONTAINMENT_FIXTURE_NAMES.every((name) => names.has(name)),
  });
}

function fixedFailureCandidates(value) {
  return [
    value?.errorCode, value?.code, value?.message,
    value?.error?.errorCode, value?.error?.code, value?.error?.message,
  ];
}

export function classifyContainmentAttempt(result) {
  const status = result?.errorCode ?? result?.status;
  const outcome = result?.outcome;
  if (outcome === "prevented" && PREVENTED_STATUSES.has(status)) return "prevented";
  if (SAFE_OUTCOMES.has(outcome)) return outcome;
  if (SAFE_STATUSES.has(status)) return status;
  return "other";
}

export function classifyCompletedContainmentAttempt(result) {
  const status = result?.status;
  return result?.ok === true
    && result?.outcome === "completed"
    && result?.retrySafe === false
    && ["verified", "dispatched_unverified"].includes(status)
    ? "completed"
    : "other";
}

export function classifyDestinationRequest(snapshot) {
  const entries = Array.isArray(snapshot?.entries) ? snapshot.entries : [];
  if (entries.some((entry) => entry?.originRole === "destination" && entry?.method === "GET" && entry?.pathname === "/origin-containment/application/popup-window.html" && entry?.kind === "application")) return "popup_window_document";
  if (entries.some((entry) => entry?.originRole === "destination" && entry?.method === "GET" && entry?.pathname === "/origin-containment/application/popup-anchor.html" && entry?.kind === "application")) return "popup_anchor_document";
  if (entries.some((entry) => entry?.originRole === "destination" && entry?.method === "GET" && entry?.pathname === "/origin-containment/application/popup-form.html" && entry?.kind === "application")) return "popup_form_document";
  if (entries.some((entry) => entry?.originRole === "destination" && entry?.method === "GET" && entry?.pathname === "/origin-containment/application/popup-programmatic-anchor.html" && entry?.kind === "application")) return "popup_programmatic_anchor_document";
  if (entries.some((entry) => entry?.originRole === "main" && entry?.method === "GET" && entry?.pathname === "/origin-containment/application/popup-same.html" && entry?.kind === "application")) return "popup_same_document";
  if (entries.some((entry) => entry?.originRole === "destination" && entry?.method === "GET" && entry?.pathname === "/origin-containment/application/popup-granted.html" && entry?.kind === "application")) return "popup_granted_document";
  if (entries.some((entry) => entry?.originRole === "destination" && entry?.method === "GET" && entry?.pathname === "/origin-containment/application/popup.html" && entry?.kind === "application")) return "popup_document";
  if (entries.some((entry) => entry?.originRole === "destination" && entry?.method === "GET" && entry?.pathname === "/origin-containment/application/frame.html" && entry?.kind === "application")) return "frame_document";
  if (entries.some((entry) => entry?.originRole === "destination" && entry?.method === "GET" && entry?.pathname === "/origin-containment/application/redirect.html" && entry?.kind === "application")) return "redirect_document";
  if (entries.some((entry) => entry?.originRole === "destination" && entry?.method === "GET" && entry?.pathname === "/origin-containment/application/worker.js" && entry?.kind === "application")) return "worker_script";
  if (entries.some((entry) => entry?.originRole === "destination" && entry?.method === "POST" && entry?.pathname === "/origin-containment/application/mutation" && entry?.kind === "application")) return "mutation";
  if (entries.some((entry) => entry?.originRole === "destination" && entry?.pathname === "/origin-containment/application/connection" && entry?.kind === "application")) return "connection";
  return "other";
}
