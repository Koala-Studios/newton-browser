import type {
  BrowserAction,
  BrowserFloorDecision,
  BrowserSignals,
  BrowserCommandOutcome,
  BridgeCommandResultMetadata,
} from "./protocol.ts";
import type { BrowserResolvedTarget } from "./risk.ts";

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

export type BridgeCommand = {
  commandId: string;
  sessionId: string;
  sessionEpoch: number;
  sequence: number;
  actionKind: string;
  action: BrowserAction;
};

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
  tabMode: "owned_group" | "current";
  instanceLabel?: string;
  ownedTabId?: number;
  tabGroupId?: number;
  // Open the owned tab in an incognito window (WS: incognito sessions). Owned-group
  // only; ignored for current-tab. Requires the extension to be allowed in incognito.
  incognito?: boolean;
};

export type BridgeSessionInfo = {
  sessionId: string;
  hostInstanceId?: string;
  origin: string;
  allowedOrigins?: string[];
  tabMode: "owned_group" | "current";
  ownedTabId?: number | null;
  tabGroupId?: number | null;
  attached?: boolean;
  liveOrigin?: string | null;
  goal?: string;
  instanceLabel?: string;
  incognito?: boolean;
  lifecycleState?: BrowserSessionLifecycleState;
};

export type BridgeFloorInput = {
  action: BrowserAction;
  origin?: string;
  allowedOrigins?: string[];
  resolved?: BrowserResolvedTarget | null;
  signals?: BrowserSignals;
  requestedClass?: string;
};

export type BridgeFloorEvaluator = (input: BridgeFloorInput) => BrowserFloorDecision | null | Promise<BrowserFloorDecision | null>;

export interface BridgeTransport {
  createSession(init: BridgeSessionInit): Promise<{ sessionId: string }>;
  attachTab(sessionId: string, tab: { ownedTabId: number; tabGroupId?: number | null; attached?: boolean; liveOrigin?: string }): Promise<void>;
  subscribe(sessionId: string, onCommand: (cmd: BridgeCommand) => void | Promise<void>): () => void;
  listSessions(): Promise<BridgeSessionInfo[]>;
  postEvent(commandId: string, eventType: string, detail: unknown): Promise<void>;
  postResult(event: BridgeResultEvent): Promise<void>;
  stopSession(sessionId: string): Promise<void>;
  stopAll(): Promise<void>;
}
