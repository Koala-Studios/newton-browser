import { BROWSER_ACTION_KINDS, type BrowserActionKind } from "./protocol.ts";

const REF_PATTERN = "^d[1-9][0-9]*(?::f[1-9][0-9]*)?:e[1-9][0-9]*$";
const targetFields = ["target", "ref", "role", "name", "label", "placeholder", "testId", "exact", "text", "selector", "x", "y"] as const;

export const ACTION_VARIANT_FIELDS: Readonly<Record<BrowserActionKind, readonly string[]>> = Object.freeze({
  observe: ["query", "maxNodes", "roles", "includeInteractive", "mode", "maxChars"],
  screenshot: ["sensitiveZones", "fullPage", "device", "waitMs", "inline", "clip", "format", "quality"],
  click: [...targetFields, "intent"],
  fill: [...targetFields, "value", "intent"],
  type: [...targetFields, "value", "intent"],
  select: [...targetFields, "value"],
  scroll: ["x", "y"],
  navigate: ["url", "intent"],
  back: [],
  forward: [],
  reload: [],
  press: ["keys", "text"],
  clear: [...targetFields],
  set_files: [...targetFields, "files"],
  hover: [...targetFields],
  move: [...targetFields],
  wait_for: ["waitFor"],
  dialog_accept: ["promptText"],
  dialog_dismiss: [],
  resize: ["viewport"],
  fill_form: ["fields"],
  console: ["level", "pattern", "limit", "clear"],
  network: ["urlPattern", "requestId", "limit"],
});

export const ACTION_REQUIRED_FIELDS: Readonly<Partial<Record<BrowserActionKind, readonly string[]>>> = Object.freeze({
  navigate: ["url"],
  fill: ["value"],
  type: ["value"],
  select: ["value"],
  press: ["keys"],
  set_files: ["files"],
  wait_for: ["waitFor"],
  resize: ["viewport"],
  fill_form: ["fields"],
});

export const TARGET_REQUIRED_ACTION_KINDS = new Set<BrowserActionKind>([
  "click", "fill", "type", "select", "clear", "set_files", "hover", "move",
]);

const targetSchema = {
  type: "object",
  additionalProperties: false,
  anyOf: [
    { required: ["ref"] }, { required: ["role"] }, { required: ["text"] },
    { required: ["label"] }, { required: ["placeholder"] }, { required: ["testId"] },
    { required: ["selector"] }, { required: ["coordinates"] },
  ],
  properties: {
    ref: { type: "string", pattern: REF_PATTERN },
    role: { type: "string", minLength: 1, maxLength: 80 },
    name: { type: "string", minLength: 1, maxLength: 240 },
    text: { type: "string", minLength: 1, maxLength: 240 },
    label: { type: "string", minLength: 1, maxLength: 240 },
    placeholder: { type: "string", minLength: 1, maxLength: 240 },
    testId: { type: "string", minLength: 1, maxLength: 240 },
    selector: { type: "string", minLength: 1, maxLength: 240 },
    exact: { type: "boolean" },
    coordinates: {
      type: "object", additionalProperties: false, required: ["x", "y"],
      properties: { x: { type: "number" }, y: { type: "number" } },
    },
  },
} as const;

const targetRequirement = {
  anyOf: [
    { required: ["target"] }, { required: ["ref"] }, { required: ["role"] }, { required: ["name"] },
    { required: ["label"] }, { required: ["placeholder"] }, { required: ["testId"] },
    { required: ["selector"] }, { required: ["text"] }, { required: ["x", "y"] },
  ],
} as const;

