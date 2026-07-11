import {
  BROWSER_ACTION_KINDS,
  type BrowserAction,
  type BrowserCommitBoundary,
  type BrowserFloorDecision,
  type BrowserFloorEvidence,
  type BrowserRiskClass,
  type BrowserSignals,
} from "./protocol.ts";
import {
  hostMatchesBrowserPolicy,
  matchHostCommitBoundary,
  type BrowserHostPolicy,
  type BrowserHostPolicyManifest,
} from "./host-policy.ts";

const READ_ONLY_ACTIONS = new Set(["observe", "screenshot"]);
// Dialog accept/dismiss (WS9.4) respond to a page-initiated JavaScript dialog. They
// are agentic and never blocked-class: the dialog exists because of an action the
// agent already took, and leaving it unhandled wedges the renderer. Post-action
// reconciliation still runs, so an accept that triggers a navigation/network write
// is caught by the driver like any other agentic click.
const AGENTIC_ACTIONS = new Set(["scroll", "wait_for", "hover", "move", "back", "forward", "reload", "dialog_accept", "dialog_dismiss"]);
const MUTATING_ACTIONS = new Set(["click", "fill", "type", "select", "navigate", "press", "clear", "back", "forward", "reload"]);
const FILL_ACTIONS = new Set(["fill", "type", "select", "clear", "set_files"]);
const SECRET_HINT = /password|passcode|secret|token|api[_ -]?key|credential|private[_ -]?key|otp|2fa|one[_ -]?time|verification code|security code/i;
// Payment / financial / government-id fields. The bridge never auto-types these: a
// fill on one is blocked at the floor, the same as a credential (S22).
const PAYMENT_PII_HINT = /credit[_ -]?card|card[_ -]?number|cardnumber|\bcvv\b|\bcvc\b|\bccv\b|card[_ -]?security|\bssn\b|social[_ -]?security|\biban\b|routing[_ -]?number|account[_ -]?number|sort[_ -]?code|\bcvn\b|tax[_ -]?id|national[_ -]?insurance/i;
// Structural fallback only: used to detect a likely commit on an UNKNOWN host.
// Page prose can never authorize/de-risk an action (§7); this only RAISES risk.
const SUBMIT_HINT = /submit|send\b|publish|pay\b|purchase|check[ _-]?out|delete|remove|launch|confirm|place\s*order|complete\s*order|buy\s*now/i;
const SOCIAL_ENGAGEMENT_HINT = /\b(like|unlike|subscribe|unsubscribe|follow|unfollow)\b/i;
// CDP input `type` values plus autocomplete tokens that mark a sensitive field.
const SECRET_INPUT_TYPES = new Set(["password"]);
const SENSITIVE_AUTOCOMPLETE = /^(cc-|current-password|new-password|one-time-code)/i;

// A resolved element handed to the floor as evidence (never the sole gate).
export type BrowserResolvedTarget = {
  role?: string;
  accessibleName?: string;
  formOwner?: string | null;
  inputType?: string;
  autocomplete?: string;
  origin?: string;
};

export type BrowserFloorInput = {
  action: BrowserAction;
  origin?: string | undefined;
  policy?: BrowserHostPolicy | undefined;
  manifest?: BrowserHostPolicyManifest | null | undefined;
  resolved?: BrowserResolvedTarget | null | undefined;
  signals?: BrowserSignals | undefined;
  requestedClass?: BrowserRiskClass | undefined;
  // Feature flag (§14): when false, all actuation is rejected while observation
  // stays live. Defaults to enabled.
  actuationEnabled?: boolean | undefined;
};

