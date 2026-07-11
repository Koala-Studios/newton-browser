import { BROWSER_ACTION_FIELDS, BROWSER_ACTION_FIELD_SPECS, parseBrowserAction } from "./action-schema.ts";
import { redactJson, redactText } from "./text-redaction.ts";
import type { BrowserAction, BrowserActionResultStatus, NewtonBrowserResult, BrowserTarget, BrowserWaitFor } from "./protocol.ts";

const TEXT_CAP = 240;
const URL_CAP = 500;
const NODE_CAP = 80;
// Hard ceiling for a `mode: "text"` observation after redaction. The driver applies
// the caller's `maxChars`; this bounds the result regardless of what crossed the relay.
const TEXT_OBSERVE_CAP = 200_000;
// Inline screenshot bytes (Proposal 29 / D5) ride result_json transiently (masked
// pre-capture, pruned with the short-TTL command). Cap so a vision worker gets the
// image without bloating Postgres; over the cap we drop bytes and flag truncated.
const MAX_INLINE_IMAGE_CHARS = 23_000_000;
const INLINE_IMAGE_DATA_URL = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;

// Field names that mark a sensitive value, and value shapes that look like a
// card number / CVV / SSN. Such values are withheld from observations and
// deltas so they never reach the model or result_json (S18), independent of the
// screenshot masking.
const SENSITIVE_FIELD_NAME = /password|passcode|secret|token|api[_ -]?key|credential|otp|2fa|one[_ -]?time|verification code|security code|credit[_ -]?card|card[_ -]?number|cardnumber|\bcvv\b|\bcvc\b|\bccv\b|\bssn\b|social[_ -]?security|\biban\b|routing[_ -]?number|account[_ -]?number|sort[_ -]?code|tax[_ -]?id/i;
const CARD_LIKE = /(?:\d[ -]?){13,19}/;
const SSN_LIKE = /\b\d{3}-\d{2}-\d{4}\b/;

// Free page text can contain card/SSN sequences that the keyed field redaction never
// sees. Run the standard secret/PII pass, then mask bare card- and SSN-like digit runs.
function redactObservationText(value: string): string {
  return redactText(value)
    .replace(/\b\d{3}-\d{2}-\d{4}\b/g, "[REDACTED_SSN]")
    .replace(/\b(?:\d[ -]?){13,19}\b/g, (match) => (/\d{13,19}/.test(match.replace(/[ -]/g, "")) ? "[REDACTED_CARD]" : match));
}

// Redact a pending JS dialog (WS9.4) for inclusion in an observation. The message
// and default prompt are page-authored text and pass the observation-text redaction
// (card/SSN masking) so a dialog can never leak a secret the field passes miss.
function redactPendingDialog(value: unknown): { pendingDialog: { dialogType: "alert" | "confirm" | "prompt" | "beforeunload"; message: string; defaultPrompt?: string } } | Record<string, never> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const type = String(raw.dialogType ?? "");
  if (!["alert", "confirm", "prompt", "beforeunload"].includes(type)) return {};
  const dialogType = type as "alert" | "confirm" | "prompt" | "beforeunload";
  return {
    pendingDialog: {
      dialogType,
      message: redactObservationText(String(raw.message ?? "")).slice(0, TEXT_CAP),
      ...(typeof raw.defaultPrompt === "string" ? { defaultPrompt: redactObservationText(raw.defaultPrompt).slice(0, TEXT_CAP) } : {}),
    },
  };
}

function redactSensitiveValue(name: string, value: string): string {
  if (SENSITIVE_FIELD_NAME.test(name) || SENSITIVE_FIELD_NAME.test(value)) return "[REDACTED]";
  const stripped = value.replace(/[ -]/g, "");
  if (SSN_LIKE.test(value) || (CARD_LIKE.test(value) && /^\d{13,19}$/.test(stripped))) return "[REDACTED]";
  return redactText(value).slice(0, TEXT_CAP);
}

