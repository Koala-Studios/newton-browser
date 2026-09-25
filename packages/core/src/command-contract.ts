export const ENGINE_ERRORS = [
  "invalid_arguments", "command_id_conflict", "command_expired", "command_sequence_gap",
  "queue_full", "session_closed", "session_quarantined", "cancelled", "timed_out",
  "not_found", "ambiguous", "search_incomplete", "stale_target", "target_moved", "target_not_editable",
  "sensitive_target", "evidence_unavailable", "input_failed", "read_failed",
  "navigation_failed", "connection_lost", "cleanup_uncertain", "unsupported_capability",
  "output_budget", "work_limit", "unknown_command", "unknown_page", "cursor_expired",
  "dialog_opened", "unsupported_structure", "invalid_file_path", "file_not_found", "symlink_not_allowed",
  "file_too_large", "file_total_too_large", "file_type_not_allowed", "file_changed",
] as const;
export type EngineErrorCode = typeof ENGINE_ERRORS[number];
export class EngineError extends Error {
  readonly code: EngineErrorCode;
  constructor(code: EngineErrorCode) { super(code); this.name = "EngineError"; this.code = code; }
}
export function engineErrorCode(error: unknown): EngineErrorCode {
  return error instanceof EngineError ? error.code : "evidence_unavailable";
}
export type EngineDispatch = "not_started" | "attempted" | "acknowledged";
export type EngineFinish = "completed" | "rejected" | "failed" | "cancelled" | "timed_out";
export type EnginePostcondition =
  | Readonly<{ state: "not_requested" }>
  | Readonly<{ state: "met" | "not_met" | "unknown"; kind: "value" | "navigation" | "visible" | "files" | "viewport" }>;
export type EngineTarget =
  | Readonly<{ kind: "ref"; ref: string }>
  | Readonly<{ kind: "selector"; selector: string }>
  | Readonly<{ kind: "semantic"; role: string; name: string; exact: boolean }>;
export type EngineWaitFor = Readonly<{
  url?: string; title?: string; text?: string; selector?: string; role?: string; name?: string; ref?: string; value?: string;
  state?: "attached" | "detached" | "visible" | "hidden" | "checked" | "unchecked" | "value";
  timeoutMs?: number;
}>;
export type EngineFill = Readonly<{ kind: "fill"; target: EngineTarget; value: string }>;
export type EngineType = Readonly<{ kind: "type"; target: EngineTarget; value: string }>;
export type EngineClear = Readonly<{ kind: "clear"; target: EngineTarget }>;
export type EngineEdit = Readonly<{kind:'edit';target:EngineTarget;match:string;replacement:string;prefix?:string;suffix?:string;occurrence?:number}>;
export type EngineClick = Readonly<{ kind: "click"; target: EngineTarget; button?: "left" | "right" | "middle"; clickCount?: number; waitFor?: EngineWaitFor }>;
export type EngineHover = Readonly<{ kind: "hover"; target: EngineTarget; waitFor?: EngineWaitFor }>;
export type EngineClickAt = Readonly<{ kind: "click_at" | "move"; captureId: string; x: number; y: number; waitFor?: EngineWaitFor }>;
export type EngineSelect = Readonly<{ kind: "select"; target: EngineTarget; value: string }>;
export type EnginePress = Readonly<{ kind: "press"; target?: EngineTarget; keys?: readonly string[]; text?: string }>;
export type EngineScroll = Readonly<{ kind: "scroll"; x: number; y: number; target?: EngineTarget }>;
export type EngineNavigate = Readonly<{ kind: "navigate"; url: string }>;
export type EngineHistory = Readonly<{ kind: "back" | "forward" | "reload" }>;
export type EngineWait = Readonly<{ kind: "wait_for"; waitFor: EngineWaitFor }>;
export type EngineDialog = Readonly<{ kind: "dialog_accept" | "dialog_dismiss"; dialogId: string; promptText?: string }>;
export type EngineResize = Readonly<{kind:'resize';width:number;height:number}>;
export type EngineSetFiles = Readonly<{kind:'set_files';target:EngineTarget;files:readonly string[]}>;
export type EngineInputAction = EngineFill | EngineType | EngineClear | EngineEdit | EngineClick | EngineHover | EngineClickAt | EngineSelect | EnginePress | EngineScroll | EngineNavigate | EngineHistory | EngineWait | EngineDialog | EngineResize | EngineSetFiles;
export type EngineAction = EngineInputAction | Readonly<{ kind: "sequence"; steps: readonly EngineInputAction[] }>;
export type EngineCommand = Readonly<{
    commandId: number; pageId?: string; action: EngineAction; timeoutMs: number;
  observe: "local" | "none"; maxBytes: number;
}>;
export type EnginePageStamp = Readonly<{ pageId: string; frameId: string; documentGeneration: number }>;
export type EngineStepReceipt = Readonly<{
  index: number; dispatch: EngineDispatch; postcondition: EnginePostcondition; errorCode?: EngineErrorCode;
}>;
export type EngineFieldView = Readonly<{
  ref: string; recordId?: string; role: string; name: string; value?: string; readonly?: boolean; disabled?: boolean;
  checked?: boolean | "mixed"; selected?: boolean; expanded?: boolean; required?: boolean; href?: string; elementType?: string;
  context?: readonly Readonly<{ role: string; name: string }>[];
  invalid?: boolean; validation?: readonly string[]; description?: string;
  fileNames?: readonly string[]; fileCount?: number;
}>;
/** Narrow an observation to controls with this role and/or containing this text (name, description or context). */
export type EngineControlQuery = Readonly<{ role?: string; text?: string }>;
export type EngineControlRecord = EngineFieldView & Readonly<{ recordId: string; kind: "control" | "link" }>;
export type EngineTableRecord = Readonly<{
  kind:"table";recordId:string;ref:string;name:string;coverage:"rendered";
  columns:readonly {id:string;headerIds:readonly string[]}[];
  rows:readonly {id:string;groupId:string;slots:readonly (string|null)[]}[];
  cells:readonly {id:string;row:number;column:number;rowSpan:number;colSpan:number;header:boolean;text:string;
    links:readonly {label:string;href:string}[];headerIds:readonly string[];headersUnresolved:boolean}[];
  complete:boolean;
}>;
export type EngineFormRecord = Readonly<{kind:"form";recordId:string;ref:string;name:string;fields:readonly EngineFieldView[];complete:boolean}>;
export type EngineObservationRecord = EngineControlRecord | EngineTableRecord | EngineFormRecord;
export type EngineRecordShape = 'controls'|'links'|'table'|'form';
/** A non-reset delta replaces records with an empty array. Apply removals and
 * upserts to the named baseline, refresh unchanged refs (including form fields),
 * then apply order. A reset instead supplies the full records array. */
