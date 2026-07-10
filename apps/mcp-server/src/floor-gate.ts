import {
  evaluateBrowserFloor,
  parseBrowserAction,
  selectHostPolicyManifest,
  type BridgeSessionInfo,
  type BrowserAction,
  type BrowserFloorDecision,
} from "@newton-browser/core";

import { loadHostPolicies } from "./config.ts";

export type HostFloorVerdict =
  | { relay: true; action: BrowserAction; decision: BrowserFloorDecision }
  | { relay: false; action: BrowserAction; decision: BrowserFloorDecision; errorCode: string };

export function evaluateHostFloor(input: {
  session: BridgeSessionInfo;
  action: unknown;
}): HostFloorVerdict {
  const action = parseBrowserAction(input.action);
  const origin = input.session.origin ?? undefined;
  const manifest = origin ? selectHostPolicyManifest({ manifests: loadHostPolicies(), origin }) : null;
  const decision = evaluateBrowserFloor({
    action,
    origin,
    policy: { allowedOrigins: input.session.allowedOrigins ?? (origin ? [origin] : []) },
    manifest,
  });
  if (decision.blocked) return { relay: false, action, decision, errorCode: "blocked_by_floor" };
  return {
    relay: true,
    action: action.kind === "screenshot" && manifest?.sensitiveZones?.length
      ? { ...action, sensitiveZones: manifest.sensitiveZones }
      : action,
    decision,
  };
}
