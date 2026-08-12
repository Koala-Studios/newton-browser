import type { BrowserActionResultStatus, BrowserFloorDecision, BrowserCommandOutcome, BrowserCommandResultMetadata } from "./protocol.ts";

export const BROWSER_SESSION_LIFECYCLE_STATES = [
  "starting_runtime",
  "starting_browser",
  "attaching_cdp",
  "active",
  "degraded",
  "stopping",
  "stopped",
] as const;

export type BrowserSessionLifecycleState = (typeof BROWSER_SESSION_LIFECYCLE_STATES)[number];
type BrowserResultBase = BrowserCommandResultMetadata & {
  commandId: string;
  ok: boolean;
  status: BrowserActionResultStatus;
  decision: BrowserFloorDecision;
};

type BrowserResultSuccess = BrowserResultBase & {
  ok: true;
  outcome: "completed";
  result: unknown;
  reason?: string;
  changed?: Record<string, unknown>;
};

type BrowserResultFailure = BrowserResultBase & {
  ok: false;
  outcome: Exclude<BrowserCommandOutcome, "completed">;
  errorCode: string;
};

export type BrowserCommandResult = BrowserResultSuccess | BrowserResultFailure;

export type BrowserDispatchOptions = {
  timeoutMs?: number;
  idempotencyKey?: string;
  signal?: AbortSignal;
};

export type BrowserSessionInit = {
  origin: string;
  allowedOrigins: string[];
  // This opaque operator-created identity selects one
  // exclusive Newton profile without exposing its filesystem path.
  identityId?: string;
  // Persistent identities remain authoritative for
  // their browser family; ephemeral sessions may select either supported family.
  browserFamily?: "chrome" | "edge";
};

export type BrowserSessionInfo = {
  sessionId: string;
  origin: string;
  allowedOrigins: string[];
  lifecycleState: BrowserSessionLifecycleState;
};