export function redactBrowserAction(action: BrowserAction): BrowserAction {
  const parsed = parseBrowserAction(action);
  const output: BrowserAction = { kind: parsed.kind };
  const writable = output as Record<string, unknown>;
  for (const key of BROWSER_ACTION_FIELDS) {
    const value = parsed[key];
    if (value === undefined) continue;
    const spec = BROWSER_ACTION_FIELD_SPECS[key];
    if (spec.kind === "target") {
      const target = redactBrowserTarget(value);
      if (target) writable[key] = target;
    } else if (spec.kind === "waitFor") {
      const waitFor = redactBrowserWaitFor(value);
      if (waitFor) writable[key] = waitFor;
    } else if (spec.kind === "secret") {
      writable[key] = "[REDACTED]";
    } else if (spec.kind === "url") {
      writable[key] = redactBrowserUrl(String(value));
    } else if (spec.kind === "text") {
      writable[key] = redactText(String(value)).slice(0, spec.cap);
    } else if (spec.kind === "stringArray" && Array.isArray(value)) {
      writable[key] = value.flatMap((item) => (typeof item === "string" && item.trim() ? [redactText(item).slice(0, spec.itemCap)] : [])).slice(0, spec.cap);
    } else if (spec.kind === "filePaths" && Array.isArray(value)) {
      writable[key] = value.map((item) => String(item).split(/[\\/]/).at(-1) || "[FILE]").slice(0, spec.cap);
    } else if (spec.kind === "sensitiveZones" && Array.isArray(value)) {
      writable[key] = value;
    } else if (spec.kind === "formFields" && Array.isArray(value)) {
      // fill_form values are secrets-in-waiting like any fill value: redact each.
      writable[key] = value.map((field) => {
        const record = field && typeof field === "object" && !Array.isArray(field) ? { ...(field as Record<string, unknown>) } : {};
        if ("value" in record) record.value = "[REDACTED]";
        return record;
      });
    } else {
      writable[key] = value;
    }
  }
  return output;
}

export function summarizeBrowserResult(result: NewtonBrowserResult | null): Record<string, unknown> {
  if (!result) return { kind: null, hasContent: false };
  if (result.kind === "observation") {
    return {
      kind: result.kind,
      mode: result.mode,
      origin: redactBrowserOrigin(result.origin),
      nodeCount: result.nodeCount,
      returnedNodes: result.nodes.length,
      truncated: result.truncated,
      capturedAt: result.capturedAt,
      ...(result.actionStatus ? { actionStatus: result.actionStatus } : {}),
      ...(typeof result.verified === "boolean" ? { verified: result.verified } : {}),
      ...(result.reason ? { reason: redactText(result.reason).slice(0, TEXT_CAP) } : {}),
      ...(result.changed ? { changed: redactBrowserChanged(result.changed) } : {}),
    };
  }
  if (result.kind === "observation_delta") {
    return {
      kind: result.kind,
      mode: result.mode,
      origin: redactBrowserOrigin(result.origin),
      nodeCount: result.nodeCount,
      added: result.added.length,
      removed: result.removed.length,
      updated: result.updated.length,
      capturedAt: result.capturedAt,
      ...(result.actionStatus ? { actionStatus: result.actionStatus } : {}),
      ...(typeof result.verified === "boolean" ? { verified: result.verified } : {}),
      ...(result.reason ? { reason: redactText(result.reason).slice(0, TEXT_CAP) } : {}),
      ...(result.changed ? { changed: redactBrowserChanged(result.changed) } : {}),
    };
  }
  if (result.kind === "screenshot") {
    return {
      kind: result.kind,
      mode: result.mode,
      origin: redactBrowserOrigin(result.origin),
      hasArtifact: Boolean(result.artifactId),
      width: result.width ?? null,
      height: result.height ?? null,
      device: result.device ?? null,
      fullPage: Boolean(result.fullPage),
      truncated: Boolean(result.truncated),
      capturedAt: result.capturedAt,
    };
  }
  if (result.kind === "observation_text") {
    return {
      kind: result.kind,
      mode: result.mode,
      origin: redactBrowserOrigin(result.origin),
      chars: result.chars,
      truncated: result.truncated,
      capturedAt: result.capturedAt,
      ...(result.actionStatus ? { actionStatus: result.actionStatus } : {}),
      ...(typeof result.verified === "boolean" ? { verified: result.verified } : {}),
      ...(result.reason ? { reason: redactText(result.reason).slice(0, TEXT_CAP) } : {}),
    };
  }
  return { kind: result.kind, message: redactText(result.message).slice(0, TEXT_CAP) };
}

