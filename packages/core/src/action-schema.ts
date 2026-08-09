import { type BrowserAction, type BrowserActionKind, type BrowserTarget, type BrowserWaitFor } from "./protocol.ts";

const TEXT_CAP = 240;
const ROLE_CAP = 80;
const URL_CAP = 500;
const IDEMPOTENCY_KEY_MIN_LENGTH = 8;
const IDEMPOTENCY_KEY_MAX_LENGTH = 128;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]+$/u;

type BrowserActionFieldSpec =
  | { kind: "target" }
  | { kind: "waitFor" }
  | { kind: "text"; cap: number }
  | { kind: "secret" }
  | { kind: "url" }
  | { kind: "bool" }
  | { kind: "int"; min: number; max: number }
  | { kind: "num" }
  | { kind: "stringArray"; cap: number; itemCap: number }
  | { kind: "filePaths"; cap: number; itemCap: number }
  | { kind: "sensitiveZones"; cap: number; itemCap: number }
  | { kind: "enum"; values: readonly string[] }
  | { kind: "viewport" }
  | { kind: "formFields"; cap: number }
  | { kind: "clip" };

export const BROWSER_ACTION_FIELD_SPECS = {
  target: { kind: "target" },
  waitFor: { kind: "waitFor" },
  ref: { kind: "text", cap: TEXT_CAP },
  role: { kind: "text", cap: ROLE_CAP },
  name: { kind: "text", cap: TEXT_CAP },
  label: { kind: "text", cap: TEXT_CAP },
  placeholder: { kind: "text", cap: TEXT_CAP },
  testId: { kind: "text", cap: TEXT_CAP },
  exact: { kind: "bool" },
  value: { kind: "secret" },
  url: { kind: "url" },
  text: { kind: "text", cap: TEXT_CAP },
  selector: { kind: "text", cap: TEXT_CAP },
  query: { kind: "text", cap: TEXT_CAP },
  maxNodes: { kind: "int", min: 1, max: 250 },
  timeoutMs: { kind: "int", min: 100, max: 120_000 },
  x: { kind: "num" },
  y: { kind: "num" },
  keys: { kind: "stringArray", cap: 8, itemCap: 80 },
  files: { kind: "filePaths", cap: 8, itemCap: 32_767 },
  sensitiveZones: { kind: "sensitiveZones", cap: 32, itemCap: TEXT_CAP },
  checked: { kind: "bool" },
  intent: { kind: "text", cap: TEXT_CAP },
  fullPage: { kind: "bool" },
  device: { kind: "enum", values: ["mobile", "desktop"] },
  waitMs: { kind: "int", min: 0, max: 10_000 },
  inline: { kind: "bool" },
  clip: { kind: "clip" },
  mode: { kind: "enum", values: ["full", "diff", "text"] },
  maxChars: { kind: "int", min: 200, max: 200_000 },
  promptText: { kind: "text", cap: TEXT_CAP },
  viewport: { kind: "viewport" },
  fields: { kind: "formFields", cap: 32 },
  level: { kind: "enum", values: ["log", "info", "warn", "error", "debug"] },
  pattern: { kind: "text", cap: TEXT_CAP },
  limit: { kind: "int", min: 1, max: 500 },
  clear: { kind: "bool" },
  urlPattern: { kind: "text", cap: URL_CAP },
  requestId: { kind: "text", cap: TEXT_CAP },
  format: { kind: "enum", values: ["png", "jpeg"] },
  quality: { kind: "int", min: 1, max: 100 },
} as const satisfies Record<string, BrowserActionFieldSpec>;

export type BrowserActionField = keyof typeof BROWSER_ACTION_FIELD_SPECS;

export const BROWSER_ACTION_FIELDS = Object.keys(BROWSER_ACTION_FIELD_SPECS) as BrowserActionField[];

export function parseBrowserAction(raw: unknown): BrowserAction {
  const input = objectRecord(raw);
  const action: BrowserAction = { kind: parseActionKind(input?.kind) };
  if (!input) return action;
  const output = action as Record<string, unknown>;
  for (const key of BROWSER_ACTION_FIELDS) {
    const value = parseBrowserActionField(input[key], BROWSER_ACTION_FIELD_SPECS[key]);
    if (value !== undefined) output[key] = value;
  }
  return action;
}

