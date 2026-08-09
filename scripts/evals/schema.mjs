import fs from "node:fs";
import path from "node:path";
import {
  BROWSER_ACTION_FIELDS,
  BROWSER_ACTION_FIELD_SPECS,
  parseBrowserAction,
  parseBrowserTarget,
  parseBrowserWaitFor,
} from "../../packages/core/src/action-schema.ts";
import { BROWSER_ACTION_KINDS, BROWSER_ACTION_RESULT_STATUSES } from "../../packages/core/src/protocol.ts";
const EVAL_SCHEMA_VERSION = 1;
const TASK_ID_RE = /^[a-zA-Z0-9._-]{1,120}$/;
const FIXTURE_PATH_RE = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u;
const TARGET_REQUIRED_ACTION_KINDS = new Set([
  "click",
  "fill",
  "type",
  "select",
  "clear",
  "set_files",
  "hover",
  "move",
]);
export const TASK_TOOLS = Object.freeze([
  "browser.session.start",
  "browser.session.stop",
  "browser.observe",
  "browser.act",
  "browser.wait_for",
  "browser.screenshot",
]);
export const TASK_EXPECT_STATUSES = Object.freeze([
  ...BROWSER_ACTION_RESULT_STATUSES,
  "completed",
  "prevented",
  "dialog_blocked",
  "discarded",
  "target_gone",
  "debugger_conflict",
  "renderer_unresponsive",
  "invalid_selector",
  "not_started",
  "outcome_unknown",
  "runner_contract_invalid",
]);
export const FORBID_ACTION_METHODS = Object.freeze([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
  "TRACE",
]);
export const FORBID_EFFECT_TYPES = Object.freeze(["http", "redirect", "beacon", "socket"]);
const TASK_KEYS = new Set(["id", "description", "fixture", "grant", "steps", "forbid"]);
const STEP_KEYS = new Set(["tool", "expect", "query", "waitFor", "semanticRef", "action", "metadata"]);
const EXPECT_KEYS = new Set(["status"]);
const WAIT_FOR_KEYS = new Set(["state", "selector", "url", "title", "text", "role", "name", "ref", "value", "timeoutMs"]);
const TARGET_KEYS = new Set(["ref", "role", "name", "label", "text", "placeholder", "testId", "selector", "exact", "coordinates"]);
const TARGET_HINT_KEYS = new Set(["target", "ref", "role", "name", "label", "text", "placeholder", "testId", "selector"]);
const TARGET_COORD_KEYS = new Set(["x", "y"]);
const FORBID_KEYS = new Set(["origin", "method", "path", "type", "requestId"]);
const FORM_FIELD_KEYS = new Set(["target", "ref", "role", "name", "label", "placeholder", "testId", "selector", "value"]);
const ACTION_KEYS = Object.freeze(new Set(["kind", ...BROWSER_ACTION_FIELDS]));
const WAIT_FOR_RULES = Object.freeze({
  state: (input, label) => parseEnum(input, [
    "attached",
    "detached",
    "visible",
    "hidden",
    "checked",
    "unchecked",
    "value",
  ], `${label}.state`),
  selector: (input, label) => parseTrimmedString(input, `${label}.selector`, LIMITS.text),
  url: (input, label) => parseTrimmedString(input, `${label}.url`, LIMITS.path),
  title: (input, label) => parseTrimmedString(input, `${label}.title`, LIMITS.text),
  text: (input, label) => parseTrimmedString(input, `${label}.text`, LIMITS.text),
  role: (input, label) => parseTrimmedString(input, `${label}.role`, LIMITS.targetRole),
  name: (input, label) => parseTrimmedString(input, `${label}.name`, LIMITS.targetName),
  ref: (input, label) => parseTrimmedString(input, `${label}.ref`, LIMITS.targetRef),
  value: (input, label) => parseTrimmedString(input, `${label}.value`, LIMITS.text),
  timeoutMs: (input, label) => parseStrictInt(input, `${label}.timeoutMs`, 100, 120000),
});
const LIMITS = Object.freeze({
  id: 120,
  description: 2048,
  fixture: 320,
  steps: 256,
  grant: 128,
  forbid: 128,
  query: 1024,
  metadata: 240,
  reason: 320,
  requestId: 256,
  path: 1024,
  origin: 400,
  text: 240,
  actionSecret: 4000,
  targetRef: 240,
  targetRole: 120,
  targetName: 240,
  targetLabel: 240,
  targetText: 240,
  targetPlaceholder: 240,
  targetTestId: 120,
  targetSelector: 500,
  coordInt: 100000,
  formFields: 32,
  stringArray: 128,
  forbidRules: 128,
  reportTasks: 256,
  reportSteps: 256,
});
const ENCODED_PATH_ESCAPES = /%(2e|2f|5c)/iu;
const parsedTaskBrand = new WeakSet();
export class EvalSchemaError extends Error {
  constructor(message, field = "") {
    super(message);
    this.name = "EvalSchemaError";
    this.field = field;
  }
}
function markParsedTask(task) {
  parsedTaskBrand.add(task);
  return task;
}
export function isParsedEvalTask(value) {
  return typeof value === "object" && value !== null && parsedTaskBrand.has(value);
}
export function coerceParsedEvalTask(rawTask, label = "task") {
  return isParsedEvalTask(rawTask) ? rawTask : parseEvalTask(rawTask, label);
}
export function parseFixturePath(raw, label = "task.fixture") {
  const value = parseTrimmedString(raw, label, LIMITS.fixture);
  if (value.includes("\\") || /\p{Cc}/u.test(value) || value.includes("?") || value.includes("#")) {
    throw new EvalSchemaError(`${label} is invalid`, label);
  }
  if (value.startsWith("/")) {
    throw new EvalSchemaError(`${label} must be relative`, label);
  }
  if (/^[A-Za-z]:/.test(value) || /^\\\\/.test(value)) {
    throw new EvalSchemaError(`${label} is invalid`, label);
  }
  if (!FIXTURE_PATH_RE.test(value)) {
    throw new EvalSchemaError(`${label} must be safe relative path`, label);
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment === "." || segment === ".." || !segment)) {
    throw new EvalSchemaError(`${label} contains invalid segment`, label);
  }
  return value;
}
export function sanitizeFixturePath(raw, fallback = "fixtures") {
  try {
    return parseFixturePath(raw, "fixture");
  } catch {
    return fallback;
  }
}
export function actionRequiresTarget(kind) {
  return TARGET_REQUIRED_ACTION_KINDS.has(kind);
}
export function parseEvalPath(raw, label) {
  const value = parseTrimmedString(raw, label, LIMITS.path);
  if (value.includes(" ") || value.includes("\\") || /\p{Cc}/u.test(value)) {
    throw new EvalSchemaError(`${label} is invalid path`, label);
  }
  if (value.includes("?") || value.includes("#")) {
    throw new EvalSchemaError(`${label} must not include query or fragment`, label);
  }
  if (ENCODED_PATH_ESCAPES.test(value)) {
    throw new EvalSchemaError(`${label} contains unsupported encoded segment`, label);
  }
  const normalized = value.startsWith("/") ? value : `/${value}`;
  if (normalized.length > 1 && normalized.endsWith("/")) {
    throw new EvalSchemaError(`${label} must not include trailing slash`, label);
  }
  const segments = normalized.split("/").slice(1);
  if (segments.length === 0 || (segments.length === 1 && segments[0] === "")) return "/";
  if (segments.some((segment) => segment === "." || segment === ".." || !segment)) {
    throw new EvalSchemaError(`${label} contains unsupported segment`, label);
  }
  return normalized;
}
export function parseEvalTaskFromDirectory(directoryPath) {
  const files = fs
    .readdirSync(directoryPath, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((entry) => entry.endsWith(".json"))
    .filter((entry) => !entry.startsWith("_"))
    .sort((a, b) => a.localeCompare(b));
  return Object.freeze(files.map((entry) => loadEvalTaskFile(path.join(directoryPath, entry))));
}
export function loadEvalTaskFile(filePath) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new EvalSchemaError(`invalid JSON in ${filePath}: ${error.message}`, filePath);
  }
  return parseEvalTask(raw, filePath);
}
export function parseEvalTask(raw, label = "task") {
  const value = asObject(raw, label);
  ensureOnlyKeys(label, value, TASK_KEYS);
  return markParsedTask(freezeDeep({
    version: EVAL_SCHEMA_VERSION,
    id: parseIdentifier(value.id, `${label}.id`),
    fixture: parseFixturePath(value.fixture, `${label}.fixture`),
    grant: parseGrantArray(value.grant, `${label}.grant`),
    steps: parseSteps(value.steps, `${label}.steps`),
    forbid: parseForbidArray(value.forbid ?? [], `${label}.forbid`),
    ...(value.description !== undefined
      ? { description: parseTrimmedString(value.description, `${label}.description`, LIMITS.description) }
      : {}),
  }));
}
function parseSteps(raw, label) {
  const values = asArray(raw, label);
  if (values.length === 0) {
    throw new EvalSchemaError(`${label} must not be empty`, label);
  }
  if (values.length > LIMITS.steps) {
    throw new EvalSchemaError(`${label} exceeds maximum length ${LIMITS.steps}`, label);
  }
  return freezeDeep(values.map((entry, index) => parseTaskStep(entry, `${label}[${index}]`)));
}
function parseTaskStep(raw, label) {
  const value = asObject(raw, label);
  ensureOnlyKeys(label, value, STEP_KEYS);
  const step = {
    tool: parseEnum(value.tool, TASK_TOOLS, `${label}.tool`),
    expect: parseExpected(value.expect, `${label}.expect`),
    ...(optionalTrimmedString(value.query, `${label}.query`, LIMITS.query) !== undefined
      ? { query: parseTrimmedString(value.query, `${label}.query`, LIMITS.query) }
      : {}),
  };
  if (step.tool === "browser.wait_for") {
    step.waitFor = parseWaitFor(value.waitFor, `${label}.waitFor`, true);
  } else {
    const waitFor = parseWaitFor(value.waitFor, `${label}.waitFor`, false);
    if (waitFor !== undefined) {
      step.waitFor = waitFor;
    }
  }
  if (value.semanticRef !== undefined) {
    step.semanticRef = parseSemanticRef(value.semanticRef, `${label}.semanticRef`);
  }
  if (value.action !== undefined) {
    step.action = parseAction(value.action, `${label}.action`);
  }
  if (step.tool !== "browser.act") {
    if (step.action !== undefined) {
      throw new EvalSchemaError(`${label}.action is only valid for browser.act`, `${label}.action`);
    }
  } else if (step.action === undefined) {
    throw new EvalSchemaError(`${label}.action is required for browser.act`, `${label}.action`);
  }
  if (step.tool === "browser.act" && actionRequiresTarget(step.action.kind) && !hasTargetHint(step.action) && !hasTargetHint(step.semanticRef)) {
    throw new EvalSchemaError(`${label}.action requires a target hint`, `${label}.action`);
  }
  if (value.metadata !== undefined) {
    step.metadata = parseTrimmedString(value.metadata, `${label}.metadata`, LIMITS.metadata);
  }
  return freezeShallow(step);
}
function parseExpected(raw, label) {
  if (raw === undefined) {
    throw new EvalSchemaError(`${label} is required`, label);
  }
  const value = typeof raw === "string" ? { status: raw } : asObject(raw, label);
  ensureOnlyKeys(label, value, EXPECT_KEYS);
  return { status: parseEnum(value.status, TASK_EXPECT_STATUSES, `${label}.status`) };
}
function parseWaitFor(raw, label, required) {
  if (raw === undefined) {
    if (required) throw new EvalSchemaError(`${label} is required`, label);
    return undefined;
  }
  return parseWaitForLike(raw, label);
}
function parseSemanticRef(raw, label) {
  const value = asObject(raw, label);
  if (!Object.keys(value).length) {
    throw new EvalSchemaError(`${label} requires at least one hint`, label);
  }
  ensureOnlyKeys(label, value, TARGET_HINT_KEYS);
  return freezeShallow(parseTargetLike(value, label, {
    role: (input) => parseTrimmedString(input, `${label}.role`, LIMITS.targetRole),
    name: (input) => parseTrimmedString(input, `${label}.name`, LIMITS.targetName),
    label: (input) => parseTrimmedString(input, `${label}.label`, LIMITS.targetLabel),
    text: (input) => parseTrimmedString(input, `${label}.text`, LIMITS.targetText),
    placeholder: (input) => parseTrimmedString(input, `${label}.placeholder`, LIMITS.targetPlaceholder),
    testId: (input) => parseTrimmedString(input, `${label}.testId`, LIMITS.targetTestId),
    selector: (input) => parseTrimmedString(input, `${label}.selector`, LIMITS.targetSelector),
    ref: (input) => parseTrimmedString(input, `${label}.ref`, LIMITS.targetRef),
  }));
}
function parseAction(raw, label) {
  const value = asObject(raw, label);
  ensureOnlyKeys(label, value, ACTION_KEYS);
  const kind = parseEnum(value.kind, BROWSER_ACTION_KINDS, `${label}.kind`);
  const action = { kind };
  for (const [key, entry] of Object.entries(value)) {
    if (key === "kind") continue;
    action[key] = parseActionField(key, entry, `${label}.${key}`);
  }
  const normalized = parseBrowserAction(action);
  if (!normalized || normalized.kind !== kind) {
    throw new EvalSchemaError(`${label}.kind is invalid`, `${label}.kind`);
  }
  for (const key of Object.keys(action)) {
    if (!Object.hasOwn(normalized, key)) {
      throw new EvalSchemaError(`${label}.${key} rejected by core parser`, `${label}.${key}`);
    }
  }
  return freezeShallow(normalized);
}
function parseActionField(field, raw, label) {
  const spec = BROWSER_ACTION_FIELD_SPECS[field];
  if (!spec) throw new EvalSchemaError(`${label} is unknown`, label);
  if (raw === undefined) {
    throw new EvalSchemaError(`${label} is required`, label);
  }
  switch (spec.kind) {
    case "target":
      return parseActionTarget(raw, label);
    case "waitFor":
      return parseWaitForLike(raw, label);
    case "text":
      return parseTrimmedString(raw, label, spec.cap ?? LIMITS.text);
    case "secret":
      return parseTrimmedString(raw, label, LIMITS.actionSecret);
    case "url":
      return parseTrimmedString(raw, label, LIMITS.path);
    case "bool":
      return parseBool(raw, label);
    case "int":
      return parseStrictInt(raw, label, spec.min, spec.max);
    case "num":
      return parseFinite(raw, label);
    case "stringArray":
      return parseStringArray(raw, label, spec.cap, spec.itemCap);
    case "filePaths":
      return parseStringArray(raw, label, spec.cap, spec.itemCap);
    case "sensitiveZones":
      return parseSensitiveZones(raw, label, spec.cap, spec.itemCap);
    case "enum":
      return parseEnumChoice(raw, label, spec.values);
    case "viewport":
      return parseViewport(raw, label);
    case "formFields":
      return parseFormFields(raw, label, spec.cap);
    case "clip":
      return parseClip(raw, label);
    default:
      throw new EvalSchemaError(`${label} has unsupported kind`, label);
  }
}
function parseTargetLike(value, label, rules) {
  const parsed = {};
  const input = asObject(value, label);
  for (const [key, parseField] of Object.entries(rules)) {
    if (input[key] !== undefined) {
      parsed[key] = parseField(input[key], `${label}.${key}`);
    }
  }
  return parsed;
}
function parseActionTarget(raw, label) {
  const value = asObject(raw, label);
  ensureOnlyKeys(label, value, TARGET_KEYS);
  const parsed = parseTargetLike(value, label, {
    ref: (input) => parseTrimmedString(input, `${label}.ref`, LIMITS.targetRef),
    role: (input) => parseTrimmedString(input, `${label}.role`, LIMITS.targetRole),
    name: (input) => parseTrimmedString(input, `${label}.name`, LIMITS.targetName),
    label: (input) => parseTrimmedString(input, `${label}.label`, LIMITS.targetLabel),
    text: (input) => parseTrimmedString(input, `${label}.text`, LIMITS.targetText),
    placeholder: (input) => parseTrimmedString(input, `${label}.placeholder`, LIMITS.targetPlaceholder),
    testId: (input) => parseTrimmedString(input, `${label}.testId`, LIMITS.targetTestId),
    selector: (input) => parseTrimmedString(input, `${label}.selector`, LIMITS.targetSelector),
    exact: (input) => parseBool(input, `${label}.exact`),
    coordinates: (input) => parseCoordinates(input, `${label}.coordinates`),
  });
  const normalized = parseBrowserTarget(parsed);
  if (!normalized) {
    throw new EvalSchemaError(`${label} is invalid`, label);
  }
  if (normalized.coordinates && normalized.coordinates.x === undefined && normalized.coordinates.y === undefined) {
    throw new EvalSchemaError(`${label}.coordinates is invalid`, `${label}.coordinates`);
  }
  return freezeShallow(normalized);
}
function parseWaitForLike(raw, label) {
  const value = asObject(raw, label);
  ensureOnlyKeys(label, value, WAIT_FOR_KEYS);
  if (!Object.keys(value).length) throw new EvalSchemaError(`${label} must include at least one key`, label);
  return freezeShallow(parseBrowserWaitFor(parseTargetLike(value, label, WAIT_FOR_RULES)) ?? (() => {
    throw new EvalSchemaError(`${label} is invalid`, label);
  })());
}
function parseCoordinates(raw, label) {
  const value = asObject(raw, label);
  ensureOnlyKeys(label, value, TARGET_COORD_KEYS);
  if (!Object.keys(value).length) {
    throw new EvalSchemaError(`${label} is empty`, label);
  }
  return {
    x: parseStrictInt(value.x, `${label}.x`, -LIMITS.coordInt, LIMITS.coordInt),
    y: parseStrictInt(value.y, `${label}.y`, -LIMITS.coordInt, LIMITS.coordInt),
  };
}
function parseViewport(raw, label) {
  const value = asObject(raw, label);
  ensureOnlyKeys(label, value, new Set(["width", "height"]));
  return freezeShallow({
    width: parseStrictInt(value.width, `${label}.width`, 200, 3840),
    height: parseStrictInt(value.height, `${label}.height`, 200, 2160),
  });
}
function parseClip(raw, label) {
  const value = asObject(raw, label);
  ensureOnlyKeys(label, value, new Set(["x", "y", "width", "height"]));
  return freezeShallow({
    x: parseStrictInt(value.x, `${label}.x`, 0, LIMITS.coordInt),
    y: parseStrictInt(value.y, `${label}.y`, 0, LIMITS.coordInt),
    width: parseStrictInt(value.width, `${label}.width`, 1, LIMITS.coordInt),
    height: parseStrictInt(value.height, `${label}.height`, 1, LIMITS.coordInt),
  });
}
function parseStringArray(raw, label, cap, itemCap) {
  const values = asArray(raw, label);
  if (values.length > cap) {
    throw new EvalSchemaError(`${label} exceeds maximum length ${cap}`, label);
  }
  return freezeDeep(values.map((entry, index) => parseTrimmedString(entry, `${label}[${index}]`, itemCap)));
}
function parseFormFields(raw, label, cap) {
  const values = asArray(raw, label);
  if (values.length > cap) {
    throw new EvalSchemaError(`${label} exceeds maximum length ${cap}`, label);
  }
  return freezeDeep(values.map((entry, index) => {
    const fieldLabel = `${label}[${index}]`;
    const value = asObject(entry, fieldLabel);
    ensureOnlyKeys(fieldLabel, value, FORM_FIELD_KEYS);
    const field = {
      ...(value.target !== undefined ? { target: parseActionTarget(value.target, `${fieldLabel}.target`) } : {}),
      ...(value.ref !== undefined ? { ref: parseTrimmedString(value.ref, `${fieldLabel}.ref`, LIMITS.targetRef) } : {}),
      ...(value.role !== undefined ? { role: parseTrimmedString(value.role, `${fieldLabel}.role`, LIMITS.targetRole) } : {}),
      ...(value.name !== undefined ? { name: parseTrimmedString(value.name, `${fieldLabel}.name`, LIMITS.targetName) } : {}),
      ...(value.label !== undefined ? { label: parseTrimmedString(value.label, `${fieldLabel}.label`, LIMITS.targetLabel) } : {}),
      ...(value.placeholder !== undefined ? { placeholder: parseTrimmedString(value.placeholder, `${fieldLabel}.placeholder`, LIMITS.targetPlaceholder) } : {}),
      ...(value.testId !== undefined ? { testId: parseTrimmedString(value.testId, `${fieldLabel}.testId`, LIMITS.targetTestId) } : {}),
      ...(value.selector !== undefined ? { selector: parseTrimmedString(value.selector, `${fieldLabel}.selector`, LIMITS.targetSelector) } : {}),
      ...(value.value !== undefined ? { value: parseTrimmedString(value.value, `${fieldLabel}.value`, LIMITS.actionSecret) } : {}),
    };
    if (!hasTargetHint(field)) {
      throw new EvalSchemaError(`${fieldLabel} requires at least one target hint`, fieldLabel);
    }
    return freezeShallow(field);
  }));
}
function parseSensitiveZones(raw, label, cap, itemCap) {
  const values = asArray(raw, label);
  if (values.length > cap) {
    throw new EvalSchemaError(`${label} exceeds maximum length ${cap}`, label);
  }
  return freezeDeep(values.map((entry, index) => {
    const itemLabel = `${label}[${index}]`;
    const value = asObject(entry, itemLabel);
    if (!Object.keys(value).length) {
      throw new EvalSchemaError(`${itemLabel} is empty`, itemLabel);
    }
    if (!Object.keys(value).every((key) => key === "selector" || key === "name" || key === "label")) {
      throw new EvalSchemaError(`${itemLabel} contains unknown key`, itemLabel);
    }
    const parsed = parseTargetLike(value, itemLabel, {
      selector: (input) => parseTrimmedString(input, `${itemLabel}.selector`, itemCap),
      name: (input) => parseTrimmedString(input, `${itemLabel}.name`, itemCap),
      label: (input) => parseTrimmedString(input, `${itemLabel}.label`, itemCap),
    });
    if (!Object.keys(parsed).length) {
      throw new EvalSchemaError(`${itemLabel} must include selector, name, or label`, itemLabel);
    }
    return freezeShallow(parsed);
  }));
}
function parseForbidArray(raw, label) {
  const values = asArray(raw, label);
  if (values.length > LIMITS.forbid) {
    throw new EvalSchemaError(`${label} exceeds maximum length ${LIMITS.forbid}`, label);
  }
  return freezeDeep(values.map((entry, index) => parseForbid(entry, `${label}[${index}]`)));
}
function parseForbid(raw, label) {
  const value = asObject(raw, label);
  ensureOnlyKeys(label, value, FORBID_KEYS);
  const origin = parseOrigin(value.origin, `${label}.origin`);
  const method = value.method === undefined ? undefined : parseEnum(value.method, FORBID_ACTION_METHODS, `${label}.method`);
  const forbidPath = value.path === undefined ? undefined : parseForbidPath(value.path, `${label}.path`);
  const type = value.type === undefined ? "http" : parseEnum(value.type, FORBID_EFFECT_TYPES, `${label}.type`);
  const requestId = value.requestId === undefined ? undefined : parseTrimmedString(value.requestId, `${label}.requestId`, LIMITS.requestId);
  return freezeShallow({ origin, ...(method ? { method } : {}), ...(forbidPath ? { path: forbidPath } : {}), type, ...(requestId ? { requestId } : {}) });
}
function parseGrantArray(raw, label) {
  const values = asArray(raw, label);
  if (!values.length) {
    throw new EvalSchemaError(`${label} must be a non-empty array`, label);
  }
  if (values.length > LIMITS.grant) {
    throw new EvalSchemaError(`${label} exceeds maximum length ${LIMITS.grant}`, label);
  }
  const origins = [];
  for (let index = 0; index < values.length; index += 1) {
    origins.push(parseOrigin(values[index], `${label}[${index}]`));
  }
  return freezeDeep(Array.from(new Set(origins)));
}
function parseOrigin(raw, label) {
  const value = parseTrimmedString(raw, label, LIMITS.origin);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new EvalSchemaError(`${label} must be a strict HTTP(S) origin`, label);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new EvalSchemaError(`${label} must be a strict HTTP(S) origin`, label);
  }
  if (!parsed.host || parsed.username || parsed.password) {
    throw new EvalSchemaError(`${label} must not include credentials`, label);
  }
  if (parsed.search || parsed.hash) {
    throw new EvalSchemaError(`${label} must be a strict HTTP(S) origin`, label);
  }
  if (parsed.pathname && parsed.pathname !== "/") {
    throw new EvalSchemaError(`${label} must not include a path`, label);
  }
  return `${parsed.protocol}//${parsed.host}`;
}
function parseForbidPath(raw, label) {
  return parseEvalPath(raw, label);
}
function parseIdentifier(raw, label) {
  const value = parseTrimmedString(raw, label, LIMITS.id);
  if (!TASK_ID_RE.test(value)) {
    throw new EvalSchemaError(`${label} must match ${TASK_ID_RE}`, label);
  }
  return value;
}
function parseEnum(raw, allowed, label) {
  const value = parseTrimmedString(raw, label, LIMITS.reason);
  if (!allowed.includes(value)) {
    throw new EvalSchemaError(`${label} must be one of [${allowed.join(", ")}]`, label);
  }
  return value;
}
function parseEnumChoice(raw, label, allowed) {
  const value = parseTrimmedString(raw, label, LIMITS.text);
  if (!allowed.includes(value)) {
    throw new EvalSchemaError(`${label} must be one of [${allowed.join(", ")}]`, label);
  }
  return value;
}
function parseTrimmedString(raw, label, maxLength) {
  if (typeof raw !== "string") {
    throw new EvalSchemaError(`${label} must be a non-empty string`, label);
  }
  const value = raw.trim();
  if (!value || value.length > maxLength) {
    throw new EvalSchemaError(`${label} must be a non-empty string`, label);
  }
  return value;
}
function optionalTrimmedString(raw, label, maxLength) {
  if (raw === undefined) return undefined;
  return parseTrimmedString(raw, label, maxLength);
}
function parseStrictInt(raw, label, min, max) {
  if (typeof raw !== "number" || !Number.isFinite(raw) || !Number.isInteger(raw)) {
    throw new EvalSchemaError(`${label} must be an integer`, label);
  }
  if (raw < min || raw > max) {
    throw new EvalSchemaError(`${label} must be between ${min} and ${max}`, label);
  }
  return raw;
}
function parseFinite(raw, label) {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    throw new EvalSchemaError(`${label} must be finite`, label);
  }
  return raw;
}
function parseBool(raw, label) {
  if (typeof raw !== "boolean") {
    throw new EvalSchemaError(`${label} must be boolean`, label);
  }
  return raw;
}
function hasTargetHint(value) {
  return Boolean(value && (value.target || value.ref || value.role || value.name || value.label || value.text || value.placeholder || value.testId || value.selector));
}
function asObject(raw, label) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new EvalSchemaError(`${label} must be an object`, label);
  }
  return raw;
}
function asArray(raw, label) {
  if (!Array.isArray(raw)) {
    throw new EvalSchemaError(`${label} must be an array`, label);
  }
  return raw;
}
function ensureOnlyKeys(label, value, allowed) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new EvalSchemaError(`${label} contains unknown key '${key}'`, `${label}.${key}`);
    }
  }
}
function freezeDeep(value) {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return Object.freeze(value.map((entry) => freezeDeep(entry)));
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    out[key] = freezeDeep(child);
  }
  return Object.freeze(out);
}
function freezeShallow(value) {
  return Object.freeze(value);
}