export function redactBrowserResult(value: unknown): NewtonBrowserResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  // Pull the image out before generic JSON redaction so a multi-MB base64 string
  // is neither scanned nor mangled by the secret/PII passes.
  const rawDataUrl = typeof raw.dataUrl === "string" ? raw.dataUrl : "";
  const input = redactJson(rawDataUrl ? { ...raw, dataUrl: "" } : raw) as Record<string, unknown>;
  if (input.kind === "screenshot") {
    const device = ["mobile", "desktop", "viewport"].includes(String(input.device)) ? (input.device as "mobile" | "desktop" | "viewport") : undefined;
    // Inline bytes are kept only when the caller asked (raw.inline) — otherwise the
    // image is dropped from persistence and the caller fetches the artifact.
    const inlineRequested = raw.inline === true;
    const inlineOk = inlineRequested && INLINE_IMAGE_DATA_URL.test(rawDataUrl) && rawDataUrl.length <= MAX_INLINE_IMAGE_CHARS;
    const overCap = inlineRequested && Boolean(rawDataUrl) && !inlineOk;
    return {
      kind: "screenshot",
      mode: "cdp",
      origin: redactBrowserOrigin(input.origin),
      title: redactText(String(input.title ?? "")).slice(0, TEXT_CAP),
      ...(typeof input.artifactId === "string" ? { artifactId: input.artifactId.slice(0, TEXT_CAP) } : {}),
      ...(typeof input.width === "number" ? { width: Math.max(0, Math.trunc(input.width)) } : {}),
      ...(typeof input.height === "number" ? { height: Math.max(0, Math.trunc(input.height)) } : {}),
      ...(device ? { device } : {}),
      ...(typeof input.fullPage === "boolean" ? { fullPage: input.fullPage } : {}),
      ...(overCap || input.truncated === true ? { truncated: true } : {}),
      ...(inlineOk ? { dataUrl: rawDataUrl } : {}),
      capturedAt: isoOrNow(input.capturedAt),
    };
  }
  if (input.kind === "observation_delta") {
    const added = Array.isArray(input.added) ? input.added.flatMap((node, index) => normalizeNode(node, index)).slice(0, NODE_CAP) : [];
    const removed = Array.isArray(input.removed)
      ? input.removed.flatMap((ref) => (typeof ref === "string" && ref.trim() ? [redactText(ref).slice(0, TEXT_CAP)] : [])).slice(0, NODE_CAP)
      : [];
    const updated = Array.isArray(input.updated) ? input.updated.flatMap((node) => normalizeUpdated(node)).slice(0, NODE_CAP) : [];
    return {
      kind: "observation_delta",
      mode: "cdp",
      origin: redactBrowserOrigin(input.origin),
      title: redactText(String(input.title ?? "")).slice(0, TEXT_CAP),
      added,
      removed,
      updated,
      nodeCount: typeof input.nodeCount === "number" ? Math.max(0, Math.trunc(input.nodeCount)) : added.length,
      capturedAt: isoOrNow(input.capturedAt),
      ...(isBrowserActionStatus(input.actionStatus) ? { actionStatus: input.actionStatus } : {}),
      ...(typeof input.verified === "boolean" ? { verified: input.verified } : {}),
      ...(typeof input.reason === "string" ? { reason: redactText(input.reason).slice(0, TEXT_CAP) } : {}),
      ...(input.changed && typeof input.changed === "object" && !Array.isArray(input.changed) ? { changed: redactBrowserChanged(input.changed as Record<string, unknown>) } : {}),
      ...redactPendingDialog(input.pendingDialog),
    };
  }
  if (input.kind === "observation_text") {
    const bounded = redactObservationText(String(input.text ?? "")).slice(0, TEXT_OBSERVE_CAP);
    return {
      kind: "observation_text",
      mode: "text",
      origin: redactBrowserOrigin(input.origin),
      title: redactText(String(input.title ?? "")).slice(0, TEXT_CAP),
      text: bounded,
      chars: bounded.length,
      truncated: Boolean(input.truncated) || String(input.text ?? "").length > TEXT_OBSERVE_CAP,
      capturedAt: isoOrNow(input.capturedAt),
      ...(isBrowserActionStatus(input.actionStatus) ? { actionStatus: input.actionStatus } : {}),
      ...(typeof input.verified === "boolean" ? { verified: input.verified } : {}),
      ...(typeof input.reason === "string" ? { reason: redactText(input.reason).slice(0, TEXT_CAP) } : {}),
    };
  }
  if (input.kind === "observation") {
    const nodes = Array.isArray(input.nodes)
      ? input.nodes.flatMap((node, index) => normalizeNode(node, index)).slice(0, NODE_CAP)
      : [];
    return {
      kind: "observation",
      mode: input.mode === "cdp" ? "cdp" : "passive",
      origin: redactBrowserOrigin(input.origin),
      title: redactText(String(input.title ?? "")).slice(0, TEXT_CAP),
      nodes,
      nodeCount: typeof input.nodeCount === "number" ? Math.max(0, Math.trunc(input.nodeCount)) : nodes.length,
      truncated: Boolean(input.truncated),
      capturedAt: isoOrNow(input.capturedAt),
      ...(isBrowserActionStatus(input.actionStatus) ? { actionStatus: input.actionStatus } : {}),
      ...(typeof input.verified === "boolean" ? { verified: input.verified } : {}),
      ...(typeof input.reason === "string" ? { reason: redactText(input.reason).slice(0, TEXT_CAP) } : {}),
      ...(input.changed && typeof input.changed === "object" && !Array.isArray(input.changed) ? { changed: redactBrowserChanged(input.changed as Record<string, unknown>) } : {}),
      ...redactPendingDialog(input.pendingDialog),
    };
  }
  return {
    kind: "ack",
    message: redactText(String(input.message ?? "ok")).slice(0, TEXT_CAP),
  };
}

