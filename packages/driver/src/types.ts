import type { BrowserAction, BrowserActionKind, BrowserPendingDialog, BrowserWaitFor } from "@newton-browser/core";

export type { BrowserAction, BrowserPendingDialog, BrowserWaitFor };

export type BrowserDriverOptions = {
  allowedOrigins: string[];
  debuggerPort: DebuggerPort;
};

export type CdpRoute = { sessionId?: string | null; timeoutMs?: number };

// Chromium CDP is intentionally dynamic at this single private transport edge.
// Every public payload is validated by core before reaching the driver; CDP
// results are narrowed by each consuming method before they become public.
// eslint is not used in this repository; keep the escape confined to this alias.
export type CdpRecord = Record<string, any>;

export type DebuggerTarget = { sessionId?: string };
export type DebuggerPort = {
  attach(): Promise<void>;
  detach(): Promise<void>;
  sendCommand(target: DebuggerTarget, method: string, params: CdpRecord): Promise<CdpRecord>;
  onDebuggerEvent?(
    listener: (source: CdpRecord, method: string, params: CdpRecord) => void | Promise<void>,
  ): () => void;
};

export type DriverAction = BrowserAction & {
  kind: Exclude<BrowserActionKind, "fill_form">;
};
export type DriverContext = { commandId?: string };

export type DriverError = Error & { code: string; detail?: string };
export type DriverRecord = Record<string, unknown>;
export type ChangeRecord = Record<string, unknown>;

export type InputDispatchScope = {
  pointerMove(point: Point): Promise<void>;
  mouseDown(button: string): Promise<void>;
  mouseUp(button: string): Promise<void>;
  chord(keys: string[]): Promise<void>;
  insertText(text: string): Promise<void>;
  keyPress(key: string): Promise<void>;
  wheel(point: Point, delta: Point): Promise<void>;
};

export type ObserveOptions = {
  maxNodes?: number;
  query?: string;
  roles?: string[];
  includeInteractive?: boolean;
  mode?: "full" | "diff" | "text";
  maxChars?: number;
};

export type ScreenshotOptions = {
  sensitiveZones?: NonNullable<BrowserAction["sensitiveZones"]>;
  fullPage?: boolean;
  clip?: NonNullable<BrowserAction["clip"]>;
  format?: "png" | "jpeg";
  quality?: number;
};

export type InteractiveFilters = { requestedRoles?: Set<string>; filterText?: string };
export type DriverObservationNode = {
  ref: string;
  role: string;
  name?: string;
  value?: string;
  bbox?: number[];
  route?: TargetRoute;
  [key: string]: unknown;
};
export type FullObservation = DriverRecord & { origin: string; title: string; nodes: DriverObservationNode[] };
export type DeltaObservation = DriverRecord & { origin: string; title: string; added: DriverObservationNode[]; removed: string[]; updated: DriverRecord[] };
export type TextObservation = DriverRecord & { origin: string; title: string; text: string };
export type DriverObservation = FullObservation | DeltaObservation | TextObservation;
export type TargetResolution = TargetRoute & { backendNodeId?: number; point?: Point; origin?: string };
export type WaitResult = { matched: boolean; reason?: string };
export type PageSignature = { url: string; title: string };
export type ActionSignalWindow = { finish(): ActiveActionSignals };
export type NormalizedTarget = {
  ref?: string;
  role?: string;
  name?: string;
  label?: string;
  placeholder?: string;
  testId?: string;
  selector?: string;
  text?: string;
  exact?: boolean;
  coordinates?: Point;
};
export type NormalizedWait = {
  url?: string;
  title?: string;
  text?: string;
  selector?: string;
  role?: string;
  name?: string;
  ref?: string;
  value?: string;
  state?: string;
  timeoutMs?: number;
};

export type ActiveActionSignals = {
  navigation?: boolean;
  networkWrite?: boolean;
  dialog?: boolean;
  download?: boolean;
  newTarget?: boolean;
  containmentPrevention?: string | null;
};

export type PendingDialogRoute = CdpRoute & { targetKey?: string };
export type HeldTarget = { targetId: string; sessionId: string; type: string; reason: string };
export type Viewport = { width: number; height: number };
export type Point = { x: number; y: number };
export type Box = Point & { width: number; height: number };
export type ObservationNodeSnapshot = Record<string, unknown> & { ref?: string; role?: string; name?: string; value?: string; bbox?: number[]; state?: DriverRecord };
export type ConsoleEntry = { level?: string; text?: string; source?: string; at?: string };
export type NetworkEntry = { requestId?: string; method?: string; url?: string; status?: number; resourceType?: string; mimeType?: string; bytes?: number; failed?: boolean; at?: string };
export type TargetRoute = CdpRoute & {
  targetId?: string;
  frameId?: string | null;
  frameOrigin?: string;
  frameOrdinal?: number | null;
  origin?: string;
  documentEpoch?: number;
  backendNodeId?: number;
  ref?: string;
};
