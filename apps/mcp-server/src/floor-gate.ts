import {
  evaluateBrowserFloor,
  parseBrowserAction,
  selectHostPolicyManifest,
  type BrowserHostPolicyManifest,
  type BrowserSessionInfo,
  type BrowserAction,
  type BrowserFloorDecision,
  type BrowserResolvedTarget,
  type BrowserSignals,
} from "@newton-browser/core";

type HostFloorVerdict =
  | { dispatchAllowed: true; action: BrowserAction; decision: BrowserFloorDecision }
  | { dispatchAllowed: false; action: BrowserAction; decision: BrowserFloorDecision; errorCode: string };

export function evaluateHostFloor(input: {
  session: BrowserSessionInfo;
  action: unknown;
  manifests: readonly BrowserHostPolicyManifest[];
  resolved?: BrowserResolvedTarget | null;
  signals?: BrowserSignals;
}): HostFloorVerdict {
  const action = parseBrowserAction(input.action);
  const origin = input.session.origin;
  const manifest = selectHostPolicyManifest({ manifests: input.manifests, origin });
  const decision = evaluateBrowserFloor({
    action,
    origin,
    manifest,
    ...(input.resolved === undefined ? {} : { resolved: input.resolved }),
    ...(input.signals === undefined ? {} : { signals: input.signals }),
  });
  if (decision.class === "blocked") return { dispatchAllowed: false, action, decision, errorCode: "blocked_by_floor" };
  return {
    dispatchAllowed: true,
    action: action.kind === "screenshot" && manifest?.sensitiveZones?.length
      ? { ...action, sensitiveZones: manifest.sensitiveZones.map((zone) => ({ ...zone })) }
      : action,
    decision,
  };
}
