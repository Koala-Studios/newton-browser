const target = { oneOf: [
  { type: "object", properties: { kind: { const: "ref" }, ref: { type: "string", maxLength: 120, minLength: 1 } }, required: ["kind", "ref"], additionalProperties: false },
  { type: "object", properties: { kind: { const: "selector" }, selector: { type: "string", maxLength: 1024, minLength: 1 } }, required: ["kind", "selector"], additionalProperties: false },
  { type: "object", properties: { kind: { const: "semantic" }, role: { type: "string", maxLength: 80, minLength: 1 }, name: { type: "string", maxLength: 1024, minLength: 1 }, exact: { type: "boolean", default: true } }, required: ["kind", "role", "name"], additionalProperties: false },
] };
export const ENGINE_TARGET_SCHEMA = target;
const fill = {
  type: "object",
  properties: { kind: { const: "fill" }, target, value: { type: "string", maxLength: 65536 } },
  required: ["kind", "target", "value"], additionalProperties: false,
};
const type = {
  type: "object",
  properties: { kind: { const: "type" }, target, value: { type: "string", maxLength: 65536 } },
  required: ["kind", "target", "value"], additionalProperties: false,
};
const clear = { type: "object", properties: { kind: { const: "clear" }, target }, required: ["kind", "target"], additionalProperties: false };
const edit = {type:'object',description:'Replace an exact text match within one editable field using native selection and input. Ambiguous matches require immediate prefix/suffix context or a one-based occurrence. Surrounding text is preserved; selection and value are verified before insertion. Bounded selection may return work_limit or unsupported_structure without changing text.',
  properties:{kind:{const:'edit'},target,match:{type:'string',minLength:1,maxLength:4096},replacement:{type:'string',maxLength:65536},prefix:{type:'string',maxLength:4096},suffix:{type:'string',maxLength:4096},occurrence:{type:'integer',minimum:1,maximum:65536}},required:['kind','target','match','replacement'],additionalProperties:false};
const waitFor = {
  type: "object", minProperties: 1, additionalProperties: false,
  description: "Give url, title, text, or an element as target (the same target as actions) with an optional state; value needs state \"value\".",
  allOf: [
    { anyOf: ["url", "title", "text", "target"].map(key => ({ required: [key] })) },
    { if: { required: ["state"] }, then: { required: ["target"] } },
    { if: { required: ["value"] }, then: { required: ["state"], properties: { state: { const: "value" } } } },
    { if: { required: ["state"], properties: { state: { const: "value" } } }, then: { required: ["value"] } },
  ],
  properties: {
    url: { type: "string", minLength: 1, maxLength: 1024 }, title: { type: "string", minLength: 1, maxLength: 1024 },
    text: { type: "string", minLength: 1, maxLength: 1024 }, target, value: { type: "string", maxLength: 1024 },
    state: { enum: ["attached", "detached", "visible", "hidden", "enabled", "disabled", "checked", "unchecked", "value"] },
    timeoutMs: { type: "integer", minimum: 1, maximum: 120000 },
  },
};
const click = { type: "object", properties: { kind: { const: "click" }, target, waitFor, button: { enum: ["left", "right", "middle"] }, clickCount: { type: "integer", minimum: 1, maximum: 3 } }, required: ["kind", "target"], additionalProperties: false };
const hover = { type: "object", properties: { kind: { const: "hover" }, target, waitFor }, required: ["kind", "target"], additionalProperties: false };
const drag = { type: "object", description: "Drag target and drop it on to: native HTML5 drag and drop or a mouse-driven drag.", properties: { kind: { const: "drag" }, target, to: target, waitFor }, required: ["kind", "target", "to"], additionalProperties: false };
const clickAt = { type: "object", properties: { kind: { enum: ["click_at", "move"] }, captureId: { type: "string", minLength: 1, maxLength: 120 }, x: { type: "number" }, y: { type: "number" }, waitFor }, required: ["kind", "captureId", "x", "y"], additionalProperties: false };
const select = { type: "object", properties: { kind: { const: "select" }, target, value: { type: "string", maxLength: 65536, description: "The option's value or its visible label." } }, required: ["kind", "target", "value"], additionalProperties: false };
const press = {
  type: "object", properties: { kind: { const: "press" }, target, keys: { type: "array", minItems: 1, maxItems: 8, description: "One chord, modifiers first: [\"Enter\"], [\"Control\", \"a\"].", items: { type: "string", minLength: 1, maxLength: 80 } }, text: { type: "string", maxLength: 65536, description: "Text inserted as typed input." } },
  required: ["kind"], anyOf: [{ required: ["keys"] }, { required: ["text"] }], additionalProperties: false,
};
const scroll = { type: "object", properties: { kind: { const: "scroll" }, x: { type: "number" }, y: { type: "number" }, target }, required: ["kind", "x", "y"], additionalProperties: false };
const navigate = { type: "object", properties: { kind: { const: "navigate" }, url: { type: "string", minLength: 1, maxLength: 8192 } }, required: ["kind", "url"], additionalProperties: false };
const history = { type: "object", properties: { kind: { enum: ["back", "forward", "reload"] } }, required: ["kind"], additionalProperties: false };
// A wait action carries the condition fields itself, so it reads like every other action.
const wait = { type: "object", description: "Wait for url, title or text, or for target in a state.", properties: { kind: { const: "wait_for" }, ...waitFor.properties }, required: ["kind"],
  allOf: waitFor.allOf, additionalProperties: false };