const fieldSchemas: Record<string, unknown> = {
  target: targetSchema,
  waitFor: {
    type: "object", additionalProperties: false, minProperties: 1,
    properties: {
      url: { type: "string", minLength: 1, maxLength: 500 }, title: { type: "string", minLength: 1, maxLength: 240 },
      text: { type: "string", minLength: 1, maxLength: 240 }, selector: { type: "string", minLength: 1, maxLength: 240 },
      role: { type: "string", minLength: 1, maxLength: 80 }, name: { type: "string", minLength: 1, maxLength: 240 },
      ref: { type: "string", pattern: REF_PATTERN }, value: { type: "string", maxLength: 240 },
      state: { enum: ["attached", "detached", "visible", "hidden", "checked", "unchecked", "value"] },
      timeoutMs: { type: "integer", minimum: 100, maximum: 120000 },
    },
  },
  ref: { type: "string", pattern: REF_PATTERN },
  role: { type: "string", minLength: 1, maxLength: 80 },
  name: { type: "string", minLength: 1, maxLength: 240 },
  label: { type: "string", minLength: 1, maxLength: 240 },
  placeholder: { type: "string", minLength: 1, maxLength: 240 },
  testId: { type: "string", minLength: 1, maxLength: 240 },
  exact: { type: "boolean" }, value: { type: "string" }, url: { type: "string", minLength: 1, maxLength: 500 },
  text: { type: "string", minLength: 1, maxLength: 240 }, selector: { type: "string", minLength: 1, maxLength: 240 },
  query: { type: "string", maxLength: 240 }, maxNodes: { type: "integer", minimum: 1, maximum: 250 },
  roles: { type: "array", maxItems: 12, items: { type: "string", minLength: 1, maxLength: 80 } },
  includeInteractive: { type: "boolean" }, timeoutMs: { type: "integer", minimum: 100, maximum: 120000 },
  x: { type: "number" }, y: { type: "number" }, keys: { type: "array", minItems: 1, maxItems: 8, items: { type: "string", minLength: 1, maxLength: 80 } },
  files: { type: "array", minItems: 1, maxItems: 8, items: { type: "string", minLength: 1, maxLength: 32767 } },
  sensitiveZones: { type: "array", minItems: 1, maxItems: 32, items: { type: "object", additionalProperties: false, anyOf: [{ required: ["selector"] }, { required: ["name"] }, { required: ["label"] }], properties: { selector: { type: "string", minLength: 1, maxLength: 240 }, name: { type: "string", minLength: 1, maxLength: 240 }, label: { type: "string", minLength: 1, maxLength: 240 } } } },
  intent: { type: "string", maxLength: 240 }, fullPage: { type: "boolean" }, device: { enum: ["mobile", "desktop"] },
  waitMs: { type: "integer", minimum: 0, maximum: 10000 }, inline: { type: "boolean" }, clip: { type: "object", additionalProperties: false, required: ["x", "y", "width", "height"], properties: { x: { type: "number" }, y: { type: "number" }, width: { type: "number", exclusiveMinimum: 0 }, height: { type: "number", exclusiveMinimum: 0 } } },
  mode: { enum: ["full", "diff", "text"] }, maxChars: { type: "integer", minimum: 200, maximum: 200000 },
  promptText: { type: "string", maxLength: 240 }, viewport: { type: "object", additionalProperties: false, required: ["width", "height"], properties: { width: { type: "integer", minimum: 200, maximum: 3840 }, height: { type: "integer", minimum: 200, maximum: 2160 } } },
  fields: { type: "array", minItems: 1, maxItems: 32, items: { type: "object", additionalProperties: false, required: ["value"], ...targetRequirement, properties: { target: targetSchema, ref: { type: "string", pattern: REF_PATTERN }, role: { type: "string", maxLength: 80 }, name: { type: "string", maxLength: 240 }, label: { type: "string", maxLength: 240 }, placeholder: { type: "string", maxLength: 240 }, testId: { type: "string", maxLength: 240 }, selector: { type: "string", maxLength: 240 }, value: { type: "string" } } } },
  level: { enum: ["log", "info", "warn", "error", "debug"] }, pattern: { type: "string", maxLength: 240 },
  limit: { type: "integer", minimum: 1, maximum: 500 }, clear: { type: "boolean" }, urlPattern: { type: "string", maxLength: 500 },
  requestId: { type: "string", minLength: 1, maxLength: 240 }, format: { enum: ["png", "jpeg"] }, quality: { type: "integer", minimum: 1, maximum: 100 },
};

// MCP clients pay for this object on every catalog load. Expanding the same
// field schemas into 23 `oneOf` variants more than doubles the full catalog
// budget. The generated extension tables are the exact public variant contract;
// parseBrowserAction enforces them before bridge dispatch. Standard JSON Schema
// still rejects unknown fields, malformed refs, bad enums, and primitive errors.
const compactFieldSchemas = Object.fromEntries(Object.entries(fieldSchemas).map(([field, schema]) => {
  if (field === "target") return [field, { type: "object" }];
  if (field === "waitFor") return [field, { type: "object" }];
  if (field === "fields") return [field, { type: "array", minItems: 1, maxItems: 32, items: { type: "object" } }];
  if (field === "sensitiveZones") return [field, { type: "array", minItems: 1, maxItems: 32, items: { type: "object" } }];
  if (field === "clip" || field === "viewport") return [field, { type: "object" }];
  return [field, schema];
}));

export const BROWSER_ACTION_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["kind"],
  properties: {
    kind: { enum: BROWSER_ACTION_KINDS },
    ...compactFieldSchemas,
  },
  "x-newtonVariants": ACTION_VARIANT_FIELDS,
  "x-newtonRequired": ACTION_REQUIRED_FIELDS,
  "x-newtonTargetRequired": [...TARGET_REQUIRED_ACTION_KINDS],
} as const;

export const BROWSER_COMPOSITE_REF_PATTERN = new RegExp(REF_PATTERN, "u");
