import { redactBrowserOrigin } from "./redaction.ts";
import type { BrowserAction, BrowserCommitBoundary } from "./protocol.ts";

export type BrowserHostPolicy = {
  allowedOrigins: string[];
  deniedOrigins?: string[];
};

// Optional host-policy manifests let a user add structural commit rules and
// screenshot masking for specific origins. Manifests are loaded from local
// configuration; the product ships without vendor-specific defaults.
export type BrowserHostCommitRule = {
  // structural match, never page prose: a role/name/testid/selector that the
  // driver already resolved on the target element.
  match: {
    role?: string;
    name?: string;        // accessible name (matched case-insensitively, contains)
    testid?: string;
    selector?: string;
  };
  effect: BrowserCommitBoundary;     // commit | external_effect (draft never gates)
  reason?: string;
};

export type BrowserHostSensitiveZone = {
  // A selector or AX-name region masked in screenshots before they leave the
  // host policy (spend, payment, customer data).
  selector?: string;
  name?: string;
  label?: string;
};

export type BrowserHostPolicyManifest = {
  origins: string[];
  label?: string;
  routeClass?: "app" | "auth_wall" | "billing" | "editor";
  // Unknown commit on this host defaults conservative unless a rule allows it.
  defaultForUnmatched?: "conservative" | "agentic";
  commitRules?: BrowserHostCommitRule[];
  sensitiveZones?: BrowserHostSensitiveZone[];
};

// The generic structural floor remains active when this collection is empty.
export const DEFAULT_BROWSER_HOST_POLICIES: BrowserHostPolicyManifest[] = [];

export function normalizeOrigin(value: unknown): string {
  return redactBrowserOrigin(value);
}

// Session grants are stricter than display/policy URL normalization: callers
// must provide an exact HTTP(S) origin, never a path, wildcard, or credentialed URL.
export function normalizeHttpOrigin(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 512 || /[\u0000-\u001f\u007f*]/.test(value)) return "";
  try {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol)
      || url.username
      || url.password
      || url.pathname !== "/"
      || url.search
      || url.hash
    ) return "";
    return url.origin;
  } catch {
    return "";
  }
}

export function hostMatchesBrowserPolicy(input: {
  origin: string;
  policy: BrowserHostPolicy;
}): { allowed: boolean; reason: string } {
  const origin = normalizeOrigin(input.origin);
  if (!origin) return { allowed: false, reason: "missing_origin" };
  const denied = input.policy.deniedOrigins ?? [];
  if (denied.some((pattern) => originMatches(origin, pattern))) return { allowed: false, reason: "origin_denied" };
  if (input.policy.allowedOrigins.length === 0) return { allowed: false, reason: "no_allowed_origins" };
  if (!input.policy.allowedOrigins.some((pattern) => originMatches(origin, pattern))) {
    return { allowed: false, reason: "origin_not_granted" };
  }
  return { allowed: true, reason: "origin_granted" };
}

// Resolve the strongest commit boundary a host manifest declares for an action
// against a resolved element. Returns null when nothing matches (caller falls
// back to structural defaults / conservative unknown-host handling).
export function matchHostCommitBoundary(input: {
  manifest: BrowserHostPolicyManifest | null;
  action: BrowserAction;
  // Resolved element facts from the driver's pre-dispatch re-check (§7). Lets a
  // host commit rule match a ref/selector-targeted element by its real
  // accessible name/role, closing the "commit-by-ref auto-fires" gap.
  resolved?: { role?: string; accessibleName?: string } | null;
}): { effect: BrowserCommitBoundary; reason: string } | null {
  const manifest = input.manifest;
  if (!manifest || !Array.isArray(manifest.commitRules)) return null;
  const target = input.action.target && typeof input.action.target === "object" ? input.action.target : {};
  const haystack = [
    input.action.ref,
    input.action.selector,
    input.action.text,
    input.action.role,
    input.action.name,
    input.action.label,
    input.action.placeholder,
    input.action.testId,
    "ref" in target ? target.ref : undefined,
    "selector" in target ? target.selector : undefined,
    "text" in target ? target.text : undefined,
    "role" in target ? target.role : undefined,
    "name" in target ? target.name : undefined,
    "label" in target ? target.label : undefined,
    "placeholder" in target ? target.placeholder : undefined,
    "testId" in target ? target.testId : undefined,
    input.resolved?.accessibleName,
    input.resolved?.role,
  ].filter(Boolean).join(" ").toLowerCase();
  let best: { effect: BrowserCommitBoundary; reason: string } | null = null;
  for (const rule of manifest.commitRules) {
    if (!commitRuleMatches(rule, haystack)) continue;
    if (!best || commitWeight(rule.effect) > commitWeight(best.effect)) {
      best = { effect: rule.effect, reason: rule.reason ?? `host_policy_${rule.effect}` };
    }
  }
  return best;
}

export function selectHostPolicyManifest(input: {
  manifests: BrowserHostPolicyManifest[];
  origin: string;
}): BrowserHostPolicyManifest | null {
  const origin = normalizeOrigin(input.origin);
  if (!origin) return null;
  return (
    input.manifests.find((manifest) =>
      (manifest.origins ?? []).some((pattern) => originMatches(origin, pattern)),
    ) ?? null
  );
}

function commitRuleMatches(rule: BrowserHostCommitRule, haystack: string): boolean {
  const match = rule.match ?? {};
  const needles = [match.name, match.testid, match.selector, match.role]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.toLowerCase());
  if (needles.length === 0) return false;
  return needles.some((needle) => haystack.includes(needle));
}

function commitWeight(effect: BrowserCommitBoundary): number {
  return effect === "external_effect" ? 3 : effect === "commit" ? 2 : effect === "draft" ? 1 : 0;
}

function originMatches(origin: string, pattern: string): boolean {
  const normalized = normalizeOrigin(pattern);
  if (!normalized) return false;
  if (normalized === origin) return true;
  if (!normalized.includes("*")) return false;
  const escaped = normalized.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i").test(origin);
}