export function redactBrowserOrigin(value: unknown): string {
  if (typeof value !== "string") return "";
  try {
    const url = new URL(value);
    return url.origin.toLowerCase();
  } catch {
    return redactText(value).split(/[/?#]/)[0]?.toLowerCase().slice(0, URL_CAP) ?? "";
  }
}

function redactBrowserUrl(value: string): string {
  try {
    const url = new URL(value);
    url.search = "";
    url.hash = "";
    return redactText(url.toString()).slice(0, URL_CAP);
  } catch {
    return redactText(value).slice(0, URL_CAP);
  }
}

function normalizeNode(value: unknown, index: number) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const input = value as Record<string, unknown>;
  return [{
    ref: redactText(String(input.ref ?? `node:${index}`)).slice(0, TEXT_CAP),
    role: redactText(String(input.role ?? "generic")).slice(0, 80),
    ...(typeof input.name === "string" ? { name: redactText(input.name).slice(0, TEXT_CAP) } : {}),
    ...(typeof input.value === "string" ? { value: redactSensitiveValue(String(input.name ?? ""), input.value) } : {}),
    ...(typeof input.disabled === "boolean" ? { disabled: input.disabled } : {}),
    ...(normalizeBbox(input.bbox) ? { bbox: normalizeBbox(input.bbox)! } : {}),
    ...(redactBrowserTarget(input.target) ? { target: redactBrowserTarget(input.target)! } : {}),
  }];
}

function normalizeUpdated(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const input = value as Record<string, unknown>;
  if (typeof input.ref !== "string" || !input.ref.trim()) return [];
  return [{
    ref: redactText(input.ref).slice(0, TEXT_CAP),
    ...(typeof input.name === "string" ? { name: redactText(input.name).slice(0, TEXT_CAP) } : {}),
    ...(typeof input.value === "string" ? { value: redactSensitiveValue(String(input.name ?? ""), input.value) } : {}),
  }];
}

function normalizeBbox(value: unknown): { x: number; y: number; width: number; height: number } | null {
  if (Array.isArray(value) && value.length >= 4) {
    const [x, y, width, height] = value.map(finite);
    if (x === null || y === null || width === null || height === null) return null;
    return { x, y, width, height };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const x = finite(input.x);
  const y = finite(input.y);
  const width = finite(input.width);
  const height = finite(input.height);
  if (x === null || y === null || width === null || height === null) return null;
  return { x, y, width, height };
}

function redactBrowserTarget(value: unknown): BrowserTarget | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  if (typeof input.ref === "string" && input.ref.trim()) return { ref: redactText(input.ref).slice(0, TEXT_CAP) };
  if (typeof input.role === "string" && input.role.trim()) {
    return {
      role: redactText(input.role).slice(0, 80),
      ...(typeof input.name === "string" ? { name: redactText(input.name).slice(0, TEXT_CAP) } : {}),
      ...(typeof input.exact === "boolean" ? { exact: input.exact } : {}),
    };
  }
  if (typeof input.text === "string" && input.text.trim()) return { text: redactText(input.text).slice(0, TEXT_CAP), ...(typeof input.exact === "boolean" ? { exact: input.exact } : {}) };
  if (typeof input.label === "string" && input.label.trim()) return { label: redactText(input.label).slice(0, TEXT_CAP), ...(typeof input.exact === "boolean" ? { exact: input.exact } : {}) };
  if (typeof input.placeholder === "string" && input.placeholder.trim()) return { placeholder: redactText(input.placeholder).slice(0, TEXT_CAP), ...(typeof input.exact === "boolean" ? { exact: input.exact } : {}) };
  if (typeof input.testId === "string" && input.testId.trim()) return { testId: redactText(input.testId).slice(0, TEXT_CAP) };
  if (typeof input.selector === "string" && input.selector.trim()) return { selector: redactText(input.selector).slice(0, TEXT_CAP) };
  const coordinates = input.coordinates as Record<string, unknown> | undefined;
  const x = finite(coordinates?.x);
  const y = finite(coordinates?.y);
  if (x !== null && y !== null) return { coordinates: { x, y } };
  return undefined;
}

function redactBrowserWaitFor(value: unknown): BrowserWaitFor | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const output: BrowserWaitFor = {};
  if (typeof input.url === "string" && input.url.trim()) output.url = redactBrowserUrl(input.url);
  if (typeof input.title === "string" && input.title.trim()) output.title = redactText(input.title).slice(0, TEXT_CAP);
  if (typeof input.text === "string" && input.text.trim()) output.text = redactText(input.text).slice(0, TEXT_CAP);
  if (typeof input.selector === "string" && input.selector.trim()) output.selector = redactText(input.selector).slice(0, TEXT_CAP);
  if (typeof input.role === "string" && input.role.trim()) output.role = redactText(input.role).slice(0, TEXT_CAP);
  if (typeof input.name === "string" && input.name.trim()) output.name = redactText(input.name).slice(0, TEXT_CAP);
  if (typeof input.ref === "string" && input.ref.trim()) output.ref = redactText(input.ref).slice(0, TEXT_CAP);
  if (typeof input.value === "string" && input.value.trim()) output.value = redactText(input.value).slice(0, TEXT_CAP);
  if (["attached", "detached", "visible", "hidden", "checked", "unchecked", "value"].includes(String(input.state))) {
    output.state = input.state as BrowserWaitFor["state"];
  }
  if (typeof input.timeoutMs === "number") output.timeoutMs = Math.max(100, Math.min(Math.trunc(input.timeoutMs), 120_000));
  return Object.keys(output).length > 0 ? output : undefined;
}

function redactBrowserChanged(value: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value).slice(0, 12)) {
    const safeKey = redactText(key).slice(0, 80);
    if (!safeKey) continue;
    if (typeof raw === "boolean" || typeof raw === "number") output[safeKey] = raw;
    else if (typeof raw === "string") {
      // The post-fill `value`/`text` deltas echo what is now in the field —
      // mask sensitive values the same way observation node values are (S18).
      output[safeKey] = safeKey === "value" || safeKey === "text"
        ? redactSensitiveValue("", raw)
        : redactText(raw).slice(0, TEXT_CAP);
    }
  }
  return output;
}

function isBrowserActionStatus(value: unknown): value is BrowserActionResultStatus {
  return [
    "verified",
    "dispatched_unverified",
    "needs_approval",
    "blocked",
    "not_found",
    "ambiguous",
    "stale_target",
    "timed_out",
    "failed",
  ].includes(String(value));
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : null;
}

function isoOrNow(value: unknown): string {
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return new Date().toISOString();
}
