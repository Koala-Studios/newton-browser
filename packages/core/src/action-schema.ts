import { type BrowserAction, type BrowserActionKind, type BrowserTarget, type BrowserWaitFor } from "./protocol.ts";
import { ACTION_REQUIRED_FIELDS, ACTION_VARIANT_FIELDS, BROWSER_COMPOSITE_REF_PATTERN, TARGET_REQUIRED_ACTION_KINDS } from "./action-json-schema.ts";

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
  roles: { kind: "stringArray", cap: 12, itemCap: ROLE_CAP },
  includeInteractive: { kind: "bool" },
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

export class InvalidBrowserActionError extends TypeError {
  readonly code = "invalid_arguments";
  constructor(message: string) {
    super(message);
    this.name = "InvalidBrowserActionError";
  }
}

export function parseBrowserAction(raw: unknown): BrowserAction {
  const input = objectRecord(raw);
  if (!input) invalid("action must be an object");
  const kind = parseActionKind(input.kind);
  const allowed = new Set(["kind", ...ACTION_VARIANT_FIELDS[kind]]);
  const unknown = Object.keys(input).filter((key) => !allowed.has(key));
  if (unknown.length > 0) invalid(`unsupported field(s) for ${kind}: ${unknown.join(",")}`);
  for (const required of ACTION_REQUIRED_FIELDS[kind] ?? []) {
    if (!(required in input)) invalid(`${kind}.${required} is required`);
  }
  const action: BrowserAction = { kind };
  const output = action as Record<string, unknown>;
  for (const key of ACTION_VARIANT_FIELDS[kind] as BrowserActionField[]) {
    if (key in input) validateRawField(input[key], BROWSER_ACTION_FIELD_SPECS[key], `${kind}.${key}`);
    const value = parseBrowserActionField(input[key], BROWSER_ACTION_FIELD_SPECS[key]);
    if (key in input && value === undefined) invalid(`${kind}.${key} is invalid`);
    if (value !== undefined) output[key] = value;
  }
  validateCompositeRefs(input, kind);
  if (TARGET_REQUIRED_ACTION_KINDS.has(kind)) {
    validateActionTargetShape(input, kind);
    if (!hasActionTarget(action)) invalid(`${kind} requires a target`);
  }
  return action;
}

