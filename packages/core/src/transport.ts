import type { BrowserFloorDecision, BrowserCommandOutcome, BridgeCommandResultMetadata } from "./protocol.ts";

export const BROWSER_SESSION_LIFECYCLE_STATES = [
  "creating_host",
  "creating_tab",
  "attaching_debugger",
  "verifying_origin",
  "publishing_ready",
  "active",
  "degraded",
  "finalizing",
  "stopped",
] as const;

export type BrowserSessionLifecycleState = (typeof BROWSER_SESSION_LIFECYCLE_STATES)[number];
export type BrowserSessionCleanupDisposition = "close";

type BridgeResultBase = BridgeCommandResultMetadata & {
  commandId: string;
  ok: boolean;
};

type BridgeResultSuccess = BridgeResultBase & {
  ok: true;
  outcome: "completed";
  result: unknown;
  decision?: BrowserFloorDecision;
};

type BridgeResultFailure = BridgeResultBase & {
  ok: false;
  outcome: BrowserCommandOutcome;
  errorCode: string;
  decision?: BrowserFloorDecision;
};

export type BridgeResultEvent = BridgeResultSuccess | BridgeResultFailure;

export type BridgeDispatchOptions = {
  timeoutMs?: number;
  idempotencyKey?: string;
};

export type BridgeSessionInit = {
  origin: string;
  allowedOrigins: string[];
  goal?: string;
  instanceLabel?: string;
  // This opaque operator-created identity selects one
  // exclusive Newton profile without exposing its filesystem path.
  identityId?: string;
  // Persistent identities remain authoritative for
  // their browser family; ephemeral sessions may select either supported family.
  browserFamily?: "chrome" | "edge";
};

export type BridgeSessionInfo = {
  sessionId: string;
  hostInstanceId?: string;
  origin: string;
  allowedOrigins?: string[];
  attached?: boolean;
  liveOrigin?: string | null;
  goal?: string;
  instanceLabel?: string;
  lifecycleState?: BrowserSessionLifecycleState;
  cleanupDisposition?: BrowserSessionCleanupDisposition;
};