export function normalizeIdempotencyKey(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (
    trimmed.length < IDEMPOTENCY_KEY_MIN_LENGTH
    || trimmed.length > IDEMPOTENCY_KEY_MAX_LENGTH
  ) {
    return undefined;
  }
  if (!IDEMPOTENCY_KEY_PATTERN.test(trimmed)) return undefined;
  return trimmed;
}

export function validateIdempotencyKey(value: unknown): string {
  const key = normalizeIdempotencyKey(value);
  if (key === undefined) {
    throw new TypeError("idempotencyKey must be 8-128 URL-safe characters");
  }
  return key;
}

export const IDEMPOTENCY_KEY_MINIMUM_LENGTH = IDEMPOTENCY_KEY_MIN_LENGTH;
export const IDEMPOTENCY_KEY_MAXIMUM_LENGTH = IDEMPOTENCY_KEY_MAX_LENGTH;

function parseBrowserActionField(raw: unknown, spec: BrowserActionFieldSpec): unknown {
  if (spec.kind === "target") return parseBrowserTarget(raw);
  if (spec.kind === "waitFor") return parseBrowserWaitFor(raw);
  if (spec.kind === "text") return boundedString(raw, spec.cap);
  if (spec.kind === "secret") return optionalString(raw);
  if (spec.kind === "url") return boundedString(raw, URL_CAP);
  if (spec.kind === "bool") return typeof raw === "boolean" ? raw : undefined;
  if (spec.kind === "int") return boundedInt(raw, spec.min, spec.max);
  if (spec.kind === "num") return finiteNumber(raw);
  if (spec.kind === "stringArray") return stringArray(raw, spec.cap, spec.itemCap);
  if (spec.kind === "filePaths") return filePathArray(raw, spec.cap, spec.itemCap);
  if (spec.kind === "sensitiveZones") return sensitiveZoneArray(raw, spec.cap, spec.itemCap);
  if (spec.kind === "enum") return typeof raw === "string" && spec.values.includes(raw) ? raw : undefined;
  if (spec.kind === "viewport") return parseViewport(raw);
  if (spec.kind === "formFields") return parseFormFields(raw, spec.cap);
  return parseClip(raw);
}

// Ordered fill_form fields (WS9.8). Each entry keeps a resolvable target plus its
// value; entries with neither a target nor targeting hint are dropped so a malformed
// field cannot silently fill the wrong control.
function parseFormFields(raw: unknown, cap: number): unknown {
  if (!Array.isArray(raw)) return undefined;
  const fields = raw.slice(0, cap).flatMap((entry) => {
    const input = objectRecord(entry);
    if (!input) return [];
    const target = parseBrowserTarget(input);
    const field: Record<string, unknown> = {};
    if (target) field.target = target;
    for (const key of ["ref", "role", "name", "label", "placeholder", "testId", "selector"] as const) {
      const value = boundedString(input[key], TEXT_CAP);
      if (value) field[key] = value;
    }
    const value = optionalString(input.value);
    if (value !== undefined) field.value = value;
    const hasTarget = target || field.ref || field.role || field.label || field.placeholder || field.testId || field.selector;
    return hasTarget ? [field] : [];
  });
  return fields.length > 0 ? fields : undefined;
}

// Owned-tab viewport for `resize` (WS9.6). Bounded to sane device sizes so a caller
// cannot request a multi-thousand-pixel surface that wedges the serial capture pump.
function parseViewport(raw: unknown): { width: number; height: number } | undefined {
  const input = objectRecord(raw);
  if (!input) return undefined;
  const width = boundedInt(input.width, 200, 3840);
  const height = boundedInt(input.height, 200, 2160);
  if (width === undefined || height === undefined) return undefined;
  return { width, height };
}

export function parseBrowserTarget(raw: unknown): BrowserTarget | undefined {
  const input = objectRecord(raw);
  if (!input) return undefined;
  const ref = boundedString(input.ref, TEXT_CAP);
  if (ref) return { ref };
  const role = boundedString(input.role, ROLE_CAP);
  if (role) {
    return {
      role,
      ...(boundedString(input.name, TEXT_CAP) ? { name: boundedString(input.name, TEXT_CAP) } : {}),
      ...(typeof input.exact === "boolean" ? { exact: input.exact } : {}),
    };
  }
  const text = boundedString(input.text, TEXT_CAP);
  if (text) return { text, ...(typeof input.exact === "boolean" ? { exact: input.exact } : {}) };
  const label = boundedString(input.label, TEXT_CAP);
  if (label) return { label, ...(typeof input.exact === "boolean" ? { exact: input.exact } : {}) };
  const placeholder = boundedString(input.placeholder, TEXT_CAP);
  if (placeholder) return { placeholder, ...(typeof input.exact === "boolean" ? { exact: input.exact } : {}) };
  const testId = boundedString(input.testId, TEXT_CAP);
  if (testId) return { testId };
  const selector = boundedString(input.selector, TEXT_CAP);
  if (selector) return { selector };
  const coordinates = objectRecord(input.coordinates);
  const x = finiteNumber(coordinates?.x);
  const y = finiteNumber(coordinates?.y);
  if (x !== undefined && y !== undefined) return { coordinates: { x, y } };
  return undefined;
}

