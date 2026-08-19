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
  "fill_form",
  "console",
  "network",
] as const;

export type BrowserActionKind = (typeof BROWSER_ACTION_KINDS)[number];

export const BROWSER_ACTION_RESULT_STATUSES = [
  "verified",
  "dispatched_unverified",
  "blocked",
  "not_found",
  "ambiguous",
  "stale_target",
  "timed_out",
  "failed",
] as const;

export type BrowserActionResultStatus = (typeof BROWSER_ACTION_RESULT_STATUSES)[number];

export const BROWSER_RISK_CLASSES = ["read_only", "agentic", "blocked"] as const;

export type BrowserRiskClass = (typeof BROWSER_RISK_CLASSES)[number];

export type BrowserCommandOutcome =
  | "not_started"
  | "completed"
  // Proven pre-dispatch refusal only. Once input starts, uncertainty must be
  // reported as outcome_unknown and can never be retry-safe.
  | "prevented"
  | "outcome_unknown";

export type BrowserCommandResultMetadata = {
  sequence: number;
  outcome: BrowserCommandOutcome;
  retrySafe: boolean;
};

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
  roles?: string[];
  includeInteractive?: boolean;
  timeoutMs?: number;
  x?: number;
  y?: number;
  keys?: string[];
  files?: string[];
  sensitiveZones?: Array<{ ref?: string; selector?: string; name?: string; label?: string }>;
  // Screenshot capture options.
  fullPage?: boolean;
  clip?: { x: number; y: number; width: number; height: number };
  // JPEG trades evidence fidelity for a much smaller payload to the model.
  // PNG is the default.
  format?: "png" | "jpeg";
  quality?: number;
  // "diff" returns added/removed/updated; "text" returns bounded, redacted prose.
  mode?: "full" | "diff" | "text";
  // Character cap for `mode: "text"` observations.
  maxChars?: number;
  // Text supplied to a `dialog_accept` on a JavaScript prompt() dialog.
  // Ignored for alert/confirm/beforeunload dialogs and for dialog_dismiss.
  promptText?: string;
  // Isolated-process viewport for the `resize` act kind.
  viewport?: { width: number; height: number };
  // Ordered fields for `fill_form`. Each entry carries the same
  // targeting hints as a fill plus its value. The host expands the batch into
  // sequential fills, each with the full per-field floor, stopping at the first
  // block/failure. Values are redacted in artifacts like any fill value.
  fields?: BrowserFormField[];
  // Filters for the read-only `console` act kind.
  level?: string;
  pattern?: string;
  limit?: number;
  // Filters for the read-only `network` act kind. `requestId` switches from
  // listing request metadata to fetching one response body (origin-gated).
  urlPattern?: string;
  requestId?: string;
};

export type BrowserFormField = {
  ref?: string;
  role?: string;
  name?: string;
  label?: string;
  placeholder?: string;
  testId?: string;
  selector?: string;
  value?: string;
};