export function evaluateBrowserFloor(input: BrowserFloorInput): BrowserFloorDecision {
  const reasons: string[] = [];
  const evidence: BrowserFloorEvidence[] = [];
  if (!BROWSER_ACTION_KINDS.includes(input.action.kind)) {
    return blocked(["unsupported_action"], "none", [{ kind: "action_kind", value: input.action.kind }]);
  }

  const policy = input.policy ?? { allowedOrigins: [] };
  const host = input.origin ? hostMatchesBrowserPolicy({ origin: input.origin, policy }) : null;
  if (host && !host.allowed) {
    return blocked([host.reason], "none", [{ kind: "origin", value: String(input.origin ?? "") }]);
  }
  if (host?.allowed) reasons.push(host.reason);

  if (READ_ONLY_ACTIONS.has(input.action.kind)) {
    return withRequestedUpgrade(
      { class: "read_only", permissionRequired: "newton_browser.observe", approvalRequired: false, blocked: false, reasons, commitBoundary: "none" },
      input.requestedClass,
    );
  }

  if (AGENTIC_ACTIONS.has(input.action.kind)) {
    return withRequestedUpgrade(
      { class: "agentic", permissionRequired: "newton_browser.agentic_session", approvalRequired: false, blocked: false, reasons, commitBoundary: "none" },
      input.requestedClass,
    );
  }

  // Mutating actions below. Honor the actuation feature flag first.
  const actuationEnabled = input.actuationEnabled ?? true;
  if (!actuationEnabled && MUTATING_ACTIONS.has(input.action.kind)) {
    return blocked(["actuation_disabled"], "none");
  }

  // Cross-origin into a frame outside the grant is never auto-allowed.
  if (input.signals?.crossOrigin) {
    return blocked(["cross_origin_target"], "none", [{ kind: "crossOrigin", value: true }]);
  }

  if (["navigate", "back", "forward", "reload"].includes(input.action.kind)) {
    // Navigation within granted origins is non-committing (§7).
    return withRequestedUpgrade(
      { class: "agentic", permissionRequired: "newton_browser.act", approvalRequired: false, blocked: false, reasons, commitBoundary: "none" },
      input.requestedClass,
    );
  }

  if (FILL_ACTIONS.has(input.action.kind)) {
    const sensitive = sensitiveFieldReason(input);
    if (sensitive) {
      return blocked([sensitive], "draft", [{ kind: sensitive, value: true }]);
    }
    // Draft edits are always agentic (§7) — value is redacted in artifacts.
    return withRequestedUpgrade(
      { class: "agentic", permissionRequired: "newton_browser.act", approvalRequired: false, blocked: false, reasons, commitBoundary: "draft" },
      input.requestedClass,
    );
  }

  // click / press: decide the commit boundary.
  const boundary = resolveCommitBoundary(input, evidence);
  if (boundary.effect === "external_effect" || boundary.effect === "commit") {
    return {
      class: "approval_required",
      permissionRequired: "newton_browser.act",
      approvalRequired: true,
      blocked: false,
      reasons: [...reasons, boundary.reason],
      commitBoundary: boundary.effect,
      evidence,
    };
  }

  // Genuinely ambiguous / non-committing click → agentic, with post-action
  // reconciliation (the driver halts the run if an observed nav/network write
  // reveals a commit after the fact).
  return withRequestedUpgrade(
    { class: "agentic", permissionRequired: "newton_browser.act", approvalRequired: false, blocked: false, reasons, commitBoundary: "none" },
    input.requestedClass,
  );
}