export function parseBrowserWaitFor(raw: unknown): BrowserWaitFor | undefined {
  const input = objectRecord(raw);
  if (!input) return undefined;
  const output: BrowserWaitFor = {};
  const url = boundedString(input.url, URL_CAP);
  if (url) output.url = url;
  const title = boundedString(input.title, TEXT_CAP);
  if (title) output.title = title;
  const text = boundedString(input.text, TEXT_CAP);
  if (text) output.text = text;
  const selector = boundedString(input.selector, TEXT_CAP);
  if (selector) output.selector = selector;
  const role = boundedString(input.role, ROLE_CAP);
  if (role) output.role = role;
  const name = boundedString(input.name, TEXT_CAP);
  if (name) output.name = name;
  const ref = boundedString(input.ref, TEXT_CAP);
  if (ref) output.ref = ref;
  const value = boundedString(input.value, TEXT_CAP);
  if (value) output.value = value;
  if (isWaitForState(input.state)) output.state = input.state;
  const timeoutMs = boundedInt(input.timeoutMs, 100, 120_000);
  if (timeoutMs !== undefined) output.timeoutMs = timeoutMs;
  return Object.keys(output).length > 0 ? output : undefined;
}

function parseActionKind(raw: unknown): BrowserActionKind {
  const kind = optionalString(raw);
  return (kind ?? "observe") as BrowserActionKind;
}

function parseClip(raw: unknown): BrowserAction["clip"] | undefined {
  const input = objectRecord(raw);
  if (!input) return undefined;
  const x = finiteNumber(input.x);
  const y = finiteNumber(input.y);
  const width = finiteNumber(input.width);
  const height = finiteNumber(input.height);
  if (x === undefined || y === undefined || width === undefined || height === undefined) return undefined;
  return { x, y, width, height };
}

function stringArray(raw: unknown, cap: number, itemCap: number): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const values = raw.flatMap((value) => {
    const parsed = boundedString(value, itemCap);
    return parsed ? [parsed] : [];
  }).slice(0, cap);
  return values.length > 0 ? values : undefined;
}

function filePathArray(raw: unknown, cap: number, itemCap: number): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.slice(0, cap).flatMap((value) => {
    if (typeof value !== "string" || !value.trim()) return [];
    return [value.slice(0, itemCap)];
  });
}

function sensitiveZoneArray(raw: unknown, cap: number, itemCap: number): BrowserAction["sensitiveZones"] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const zones = raw.slice(0, cap).flatMap((value) => {
    const input = objectRecord(value);
    if (!input) return [];
    const selector = boundedString(input.selector, itemCap);
    const name = boundedString(input.name, itemCap);
    const label = boundedString(input.label, itemCap);
    return selector || name || label ? [{ ...(selector ? { selector } : {}), ...(name ? { name } : {}), ...(label ? { label } : {}) }] : [];
  });
  return zones.length > 0 ? zones : undefined;
}

function boundedInt(raw: unknown, min: number, max: number): number | undefined {
  const parsed = typeof raw === "number" ? raw : Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.max(min, Math.min(Math.trunc(parsed), max));
}

function finiteNumber(raw: unknown): number | undefined {
  const parsed = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(parsed) ? Math.round(parsed) : undefined;
}

function boundedString(raw: unknown, cap: number): string | undefined {
  const parsed = optionalString(raw);
  return parsed ? parsed.slice(0, cap) : undefined;
}

function optionalString(raw: unknown): string | undefined {
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

function objectRecord(raw: unknown): Record<string, unknown> | undefined {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : undefined;
}

function isWaitForState(raw: unknown): raw is NonNullable<BrowserWaitFor["state"]> {
  return raw === "attached" ||
    raw === "detached" ||
    raw === "visible" ||
    raw === "hidden" ||
    raw === "checked" ||
    raw === "unchecked" ||
    raw === "value";
}
