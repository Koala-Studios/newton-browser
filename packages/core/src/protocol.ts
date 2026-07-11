export const NEWTON_BROWSER_MODULE_ID = "newton-browser";

export const BROWSER_ACTION_KINDS = [
  "observe",
  "screenshot",
  "click",
  "fill",
  "type",
  "select",
  "scroll",
  "navigate",
  "back",
  "forward",
  "reload",
  "press",
  "clear",
  "set_files",
  "hover",
  "move",
  "wait_for",
  "dialog_accept",
  "dialog_dismiss",
  "resize",
] as const;

export type BrowserActionKind = (typeof BROWSER_ACTION_KINDS)[number];

export const BROWSER_CONTROL_TRANSPORTS = ["auto", "local_ephemeral", "local_dev_durable"] as const;

export type BrowserControlTransportMode = (typeof BROWSER_CONTROL_TRANSPORTS)[number];

export const BROWSER_ACTION_RESULT_STATUSES = [
  "verified",
  "dispatched_unverified",
  "needs_approval",
  "blocked",
  "not_found",
  "ambiguous",
  "stale_target",
  "timed_out",
  "failed",
] as const;

export type BrowserActionResultStatus = (typeof BROWSER_ACTION_RESULT_STATUSES)[number];

export const BROWSER_RISK_CLASSES = ["read_only", "agentic", "approval_required", "blocked"] as const;

export type BrowserRiskClass = (typeof BROWSER_RISK_CLASSES)[number];

export const BROWSER_COMMAND_STATUSES = [
  "queued",
  "claimed",
  "running",
  "succeeded",
  "failed",
  "needs_approval",
  "blocked",
  "expired",
  "cancelled",
] as const;

export type BrowserCommandStatus = (typeof BROWSER_COMMAND_STATUSES)[number];

export const BROWSER_SESSION_STATUSES = ["active", "stopped", "expired"] as const;

export type BrowserSessionStatus = (typeof BROWSER_SESSION_STATUSES)[number];

export type BrowserTarget =
  | { ref: string }
  | { role: string; name?: string; exact?: boolean }
  | { text: string; exact?: boolean }
  | { label: string; exact?: boolean }
  | { placeholder: string; exact?: boolean }
  | { testId: string }
  | { selector: string }
  | { coordinates: { x: number; y: number } };

export type BrowserWaitFor = {
  url?: string;
  title?: string;
  text?: string;
  selector?: string;
  role?: string;
  name?: string;
  ref?: string;
  state?: "attached" | "detached" | "visible" | "hidden" | "checked" | "unchecked" | "value";
  value?: string;
  timeoutMs?: number;
};

export type BrowserAction = {
  kind: BrowserActionKind;
  target?: BrowserTarget;
  waitFor?: BrowserWaitFor;
  ref?: string;
  role?: string;
  name?: string;
  label?: string;
  placeholder?: string;
  testId?: string;
  exact?: boolean;
  value?: string;
  url?: string;
  text?: string;
  selector?: string;
  query?: string;
  maxNodes?: number;
  timeoutMs?: number;
  x?: number;
  y?: number;
  keys?: string[];
  files?: string[];
  sensitiveZones?: Array<{ selector?: string; name?: string; label?: string }>;
  checked?: boolean;
  intent?: string;
  // Screenshot capture options (Proposal 29 / D5): full scroll-down page, a wait
  // before capture, a device render, an explicit clip, and inline image return.
  fullPage?: boolean;
  device?: "mobile" | "desktop";
  waitMs?: number;
  inline?: boolean;
  clip?: { x: number; y: number; width: number; height: number };
  // Observation mode (Proposal 29 / D6): "diff" returns added/removed/updated;
  // "text" (WS9.1) returns bounded, redacted readable page text.
  mode?: "full" | "diff" | "text";
  // Character cap for `mode: "text"` observations.
  maxChars?: number;
  // Text supplied to a `dialog_accept` on a JavaScript prompt() dialog (WS9.4).
  // Ignored for alert/confirm/beforeunload dialogs and for dialog_dismiss.
  promptText?: string;
  // Owned-tab viewport for the `resize` act kind (WS9.6). Applied via CDP device
  // metrics and re-applied if the debugger re-attaches. Owned tabs only.
  viewport?: { width: number; height: number };
};