export type EngineObservationDelta = Readonly<{
  baseSnapshotId: string; reset?: boolean;
  resetReason?: 'baseline_unavailable'|'incompatible_scope'|'document_changed'|'incomplete_view'|'full_more_compact';
  added: readonly EngineObservationRecord[]; removed: readonly string[]; changed: readonly EngineObservationRecord[];
  refs?: readonly {recordId:string;ref:string}[]; order?: readonly string[];
}>;
export type EngineObservation =
  | Readonly<{ state: "none" }>
  | Readonly<{ state: "unavailable"; errorCode: EngineErrorCode }>
  | Readonly<{ state: "available" | "incomplete"; trust: "untrusted_page_content";
      scope: "target" | "page" | "document" | "dialog"; snapshotId?: string; expiredSnapshots?: readonly string[];
      page?: EnginePageStamp; incompleteReason?: "output_limit" | "work_limit" | "rendered_subset" | "evidence_unavailable";
      title?: string; url?: string;
      newPages?: readonly (EnginePageStamp & {openerPageId?:string;selected:boolean;title?:string;url?:string})[];
      newPagesIncomplete?: boolean;
      navigation?: Readonly<{ state: "pending"; url?: string }>;
      dialog?: Readonly<{ dialogId: string; type: "alert" | "confirm" | "prompt" | "beforeunload"; message: string }>;
      nodes: readonly EngineFieldView[]; records?: readonly EngineObservationRecord[]; delta?: EngineObservationDelta; text?: string; cursor?: string; complete?: boolean; imageData?: string; mimeType?: string;
      provenance?: Readonly<{ pageId: string; documentGeneration: number; captureId: string; viewport: Readonly<{ width: number; height: number }>; clip: Readonly<{ x: number; y: number; width: number; height: number }>; maskDisposition: "mask_applied" | "mask_not_configured" | "mask_not_applicable" }> }>;