// A page-initiated JavaScript dialog awaiting a decision. Surfaced in
// observation/status so an agent can see it must accept or dismiss before the
// renderer will respond again. The message is redacted like other page text.
export type BrowserPendingDialog = {
  dialogType: "alert" | "confirm" | "prompt" | "beforeunload";
  message: string;
  defaultPrompt?: string;
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
// (navigation, dialog, download, new target) count. Network traffic remains
// available through browser.network but is not action-authority evidence.
export type BrowserSignals = {
  formSubmit?: boolean;        // resolved element is a submit button / owns a form submit
  navigation?: boolean;        // observed navigation (reconciliation only)
  dialog?: boolean;            // a JS dialog opened
  download?: boolean;          // a download started
  newTarget?: boolean;         // a popup/new tab was created
  secretField?: boolean;       // resolved input is a password/secret field
};

export type BrowserFloorDecision = {
  class: BrowserRiskClass;
  reason?: string;
  commitBoundary: BrowserCommitBoundary;
};

export type BrowserObservationNode = {
  ref: string;
  role: string;
  name?: string;
  value?: string;
  disabled?: boolean;
  checked?: boolean | "mixed";
  selected?: boolean;
  expanded?: boolean;
  required?: boolean;
  level?: number;
  href?: string;
  elementType?: string;
  bbox?: { x: number; y: number; width: number; height: number };
  documentEpoch?: number;
  frameId?: string;
  frameOrigin?: string;
};

export type BrowserObservationResult = {
  kind: "observation";
  mode: "cdp";
  origin: string;
  title: string;
  nodes: BrowserObservationNode[];
  nodeCount: number;
  truncated: boolean;
  capturedAt: string;
  reason?: string;
  changed?: Record<string, unknown>;
  // Set when a page-initiated JavaScript dialog is blocking the renderer.
  pendingDialog?: BrowserPendingDialog;
};

export type BrowserScreenshotResult = {
  kind: "screenshot";
  mode: "cdp";
  origin: string;
  title: string;
  width?: number;
  height?: number;
  capturedAt: string;
  // Transient base64 image returned to the active MCP request when it is within
  // the 16 MiB cap. Newton does not persist screenshot bytes.
  dataUrl?: string;
  format?: "png" | "jpeg";
  requestedFormat?: "png" | "jpeg";
  fullPage?: boolean;
  truncated?: boolean;
  maskDisposition: "mask_applied" | "mask_not_configured" | "mask_not_applicable";
};

// A compact observation delta: what changed since the prior
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
  updated: Array<{
    ref: string; role?: string; name?: string; value?: string; disabled?: boolean;
    checked?: boolean | "mixed"; selected?: boolean; expanded?: boolean; required?: boolean;
    level?: number; href?: string; elementType?: string; documentEpoch?: number;
    frameId?: string; frameOrigin?: string;
  }>;
  nodeCount: number;
  capturedAt: string;
  reason?: string;
  changed?: Record<string, unknown>;
};

// A readable-text observation: the page's main/article text (falling back
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
  reason?: string;
};

// Buffered console output. Read-only; entries are secret-redacted before
// they reach the client. Headers and raw argument objects are never included —
// only the rendered text, level, and source.
export type BrowserConsoleEntry = {
  level: "log" | "info" | "warn" | "error" | "debug";
  text: string;
  source?: string;
  at: string;
};

export type BrowserConsoleLog = {
  kind: "console_log";
  origin: string;
  entries: BrowserConsoleEntry[];
  count: number;
  dropped: number;
  capturedAt: string;
};

// Buffered network request metadata. Request/response headers are never
// buffered or returned (they carry cookies and auth tokens).
export type BrowserNetworkEntry = {
  requestId: string;
  method: string;
  url: string;
  status?: number;
  resourceType?: string;
  mimeType?: string;
  bytes?: number;
  failed?: boolean;
  at: string;
};

export type BrowserNetworkLog = {
  kind: "network_log";
  origin: string;
  entries: BrowserNetworkEntry[];
  count: number;
  dropped: number;
  capturedAt: string;
  // Present only for a body fetch by requestId.
  body?: { requestId: string; url: string; encoding: "utf-8"; mimeType: string; data: string; byteLength: number; truncated: boolean } | null;
  bodyDisposition?: "text_body_returned" | "opaque_body_not_returned" | "cross_origin_body_not_returned" | "body_unavailable";
  bodyMetadata?: { requestId: string; url: string; mimeType: string; declaredEncoding: string; encodedBytes: number; sha256: string };
  reason?: string;
};

// Created by the MCP host after redaction/projection. Page content and browser
// payloads cannot select this trust label or overwrite its session binding.
export type PageProvenance = {
  trust: "untrusted_page_content";
  origin: string;
  capturedAt?: string;
};

export type NewtonBrowserResult = BrowserObservationResult | BrowserObservationDelta | BrowserObservationText | BrowserScreenshotResult | BrowserConsoleLog | BrowserNetworkLog | { kind: "ack" };