function validateRawField(raw: unknown, spec: BrowserActionFieldSpec, label: string): void {
  if (spec.kind === "target") {
    validateObjectKeys(raw, ["ref", "role", "name", "text", "label", "placeholder", "testId", "selector", "exact", "coordinates"], label);
    const input = objectRecord(raw)!;
    for (const field of ["ref", "role", "name", "text", "label", "placeholder", "testId", "selector"]) if (input[field] !== undefined && (typeof input[field] !== "string" || !String(input[field]).trim())) invalid(`${label}.${field} is invalid`);
    if (input.exact !== undefined && typeof input.exact !== "boolean") invalid(`${label}.exact must be boolean`);
    if (input.coordinates !== undefined) {
      validateObjectKeys(input.coordinates, ["x", "y"], `${label}.coordinates`);
      const coordinates = objectRecord(input.coordinates)!;
      if (![coordinates.x, coordinates.y].every((value) => typeof value === "number" && Number.isFinite(value))) invalid(`${label}.coordinates is invalid`);
    }
    validateTargetObjectShape(input, label);
    return;
  }
  if (spec.kind === "waitFor") {
    validateObjectKeys(raw, ["url", "title", "text", "selector", "role", "name", "ref", "value", "state", "timeoutMs"], label);
    const input = objectRecord(raw)!;
    for (const field of ["url", "title", "text", "selector", "role", "name", "ref", "value"]) if (input[field] !== undefined && (typeof input[field] !== "string" || !String(input[field]).trim())) invalid(`${label}.${field} is invalid`);
    if (input.state !== undefined && !isWaitForState(input.state)) invalid(`${label}.state is invalid`);
    if (input.timeoutMs !== undefined && (!Number.isInteger(input.timeoutMs) || Number(input.timeoutMs) < 100 || Number(input.timeoutMs) > 120_000)) invalid(`${label}.timeoutMs is outside bounds`);
    return;
  }
  if (spec.kind === "text" || spec.kind === "secret" || spec.kind === "url") {
    if (typeof raw !== "string" || !raw.trim() || raw.length > (spec.kind === "url" ? URL_CAP : spec.kind === "text" ? spec.cap : Number.MAX_SAFE_INTEGER)) invalid(`${label} must be a bounded string`);
    return;
  }
  if (spec.kind === "bool") { if (typeof raw !== "boolean") invalid(`${label} must be boolean`); return; }
  if (spec.kind === "int") { if (!Number.isInteger(raw) || Number(raw) < spec.min || Number(raw) > spec.max) invalid(`${label} is outside bounds`); return; }
  if (spec.kind === "num") { if (typeof raw !== "number" || !Number.isFinite(raw)) invalid(`${label} must be finite`); return; }
  if (spec.kind === "enum") { if (typeof raw !== "string" || !spec.values.includes(raw)) invalid(`${label} is not an allowed value`); return; }
  if (spec.kind === "stringArray" || spec.kind === "filePaths") {
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > spec.cap || raw.some((value) => typeof value !== "string" || !value.trim() || value.length > spec.itemCap)) invalid(`${label} must be a bounded string array`);
    return;
  }
  if (spec.kind === "sensitiveZones") {
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > spec.cap) invalid(`${label} is invalid`);
    for (const [index, zone] of raw.entries()) {
      validateObjectKeys(zone, ["ref", "selector", "name", "label"], `${label}[${index}]`);
      const record = objectRecord(zone)!;
      const values = [record.ref, record.selector, record.name, record.label];
      const configured = values.filter((value) => value !== undefined);
      if (configured.length !== 1
        || configured.some((value) => typeof value !== "string" || !value.trim() || value.length > spec.itemCap)) {
        invalid(`${label}[${index}] must contain exactly one bounded ref, selector, name, or label`);
      }
    }
    return;
  }
  if (spec.kind === "viewport") {
    validateObjectKeys(raw, ["width", "height"], label);
    const input = objectRecord(raw)!;
    if (!Number.isInteger(input.width) || Number(input.width) < 200 || Number(input.width) > 3840 || !Number.isInteger(input.height) || Number(input.height) < 200 || Number(input.height) > 2160) invalid(`${label} is outside bounds`);
    return;
  }
  if (spec.kind === "clip") {
    validateObjectKeys(raw, ["x", "y", "width", "height"], label);
    const input = objectRecord(raw)!;
    if (![input.x, input.y, input.width, input.height].every((value) => typeof value === "number" && Number.isFinite(value)) || Number(input.width) <= 0 || Number(input.height) <= 0) invalid(`${label} is invalid`);
    return;
  }
  if (spec.kind === "formFields") {
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > spec.cap) invalid(`${label} must be a non-empty bounded array`);
    for (const [index, field] of raw.entries()) {
      validateObjectKeys(field, ["target", "ref", "role", "name", "label", "placeholder", "testId", "selector", "value"], `${label}[${index}]`);
      const record = objectRecord(field)!;
      if (typeof record.value !== "string" || !record.value.trim()) invalid(`${label}[${index}].value is required`);
      if (record.target !== undefined) validateRawField(record.target, { kind: "target" }, `${label}[${index}].target`);
      for (const key of ["ref", "role", "name", "label", "placeholder", "testId", "selector"]) {
        if (record[key] !== undefined && (typeof record[key] !== "string" || !String(record[key]).trim())) invalid(`${label}[${index}].${key} is invalid`);
      }
      validateActionTargetShape(record, `${label}[${index}]`);
      const candidate = { kind: "fill", ...record } as BrowserAction;
      if (!hasActionTarget(candidate)) invalid(`${label}[${index}] requires a target`);
    }
  }
}