// A page-initiated JavaScript dialog awaiting a decision (WS9.4). Surfaced in
// observation/status so an agent can see it must accept or dismiss before the
// renderer will respond again. The message is redacted like other page text.
export type BrowserPendingDialog = {
  dialogType: "alert" | "confirm" | "prompt" | "beforeunload";
  message: string;
  defaultPrompt?: string;
};

export type BrowserTabRef = {
  tabId?: number;
  windowId?: number;
  origin?: string;
  title?: string;
};

// What the floor concluded about how far the action commits. `none` = a pure
// read or in-page move; `draft` = edits a draft field; `commit` = a recorded
// save/submit-like action; `external_effect` = an irreversible outward action
// (publish/pay/budget/account). Newton Browser treats these as risk
// metadata, not a human approval layer.
export const BROWSER_COMMIT_BOUNDARIES = ["none", "draft", "commit", "external_effect"] as const;

export type BrowserCommitBoundary = (typeof BROWSER_COMMIT_BOUNDARIES)[number];

// Observed/structural facts the driver feeds the floor. Page prose is never a
// signal; only structure (form ownership, submit role) and observed events
// (navigation, network write, dialog, download) count (§7).
export type BrowserSignals = {
  formSubmit?: boolean;        // resolved element is a submit button / owns a form submit
  navigation?: boolean;        // observed navigation (reconciliation only)
  networkWrite?: boolean;      // observed non-GET network request (reconciliation only)
  dialog?: boolean;            // a JS dialog opened
  download?: boolean;          // a download started
  crossOrigin?: boolean;       // target frame origin differs from the granted origin
  newTarget?: boolean;         // a popup/new tab was created
  secretField?: boolean;       // resolved input is a password/secret field
};

export type BrowserFloorEvidence = { kind: string; value: string | boolean };

export type BrowserFloorDecision = {
  class: BrowserRiskClass;
  permissionRequired: "newton_browser.observe" | "newton_browser.act" | "newton_browser.agentic_session";
  approvalRequired: boolean;
  blocked: boolean;
  reasons: string[];
  // Added in B3. Optional so older persisted decisions stay valid.
  commitBoundary?: BrowserCommitBoundary;
  // Surfaced only when the floor needs to explain a risk/block result.
  evidence?: BrowserFloorEvidence[];
};

export type BrowserObservationNode = {
  ref: string;
  role: string;
  name?: string;
  value?: string;
  disabled?: boolean;
  bbox?: { x: number; y: number; width: number; height: number };
  target?: BrowserTarget;
};

export type BrowserObservationResult = {
  kind: "observation";
  mode: "passive" | "cdp";
  origin: string;
  title: string;
  nodes: BrowserObservationNode[];
  nodeCount: number;
  truncated: boolean;
  capturedAt: string;
  actionStatus?: BrowserActionResultStatus;
  verified?: boolean;
  reason?: string;
  changed?: Record<string, unknown>;
  // Set when a page-initiated JavaScript dialog is blocking the renderer (WS9.4).
  pendingDialog?: BrowserPendingDialog;
};

export type BrowserScreenshotResult = {
  kind: "screenshot";
  mode: "cdp";
  origin: string;
  title: string;
  artifactId?: string;
  width?: number;
  height?: number;
  capturedAt: string;
  // Proposal 29 / D5. `dataUrl` is the inline base64 image (only when the caller
  // requested it) and is NEVER persisted — it is stripped before any DB write.
  dataUrl?: string;
  device?: "mobile" | "desktop" | "viewport";
  fullPage?: boolean;
  truncated?: boolean;
};