export type EngineReceipt = Readonly<{
  sessionId: string; commandId: number; state: "finished"; reason: EngineFinish;
  dispatch: EngineDispatch; postcondition: EnginePostcondition; nextCommandId: number;
  page: EnginePageStamp; steps: readonly EngineStepReceipt[]; stoppedAt?: number;
  errorCode?: EngineErrorCode; observation: EngineObservation;
}>;
export type EngineCommandState = Readonly<{
  commandId: number; state: "queued" | "running" | "reconciling"; dispatch: EngineDispatch;
}> | EngineReceipt;
export const ENGINE_LIMITS = Object.freeze({
  queueItems: 32, queueBytes: 1024 * 1024, terminalRecords: 256, terminalTtlMs: 600_000,
  batchSteps: 32, defaultTimeoutMs: 10_000, maxTimeoutMs: 120_000,
  defaultOutputBytes: 8192, maxOutputBytes: 65536, maxInputPrimitives: 256,
  // Image blocks carry base64 pixels rather than model-readable text.
  defaultScreenshotBytes: 2 * 1024 * 1024, maxScreenshotBytes: 4 * 1024 * 1024,
});

export function exactObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new EngineError("invalid_arguments");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => !keys.includes(key))) throw new EngineError("invalid_arguments");
  return record;
}
export function boundedString(value: unknown, max: number, empty = false): string {
  if (typeof value !== "string" || (!empty && !value.length) || value.length > max || value.includes("\0")) {
    throw new EngineError("invalid_arguments");
  }
  return value;
}
export function boundedInteger(value: unknown, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) throw new EngineError("invalid_arguments");
  return Number(value);
}
export function parseEngineTarget(raw: unknown): EngineTarget {
  const value = exactObject(raw, ["kind", "ref", "selector", "role", "name", "exact"]);
  if (value.kind === "ref") {
    exactObject(raw, ["kind", "ref"]);
    return Object.freeze({ kind: "ref", ref: boundedString(value.ref, 120) });
  }
  if (value.kind === "selector") {
    exactObject(raw, ["kind", "selector"]);
    return Object.freeze({ kind: "selector", selector: boundedString(value.selector, 1024) });
  }
  if (value.kind === "semantic") {
    exactObject(raw, ["kind", "role", "name", "exact"]);
    if (value.exact !== undefined && typeof value.exact !== "boolean") throw new EngineError("invalid_arguments");
    return Object.freeze({ kind: "semantic", role: boundedString(value.role, 80), name: boundedString(value.name, 1024), exact: value.exact !== false });
  }
  throw new EngineError("invalid_arguments");
}
function parseFill(raw: unknown): EngineFill {
  const value = exactObject(raw, ["kind", "target", "value"]);
  if (value.kind !== "fill") throw new EngineError("unsupported_capability");
  return Object.freeze({ kind: "fill", target: parseEngineTarget(value.target), value: boundedString(value.value, 65536, true) });
}
function parseType(raw: unknown): EngineType {
  const value = exactObject(raw, ["kind", "target", "value"]);
  if (value.kind !== "type") throw new EngineError("unsupported_capability");
  return Object.freeze({ kind: "type", target: parseEngineTarget(value.target), value: boundedString(value.value, 65536, true) });
}
function parseClear(raw: unknown): EngineClear {
  const value = exactObject(raw, ["kind", "target"]);
  if (value.kind !== "clear") throw new EngineError("unsupported_capability");
  return Object.freeze({ kind: "clear", target: parseEngineTarget(value.target) });
}
function parseEdit(raw:unknown):EngineEdit {
  const value=exactObject(raw,['kind','target','match','replacement','prefix','suffix','occurrence']);
  return Object.freeze({kind:'edit',target:parseEngineTarget(value.target),match:boundedString(value.match,4096),replacement:boundedString(value.replacement,65536,true),
    ...(value.prefix===undefined?{}:{prefix:boundedString(value.prefix,4096,true)}),
    ...(value.suffix===undefined?{}:{suffix:boundedString(value.suffix,4096,true)}),
    ...(value.occurrence===undefined?{}:{occurrence:boundedInteger(value.occurrence,1,65536)})});
}
function parseWaitFor(raw: unknown): EngineWaitFor {
  const value = exactObject(raw, ["url", "title", "text", "selector", "role", "name", "ref", "value", "state", "timeoutMs"]);
  const output: Record<string, unknown> = {};
  for (const key of ["url", "title", "text", "selector", "role", "name", "ref", "value"] as const) {
    if (value[key] !== undefined) output[key] = boundedString(value[key], key === "role" ? 80 : key === "ref" ? 120 : 1024, key === "value");
  }
  if (value.state !== undefined && (typeof value.state !== "string" || !["attached", "detached", "visible", "hidden", "checked", "unchecked", "value"].includes(value.state))) throw new EngineError("invalid_arguments");
  if (value.state !== undefined) output.state = value.state;
  if (value.timeoutMs !== undefined) output.timeoutMs = boundedInteger(value.timeoutMs, 1, 120_000);
  const semantic = value.role !== undefined || value.name !== undefined;
  const targets = Number(value.ref !== undefined) + Number(value.selector !== undefined) + Number(semantic);
  if (targets > 1 || (semantic && (value.role === undefined || value.name === undefined))) throw new EngineError("invalid_arguments");
  if (value.state !== undefined && targets !== 1) throw new EngineError("invalid_arguments");
  if ((value.state === "value") !== (value.value !== undefined)) throw new EngineError("invalid_arguments");
  if (!targets && value.url === undefined && value.title === undefined && value.text === undefined) throw new EngineError("invalid_arguments");
  return Object.freeze(output as EngineWaitFor);
}
function parseClick(raw: unknown): EngineClick {
  const value = exactObject(raw, ["kind", "target", "waitFor", "button", "clickCount"]);
  if (value.kind !== "click") throw new EngineError("unsupported_capability");
  if (value.button !== undefined && value.button !== "left" && value.button !== "right" && value.button !== "middle") throw new EngineError("invalid_arguments");
  return Object.freeze({ kind: "click", target: parseEngineTarget(value.target), ...(value.button === undefined ? {} : { button: value.button }), ...(value.clickCount === undefined ? {} : { clickCount: boundedInteger(value.clickCount, 1, 3) }), ...(value.waitFor === undefined ? {} : { waitFor: parseWaitFor(value.waitFor) }) });
}
function parseClickAt(raw: unknown): EngineClickAt {
  const value = exactObject(raw, ["kind", "captureId", "x", "y", "waitFor"]);
  if ((value.kind !== "click_at" && value.kind !== "move") || typeof value.x !== "number" || !Number.isFinite(value.x) || typeof value.y !== "number" || !Number.isFinite(value.y)) throw new EngineError("invalid_arguments");
  return Object.freeze({ kind: value.kind, captureId: boundedString(value.captureId, 120), x: value.x, y: value.y, ...(value.waitFor === undefined ? {} : { waitFor: parseWaitFor(value.waitFor) }) });
}
function parseSelect(raw: unknown): EngineSelect {
  const value = exactObject(raw, ["kind", "target", "value"]);
  if (value.kind !== "select") throw new EngineError("unsupported_capability");
  return Object.freeze({ kind: "select", target: parseEngineTarget(value.target), value: boundedString(value.value, 65536, true) });
}
function parsePress(raw: unknown): EnginePress {
  const value = exactObject(raw, ["kind", "target", "keys", "text"]);
  if (value.kind !== "press") throw new EngineError("unsupported_capability");
  const keys = value.keys === undefined ? undefined : (() => {
    if (!Array.isArray(value.keys) || !value.keys.length || value.keys.length > 8) throw new EngineError("invalid_arguments");
    return Object.freeze(value.keys.map(key => boundedString(key, 80)));
  })();
  const text = value.text === undefined ? undefined : boundedString(value.text, 65536, true);
  if (!keys && text === undefined) throw new EngineError("invalid_arguments");
  return Object.freeze({ kind: "press", ...(value.target === undefined ? {} : { target: parseEngineTarget(value.target) }), ...(keys ? { keys } : {}), ...(text === undefined ? {} : { text }) });
}
function parseScroll(raw: unknown): EngineScroll {
  const value = exactObject(raw, ["kind", "x", "y", "target"]);
  if (value.kind !== "scroll" || typeof value.x !== "number" || !Number.isFinite(value.x) || typeof value.y !== "number" || !Number.isFinite(value.y)) throw new EngineError("invalid_arguments");
  return Object.freeze({ kind: "scroll", x: value.x, y: value.y, ...(value.target === undefined ? {} : { target: parseEngineTarget(value.target) }) });
}
function parseNavigate(raw: unknown): EngineNavigate {
  const value = exactObject(raw, ["kind", "url"]);
  if (value.kind !== "navigate") throw new EngineError("unsupported_capability");
  return Object.freeze({ kind: "navigate", url: normalizeEngineUrl(value.url) });
}
function parseHistory(raw: unknown): EngineHistory {
  const value = exactObject(raw, ["kind"]);
  if (value.kind !== "back" && value.kind !== "forward" && value.kind !== "reload") throw new EngineError("unsupported_capability");
  return Object.freeze({ kind: value.kind });
}
function parseWait(raw: unknown): EngineWait {
  const value = exactObject(raw, ["kind", "waitFor"]);
  if (value.kind !== "wait_for") throw new EngineError("unsupported_capability");
  return Object.freeze({ kind: "wait_for", waitFor: parseWaitFor(value.waitFor) });
}
function parseInputAction(raw: unknown): EngineInputAction {
  const value = exactObject(raw, ["kind", "target", "value", "waitFor", "keys", "text", "x", "y", "url", "captureId", "wait_for", "dialogId", "promptText", "button", "clickCount", "files", "width", "height", "match", "replacement", "prefix", "suffix", "occurrence"]);
  if(value.kind==='resize'){
    exactObject(raw,['kind','width','height']);
    return Object.freeze({kind:'resize',width:boundedInteger(value.width,320,7680),height:boundedInteger(value.height,240,4320)});
  }
  if(value.kind==='set_files'){
    exactObject(raw,['kind','target','files']);
    if(!Array.isArray(value.files)||value.files.length<1||value.files.length>8)throw new EngineError('invalid_arguments');
    return Object.freeze({kind:'set_files',target:parseEngineTarget(value.target),files:Object.freeze(value.files.map(file=>boundedString(file,32768)))});
  }
  if (value.kind === "hover") {
    exactObject(raw, ["kind", "target", "waitFor"]);
    return Object.freeze({ kind: "hover", target: parseEngineTarget(value.target), ...(value.waitFor === undefined ? {} : { waitFor: parseWaitFor(value.waitFor) }) });
  }
  if (value.kind === "dialog_accept" || value.kind === "dialog_dismiss") {
    exactObject(raw, ["kind", "dialogId", ...(value.kind === "dialog_accept" ? ["promptText"] : [])]);
    return Object.freeze({ kind: value.kind, dialogId: boundedString(value.dialogId, 120), ...(value.promptText === undefined ? {} : { promptText: boundedString(value.promptText, 65536, true) }) });
  }
  if (value.kind === "fill") return parseFill(raw);
  if (value.kind === "type") return parseType(raw);
  if (value.kind === "clear") return parseClear(raw);
  if (value.kind === "edit") return parseEdit(raw);
  if (value.kind === "click") return parseClick(raw);
  if (value.kind === "click_at" || value.kind === "move") return parseClickAt(raw);
  if (value.kind === "select") return parseSelect(raw);
  if (value.kind === "press") return parsePress(raw);
  if (value.kind === "scroll") return parseScroll(raw);
  if (value.kind === "navigate") return parseNavigate(raw);
  if (value.kind === "back" || value.kind === "forward" || value.kind === "reload") return parseHistory(raw);
  if (value.kind === "wait_for") return parseWait(raw);
  throw new EngineError("unsupported_capability");
}
export function parseEngineCommand(raw: unknown): EngineCommand {
  const input = exactObject(raw, ["commandId", "pageId", "action", "timeoutMs", "observe", "maxBytes"]);
  const value = exactObject(input.action, ["kind", "target", "value", "steps", "waitFor", "keys", "text", "x", "y", "url", "captureId", "wait_for", "dialogId", "promptText", "button", "clickCount", "files", "width", "height", "match", "replacement", "prefix", "suffix", "occurrence"]);
  let action: EngineAction;
  if (value.kind === "sequence") {
    exactObject(value, ["kind", "steps"]);
    if (!Array.isArray(value.steps) || !value.steps.length || value.steps.length > ENGINE_LIMITS.batchSteps) throw new EngineError("invalid_arguments");
    action = Object.freeze({ kind: "sequence", steps: Object.freeze(value.steps.map(parseInputAction)) });
  } else action = parseInputAction(input.action);
  if (input.observe !== undefined && input.observe !== "local" && input.observe !== "none") throw new EngineError("invalid_arguments");
  const maxBytes = boundedInteger(input.maxBytes ?? ENGINE_LIMITS.defaultOutputBytes, 2048, ENGINE_LIMITS.maxOutputBytes);
  // Bounded host fields and one small step record per input; reserve before input.
  const required = 1536 + (action.kind === "sequence" ? action.steps.length : 1) * 192;
  if (maxBytes < required) throw new EngineError("output_budget");
  return Object.freeze({ commandId: boundedInteger(input.commandId, 1, Number.MAX_SAFE_INTEGER),
    ...(input.pageId === undefined ? {} : { pageId: boundedString(input.pageId, 120) }), action,
    timeoutMs: boundedInteger(input.timeoutMs ?? ENGINE_LIMITS.defaultTimeoutMs, 1, ENGINE_LIMITS.maxTimeoutMs),
    observe: input.observe === "none" ? "none" : "local", maxBytes });
}
export function normalizeEngineUrl(raw: unknown): string {
  const text = boundedString(raw, 8192);
  let url: URL;
  try { url = new URL(text); } catch { throw new EngineError("invalid_arguments"); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new EngineError("invalid_arguments");
  return url.href;
}