function validateObjectKeys(raw: unknown, allowed: readonly string[], label: string): void {
  const input = objectRecord(raw);
  if (!input) invalid(`${label} must be an object`);
  const unknown = Object.keys(input).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) invalid(`${label} has unsupported field(s): ${unknown.join(",")}`);
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
    const target = parseBrowserTarget(input.target);
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
  if (!kind || !(kind in ACTION_VARIANT_FIELDS)) invalid("action.kind is unknown or missing");
  return kind as BrowserActionKind;
}

function validateCompositeRefs(input: Record<string, unknown>, kind: BrowserActionKind): void {
  const refs = [input.ref, objectRecord(input.target)?.ref, objectRecord(input.waitFor)?.ref];
  for (const value of refs) {
    if (value !== undefined && (typeof value !== "string" || !BROWSER_COMPOSITE_REF_PATTERN.test(value))) {
      invalid(`${kind}.ref must be a fresh composite Newton reference`);
    }
  }
  if (Array.isArray(input.fields)) {
    for (const field of input.fields) {
      const record = objectRecord(field);
      const ref = record?.ref ?? objectRecord(record?.target)?.ref;
      if (ref !== undefined && (typeof ref !== "string" || !BROWSER_COMPOSITE_REF_PATTERN.test(ref))) invalid(`${kind}.fields ref is invalid`);
    }
  }
}

function hasActionTarget(action: BrowserAction): boolean {
  return Boolean(action.target || action.ref || action.role || action.name || action.label || action.placeholder || action.testId || action.selector || action.text || (Number.isFinite(action.x) && Number.isFinite(action.y)));
}

function validateTargetObjectShape(input: Record<string, unknown>, label: string): void {
  const strategies = ["ref", "role", "text", "label", "placeholder", "testId", "selector", "coordinates"]
    .filter((key) => input[key] !== undefined);
  if (strategies.length === 0) invalid(`${label} requires one target strategy`);
  if (strategies.length > 1) invalid(`${label} has ambiguous target strategies: ${strategies.join(",")}`);
  if (input.name !== undefined && input.role === undefined) invalid(`${label}.name requires role`);
  if (input.exact !== undefined && !["role", "text", "label", "placeholder"].some((key) => input[key] !== undefined)) invalid(`${label}.exact is not valid for this strategy`);
}

function validateActionTargetShape(input: Record<string, unknown>, label: string): void {
  const hasNested = input.target !== undefined;
  const coordinatePresent = input.x !== undefined || input.y !== undefined;
  if (coordinatePresent && !(typeof input.x === "number" && Number.isFinite(input.x) && typeof input.y === "number" && Number.isFinite(input.y))) invalid(`${label} coordinates require x and y`);
  const shorthands = [
    input.ref !== undefined,
    input.role !== undefined || input.name !== undefined,
    input.label !== undefined,
    input.placeholder !== undefined,
    input.testId !== undefined,
    input.selector !== undefined,
    input.text !== undefined,
    coordinatePresent,
  ].filter(Boolean).length;
  if ((hasNested ? 1 : 0) + shorthands > 1) invalid(`${label} has ambiguous target strategies`);
}

function invalid(message: string): never {
  throw new InvalidBrowserActionError(message);
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
    const ref = boundedString(input.ref, itemCap);
    const selector = boundedString(input.selector, itemCap);
    const name = boundedString(input.name, itemCap);
    const label = boundedString(input.label, itemCap);
    const configured = [ref, selector, name, label].filter((value) => value !== undefined);
    return configured.length === 1 ? [{ ...(ref ? { ref } : {}), ...(selector ? { selector } : {}), ...(name ? { name } : {}), ...(label ? { label } : {}) }] : [];
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
