import {
  BROWSER_ACTION_KINDS,
  type BrowserAction,
  type BrowserCommitBoundary,
  type BrowserFloorDecision,
  type BrowserSignals,
} from "./protocol.ts";
import {
  hostMatchesBrowserPolicy,
  matchHostCommitBoundary,
  type BrowserHostPolicy,
  type BrowserHostPolicyManifest,
} from "./host-policy.ts";

const READ_ONLY_ACTIONS = new Set(["observe", "screenshot", "console", "network"]);
// Dialog accept/dismiss respond to a page-initiated JavaScript dialog. They
// are agentic and never blocked-class: the dialog exists because of an action the
// agent already took, and leaving it unhandled wedges the renderer. Post-action
// reconciliation still runs, so an accept that triggers a navigation/network write
// is caught by the driver like any other agentic click.
const AGENTIC_ACTIONS = new Set(["scroll", "wait_for", "hover", "move", "back", "forward", "reload", "dialog_accept", "dialog_dismiss", "resize"]);
const FILL_ACTIONS = new Set(["fill", "type", "select", "clear", "set_files"]);
const SECRET_HINT = /password|passcode|secret|token|api[_ -]?key|credential|private[_ -]?key|otp|2fa|one[_ -]?time|verification code|security code/i;
// Payment / financial / government-id fields. The host never auto-types these: a
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
};

export function evaluateBrowserFloor(input: BrowserFloorInput): BrowserFloorDecision {
  if (!BROWSER_ACTION_KINDS.includes(input.action.kind)) {
    return blocked("unsupported_action");
  }

  const policy = input.policy ?? { allowedOrigins: [] };
  const host = input.origin ? hostMatchesBrowserPolicy({ origin: input.origin, policy }) : null;
  if (host && !host.allowed) {
    return blocked(host.reason);
  }

  if (READ_ONLY_ACTIONS.has(input.action.kind)) {
    return { class: "read_only", commitBoundary: "none" };
  }

  if (AGENTIC_ACTIONS.has(input.action.kind)) {
    return { class: "agentic", commitBoundary: "none" };
  }

  // Cross-origin into a frame outside the grant is never auto-allowed.
  if (input.signals?.crossOrigin) {
    return blocked("cross_origin_target");
  }
  if (input.signals?.containmentPrevention) {
    return blocked(input.signals.containmentPrevention);
  }

  if (input.action.kind === "navigate") {
    return { class: "agentic", commitBoundary: "none" };
  }

  if (FILL_ACTIONS.has(input.action.kind)) {
    const sensitive = sensitiveFieldReason(input);
    if (sensitive) {
      return blocked(sensitive, "draft");
    }
    // Draft edits are always agentic (§7) — value is redacted in artifacts.
    return { class: "agentic", commitBoundary: "draft" };
  }

  // click / press: decide the commit boundary.
  const boundary = resolveCommitBoundary(input);
  if (boundary.effect === "external_effect" || boundary.effect === "commit") {
    return {
      class: "agentic",
      reason: boundary.reason,
      commitBoundary: boundary.effect,
    };
  }

  // Genuinely ambiguous / non-committing click → agentic, with post-action
  // reconciliation (the driver halts the run if an observed nav/network write
  // reveals a commit after the fact).
  return { class: "agentic", commitBoundary: "none" };
}

function resolveCommitBoundary(input: BrowserFloorInput): { effect: BrowserCommitBoundary; reason: string } {
  // 1. Host policy is authoritative when present (removes the gray zone). The
  // resolved element name/role lets a rule match a ref/selector-targeted commit.
  const fromHost = matchHostCommitBoundary({ manifest: input.manifest ?? null, action: input.action, resolved: input.resolved ?? null });
  if (fromHost) return fromHost;

  // 2. Structural commit detection (no page prose as authority).
  const targetText = `${input.resolved?.accessibleName ?? ""} ${actionTargetText(input.action)}`;
  if ((input.action.kind === "click" || input.action.kind === "press") && SOCIAL_ENGAGEMENT_HINT.test(targetText)) {
    return { effect: "external_effect", reason: "social_engagement_action" };
  }

  // 3. Structural commit detection (no page prose as authority).
  const resolved = input.resolved ?? null;
  const structurallyCommit =
    Boolean(input.signals?.formSubmit) ||
    Boolean(resolved?.formOwner) ||
    (typeof resolved?.role === "string" && /submit|menuitemcheckbox/i.test(resolved.role));
  if (structurallyCommit) {
    return { effect: "commit", reason: "structural_commit" };
  }

  // 4. Submit-like accessible structure remains conservative even when a host
  // policy exists only to configure masks. A policy can raise specificity but
  // never de-risk an unmatched control.
  if (SUBMIT_HINT.test(targetText)) {
    return { effect: "commit", reason: "unknown_host_submit_like" };
  }

  return { effect: "none", reason: "non_committing_click" };
}

// Returns the block reason if this fill targets a credential, OTP/2FA, payment,
// or government-id field: the host never auto-types these. null = safe
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
  return [
    action.ref,
    action.selector,
    action.text,
    action.role,
    action.name,
    action.label,
    action.placeholder,
    action.testId,
    Number.isFinite(action.x) && Number.isFinite(action.y) ? "coordinates" : undefined,
  ].filter(Boolean).join(" ");
}

function blocked(
  reason: string,
  commitBoundary: BrowserCommitBoundary = "none",
): BrowserFloorDecision {
  return {
    class: "blocked",
    reason,
    commitBoundary,
  };
}