const dialogAccept = { type: "object", properties: { kind: { const: "dialog_accept" }, dialogId: { type: "string", minLength: 1, maxLength: 120, description: "Optional when the page has one open dialog." }, promptText: { type: "string", maxLength: 65536 } }, required: ["kind"], additionalProperties: false };
const dialogDismiss = { type: "object", properties: { kind: { const: "dialog_dismiss" }, dialogId: { type: "string", minLength: 1, maxLength: 120, description: "Optional when the page has one open dialog." } }, required: ["kind"], additionalProperties: false };
const resize = {type:'object',description:'Resize the page in CSS pixels. An owned browser resizes its window; a tab in the operator\'s own Chrome renders at that size without resizing their window.',properties:{kind:{const:'resize'},width:{type:'integer',minimum:320,maximum:7680},height:{type:'integer',minimum:240,maximum:4320}},required:['kind','width','height'],additionalProperties:false};
const setFiles = {type:'object',properties:{kind:{const:'set_files'},target,files:{type:'array',description:'Exact absolute local PNG/JPEG/WebP/GIF/MP4/WebM paths; 50 MiB per file, 200 MiB total. Hidden native file inputs can be targeted explicitly.',minItems:1,maxItems:8,items:{type:'string',minLength:1,maxLength:32768}}},required:['kind','target','files'],additionalProperties:false};
const primitives = [fill, type, clear, edit, click, hover, drag, clickAt, select, press, scroll, navigate, history, wait, dialogAccept, dialogDismiss, resize, setFiles];
// JSON Schema applies sibling properties and oneOf together. Keep the empty
// property declarations in each variant so its strict field allowlist survives;
// validate the repeated subtrees once at the enclosing object instead.
const compactPrimitives = primitives.map(primitive => ({
  ...primitive,
  properties: Object.fromEntries(Object.entries(primitive.properties).map(([key, schema]) =>
    [key, (key === "target" && schema === target) || (key === "waitFor" && schema === waitFor) ? {} : schema])),
}));
export const ENGINE_COMMAND_SCHEMA = {
  type: "object", properties: {
    commandId: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER }, pageId: { type: "string", minLength: 1, maxLength: 120 },
    action: {
      type: "object",
      properties: { target, waitFor },
      oneOf: [...compactPrimitives,
        { type: "object", properties: { kind: { const: "sequence" }, steps: { type: "array", minItems: 1, maxItems: 32, items: { type: "object", properties: { target, waitFor }, oneOf: compactPrimitives } } },
          required: ["kind", "steps"], additionalProperties: false }],
    },
    timeoutMs: { type: "integer", minimum: 1, maximum: 120000, description: "Default 10000 plus the timeoutMs of the waits in the command." },
    observe: { enum: ["local", "none"], default: "local" }, maxBytes: { type: "integer", minimum: 2048, maximum: 65536, default: 8192 },
  }, required: ["commandId", "action"], additionalProperties: false,
};