function resolveCommitBoundary(
  input: BrowserFloorInput,
  evidence: BrowserFloorEvidence[],
): { effect: BrowserCommitBoundary; reason: string } {
  // 1. Host policy is authoritative when present (removes the gray zone). The
  // resolved element name/role lets a rule match a ref/selector-targeted commit.
  const fromHost = matchHostCommitBoundary({ manifest: input.manifest ?? null, action: input.action, resolved: input.resolved ?? null });
  if (fromHost) {
    evidence.push({ kind: "host_policy", value: fromHost.reason });
    return fromHost;
  }

  // 2. Structural commit detection (no page prose as authority).
  const targetText = `${input.resolved?.accessibleName ?? ""} ${actionTargetText(input.action)}`;
  if ((input.action.kind === "click" || input.action.kind === "press") && SOCIAL_ENGAGEMENT_HINT.test(targetText)) {
    evidence.push({ kind: "social_engagement_action", value: true });
    return { effect: "external_effect", reason: "social_engagement_action" };
  }

  // 3. Structural commit detection (no page prose as authority).
  const resolved = input.resolved ?? null;
  const structurallyCommit =
    Boolean(input.signals?.formSubmit) ||
    Boolean(resolved?.formOwner) ||
    (typeof resolved?.role === "string" && /submit|menuitemcheckbox/i.test(resolved.role));
  if (structurallyCommit) {
    evidence.push({ kind: "structural_commit", value: true });
    return { effect: "commit", reason: "structural_commit" };
  }

  // 4. Unknown host + submit-like accessible name → conservative stop.
  const conservativeDefault = (input.manifest?.defaultForUnmatched ?? "conservative") === "conservative";
  if (conservativeDefault && !input.manifest && SUBMIT_HINT.test(targetText)) {
    evidence.push({ kind: "unknown_host_submit_like", value: true });
    return { effect: "commit", reason: "unknown_host_submit_like" };
  }

  return { effect: "none", reason: "non_committing_click" };
}

// Returns the block reason if this fill targets a credential, OTP/2FA, payment,
// or government-id field: the bridge never auto-types these. null = safe
// draft field.
function sensitiveFieldReason(input: BrowserFloorInput): string | null {
  if (input.signals?.secretField) return "secret_or_password_field";
  const inputType = input.resolved?.inputType?.toLowerCase();
  if (inputType && SECRET_INPUT_TYPES.has(inputType)) return "secret_or_password_field";
  const autocomplete = input.resolved?.autocomplete?.toLowerCase() ?? "";
  if (autocomplete && SENSITIVE_AUTOCOMPLETE.test(autocomplete)) {
    return autocomplete.startsWith("cc-") ? "payment_or_pii_field" : "secret_or_password_field";
  }
  const target = `${actionTargetText(input.action)} ${input.resolved?.accessibleName ?? ""}`;
  if (SECRET_HINT.test(target)) return "secret_or_password_field";
  if (PAYMENT_PII_HINT.test(target)) return "payment_or_pii_field";
  return null;
}

function actionTargetText(action: BrowserAction): string {
  const target = action.target && typeof action.target === "object" ? action.target : {};
  const coordinates = "coordinates" in target ? "coordinates" : "";
  return [
    action.ref,
    action.selector,
    action.text,
    action.role,
    action.name,
    action.label,
    action.placeholder,
    action.testId,
    "ref" in target ? target.ref : undefined,
    "selector" in target ? target.selector : undefined,
    "text" in target ? target.text : undefined,
    "role" in target ? target.role : undefined,
    "name" in target ? target.name : undefined,
    "label" in target ? target.label : undefined,
    "placeholder" in target ? target.placeholder : undefined,
    "testId" in target ? target.testId : undefined,
    coordinates,
  ].filter(Boolean).join(" ");
}

function withRequestedUpgrade(decision: BrowserFloorDecision, requested: BrowserRiskClass | undefined): BrowserFloorDecision {
  if (!requested) return decision;
  const order: BrowserRiskClass[] = ["read_only", "agentic", "approval_required", "blocked"];
  if (order.indexOf(requested) <= order.indexOf(decision.class)) return decision;
  return {
    ...decision,
    class: requested,
    permissionRequired:
      requested === "read_only"
        ? "newton_browser.observe"
        : requested === "agentic"
          ? "newton_browser.agentic_session"
          : "newton_browser.act",
    approvalRequired: requested === "approval_required" || decision.approvalRequired,
    blocked: requested === "blocked",
    reasons: [...decision.reasons, "risk_class_raised_by_caller"],
  };
}

function blocked(
  reasons: string[],
  commitBoundary: BrowserCommitBoundary = "none",
  evidence: BrowserFloorEvidence[] = [],
): BrowserFloorDecision {
  return {
    class: "blocked",
    permissionRequired: "newton_browser.act",
    approvalRequired: false,
    blocked: true,
    reasons,
    commitBoundary,
    evidence,
  };
}
