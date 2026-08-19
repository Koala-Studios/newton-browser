import type { BrowserAction, BrowserCommitBoundary } from "./protocol.ts";

// Optional host-policy manifests let a user add structural commit rules and
// screenshot masking for specific origins. Manifests are loaded from local
// configuration; the product ships without vendor-specific defaults.
export type BrowserHostCommitRule = {
  // structural match, never page prose: a role/name/testid/selector that the
  // driver already resolved on the target element.
  match: Readonly<{
    role?: string;
    name?: string;        // accessible name (matched case-insensitively, contains)
    testid?: string;
    selector?: string;
  }>;
  effect: Extract<BrowserCommitBoundary, "commit" | "external_effect">;
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
  origins: readonly string[];
  commitRules?: readonly BrowserHostCommitRule[];
  sensitiveZones?: readonly BrowserHostSensitiveZone[];
};

// Session starts and local policy bindings use canonical HTTP(S) origins as stable
// identifiers. This normalization does not authorize or block browser networking.
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

// Resolve the strongest commit boundary a host manifest declares for an action
// against a resolved element. Returns null when nothing matches (caller falls
// back to structural defaults / conservative unknown-host handling).
export function matchHostCommitBoundary(input: {
  manifest: BrowserHostPolicyManifest | null;
  action: BrowserAction;
  // Resolved element facts from the driver's pre-dispatch re-check. Lets a
  // host commit rule match a ref/selector-targeted element by its real
  // accessible name/role, closing the "commit-by-ref auto-fires" gap.
  resolved?: { role?: string; accessibleName?: string } | null;
}): { effect: BrowserCommitBoundary; reason: string } | null {
  const manifest = input.manifest;
  if (!manifest || !Array.isArray(manifest.commitRules)) return null;
  const haystack = [
    input.action.ref,
    input.action.selector,
    input.action.text,
    input.action.role,
    input.action.name,
    input.action.label,
    input.action.placeholder,
    input.action.testId,
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
  manifests: readonly BrowserHostPolicyManifest[];
  origin: string;
}): BrowserHostPolicyManifest | null {
  const origin = normalizeHttpOrigin(input.origin);
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
  return effect === "external_effect" ? 2 : effect === "commit" ? 1 : 0;
}

function originMatches(origin: string, pattern: string): boolean {
  return normalizeHttpOrigin(pattern) === normalizeHttpOrigin(origin);
}