// A compact observation delta (Proposal 29 / D6): what changed since the prior
// observation, instead of a full re-snapshot. `updated` carries only the refs
// whose accessible name/value changed; `added` carries new nodes (with bbox for
// targeting); `removed` lists refs that are gone.
export type BrowserObservationDelta = {
  kind: "observation_delta";
  mode: "cdp";
  origin: string;
  title: string;
  added: BrowserObservationNode[];
  removed: string[];
  updated: Array<{ ref: string; name?: string; value?: string }>;
  nodeCount: number;
  capturedAt: string;
  actionStatus?: BrowserActionResultStatus;
  verified?: boolean;
  reason?: string;
  changed?: Record<string, unknown>;
};

// A readable-text observation (WS9.1): the page's main/article text (falling back
// to body innerText), bounded and secret-redacted. Cheaper than a full accessibility
// snapshot when the caller only needs to read prose, not target controls.
export type BrowserObservationText = {
  kind: "observation_text";
  mode: "text";
  origin: string;
  title: string;
  text: string;
  chars: number;
  truncated: boolean;
  capturedAt: string;
  actionStatus?: BrowserActionResultStatus;
  verified?: boolean;
  reason?: string;
};

export type NewtonBrowserResult = BrowserObservationResult | BrowserObservationDelta | BrowserObservationText | BrowserScreenshotResult | { kind: "ack"; message: string };

export type BrowserControlStatus = {
  ok: boolean;
  transport: BrowserControlTransportMode;
  connected: boolean;
  message?: string;
};

export type ListTabsInput = { transport?: BrowserControlTransportMode };

export type ListTabsResult = {
  tabs: Array<BrowserTabRef & { id?: string; active?: boolean; lastSeenAt?: string }>;
};

export type ClaimTabInput = {
  transport?: BrowserControlTransportMode;
  title?: string;
  url?: string;
  tabId?: number;
};

export type ClaimTabResult = {
  sessionId?: string;
  tab: BrowserTabRef;
};

export type ObserveInput = {
  transport?: BrowserControlTransportMode;
  sessionId?: string;
  query?: string;
  maxNodes?: number;
  mode?: "full" | "diff";
};

export type ScreenshotInput = {
  transport?: BrowserControlTransportMode;
  sessionId?: string;
  clip?: { x: number; y: number; width: number; height: number };
  fullPage?: boolean;
  waitMs?: number;
  device?: "mobile" | "desktop";
  inline?: boolean;
};

export type ActInput = {
  transport?: BrowserControlTransportMode;
  sessionId?: string;
  action: BrowserAction;
  idempotencyKey?: string;
  requestedRiskClass?: BrowserRiskClass;
};

export type WaitForInput = {
  transport?: BrowserControlTransportMode;
  sessionId?: string;
  waitFor: BrowserWaitFor;
};

export type FinalizeTabsInput = {
  transport?: BrowserControlTransportMode;
  keep?: Array<{ tabId?: number; sessionId?: string; status: "handoff" | "deliverable" }>;
};

export type ActResult = {
  status: BrowserActionResultStatus;
  verified: boolean;
  reason?: string;
  changed?: Record<string, unknown>;
  observation?: BrowserObservationResult | BrowserObservationDelta;
};

export interface BrowserControlTransport {
  status(): Promise<BrowserControlStatus>;
  listTabs(input: ListTabsInput): Promise<ListTabsResult>;
  claimTab(input: ClaimTabInput): Promise<ClaimTabResult>;
  observe(input: ObserveInput): Promise<BrowserObservationResult>;
  screenshot(input: ScreenshotInput): Promise<BrowserScreenshotResult>;
  act(input: ActInput): Promise<ActResult>;
  waitFor(input: WaitForInput): Promise<ActResult>;
  finalize(input: FinalizeTabsInput): Promise<{ ok: boolean }>;
}
