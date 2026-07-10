import type { BrowserAction, BrowserFloorDecision, BrowserSignals } from "./protocol.ts";
import type { BrowserResolvedTarget } from "./risk.ts";

export type BridgeCommand = {
  commandId: string;
  sessionId: string;
  actionKind: string;
  action: BrowserAction;
};

export type BridgeResultEvent =
  | { commandId: string; ok: true; result: unknown; decision?: BrowserFloorDecision }
  | { commandId: string; ok: false; errorCode: string; decision?: BrowserFloorDecision };

export type BridgeSessionInit = {
  origin: string;
  allowedOrigins: string[];
  goal?: string;
  tabMode: "owned_group" | "current";
  instanceLabel?: string;
  ownedTabId?: number;
  tabGroupId?: number;
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
