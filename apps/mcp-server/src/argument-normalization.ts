// Agents often write a call in a shape close to the contract but not exact: a wait's element on
// the action itself, a select's `label`, `timeoutMs` beside the command. Each rewrite here has
// exactly one meaning; the strict parser still checks the result, so conflicting or ambiguous
// input is refused as before. Every rewrite is reported back so the agent learns the exact form.
import { ENGINE_WAIT_STATES } from "@newton-browser/core";

type Value = Record<string, unknown>;
const isObject = (value: unknown): value is Value => !!value && typeof value === "object" && !Array.isArray(value);
const ACTION_KINDS = new Set(["fill", "type", "clear", "edit", "click", "hover", "drag", "click_at", "move", "select", "press", "scroll", "navigate", "back", "forward",
  "reload", "wait_for", "dialog_accept", "dialog_dismiss", "resize", "set_files", "sequence"]);
const WAIT_STATES = new Set<string>(ENGINE_WAIT_STATES);
const WAIT_FIELDS = ["target", "state", "url", "title", "text", "value", "timeoutMs"] as string[];
const COMMAND_FIELDS = ["commandId", "pageId", "action", "timeoutMs", "observe", "maxBytes"] as const;
const REF = /^e\d{1,9}$/u;
/** Actions whose own `waitFor` waits after them; any other action followed by a wait becomes a sequence. */
const WAITING_KINDS = new Set(["click", "hover", "drag", "click_at", "move"]);
const MAX_STEPS = 32;
const DRAG_KINDS = new Set(["drag_and_drop", "dragAndDrop", "drag_drop", "drag_to"]);
const MAX_NOTES = 8;

export type NormalizedArguments = { args: unknown; normalized: string[] };

/** Rewrites unambiguous near-miss arguments of one tool call into the exact contract shape. */
export function normalizeToolArguments(tool: unknown, raw: unknown): NormalizedArguments {
  if (!isObject(raw)) return { args: raw, normalized: [] };
  const notes: string[] = [];
  const note = (text: string) => { if (notes.length < MAX_NOTES) notes.push(text); };
  const args: Value = structuredClone(raw);
  if (tool === "browser.act") normalizeAct(args, note);
  else {
    for (const key of ["timeoutMs", "maxBytes", "limit"]) numeric(args, key, key, note);
    // A read scope names its container like an action target.
    if (args.scope !== undefined && (tool === "browser.observe" || tool === "browser.document.read")) args.scope = normalizeTarget(args.scope, "scope", note);
  }
  return { args, normalized: notes };
}

function normalizeAct(args: Value, note: (text: string) => void): void {
  // `{ sessionId, commandId, action }`: the command written without its wrapper.
  if (args.command === undefined && args.action !== undefined) {
    const command: Value = {};
    for (const key of COMMAND_FIELDS) if (args[key] !== undefined) { command[key] = args[key]; delete args[key]; }
    args.command = command;
    note("command fields → command");
  }
  if (!isObject(args.command)) return;
  const command = args.command;
  // Command options written beside `command` instead of inside it.
  for (const key of COMMAND_FIELDS) {
    if (key === "action" || args[key] === undefined || command[key] !== undefined) continue;
    command[key] = args[key]; delete args[key];
    note(`${key} → command.${key}`);
  }
  for (const key of ["commandId", "timeoutMs", "maxBytes"]) numeric(command, key, `command.${key}`, note);
  if (!isObject(command.action)) return;
  // A wait written on the command means the same as one on its action.
  if (isObject(command.waitFor) && command.action.waitFor === undefined) {
    command.action.waitFor = command.waitFor; delete command.waitFor;
    note("command.waitFor → action.waitFor");
  }
  normalizeAction(command.action, "action", note);
  if (command.action.kind === "sequence" && Array.isArray(command.action.steps)) {
    command.action.steps.forEach((step, index) => { if (isObject(step)) normalizeAction(step, `action.steps[${index}]`, note); });
    const steps: unknown[] = [];
    for (const [index, step] of command.action.steps.entries()) steps.push(...splitWait(step, `action.steps[${index}]`, note));
    if (steps.length <= MAX_STEPS) command.action.steps = steps;
  } else {
    const steps = splitWait(command.action, "action", note);
    if (steps.length > 1) command.action = { kind: "sequence", steps };
  }
}

/** `waitFor` on an action that has none of its own (navigate, fill, …) means: do it, then wait. */
function splitWait(step: unknown, path: string, note: (text: string) => void): unknown[] {
  if (!isObject(step) || !isObject(step.waitFor) || typeof step.kind !== "string" || WAITING_KINDS.has(step.kind) || step.kind === "wait_for" || step.kind === "sequence") return [step];
  const { waitFor, ...action } = step;
  if (waitFor.kind !== undefined) return [step];
  note(`${path}.waitFor → a following wait_for step`);
  return [action, { kind: "wait_for", ...waitFor }];
}

function normalizeAction(action: Value, path: string, note: (text: string) => void): void {
  if (action.kind === undefined && typeof action.type === "string" && ACTION_KINDS.has(action.type)) {
    action.kind = action.type; delete action.type;
    note(`${path}.type → ${path}.kind`);
  }
  if (typeof action.kind === "string" && DRAG_KINDS.has(action.kind)) { note(`${path}.kind "${action.kind}" → "drag"`); action.kind = "drag"; }
  if (action.kind === "drag") {
    // The dragged element is `target` and the drop target `to`; the other common spellings mean the same.
    const named = ["source", "from"].filter(key => action[key] !== undefined);
    if (named.length === 1) {
      const key = named[0]!;
      if (action.to === undefined && action.target !== undefined) { action.to = action.target; delete action.target; note(`${path}.target → ${path}.to`); }
      if (action.target === undefined) { action.target = action[key]; delete action[key]; note(`${path}.${key} → ${path}.target`); }
    }
    for (const key of ["destination", "dropTarget", "toTarget"]) {
      if (action.to === undefined && action[key] !== undefined) { action.to = action[key]; delete action[key]; note(`${path}.${key} → ${path}.to`); }
    }
    if (action.to !== undefined) action.to = normalizeTarget(action.to, `${path}.to`, note);
  }
  if (action.target !== undefined) action.target = normalizeTarget(action.target, `${path}.target`, note);
  // press takes a chord as `keys`; `key`, or a string such as "Control+a", can only mean that chord.
  if (action.kind === "press") {
    if (action.keys === undefined && action.key !== undefined) { action.keys = action.key; delete action.key; note(`${path}.key → ${path}.keys`); }
    if (typeof action.keys === "string") {
      const parts = action.keys.length > 1 && action.keys.includes("+") ? action.keys.split("+") : [action.keys];
      if (parts.every(part => part.length > 0)) { action.keys = parts; note(`${path}.keys "${parts.join("+")}" → [${parts.map(part => JSON.stringify(part)).join(", ")}]`); }
    }
  }
  // fill and type take `value`; `text` there can only mean the same thing (press keeps its own `text`).
  if ((action.kind === "fill" || action.kind === "type") && action.value === undefined && typeof action.text === "string") {
    action.value = action.text; delete action.text;
    note(`${path}.text → ${path}.value`);
  }
  if (action.kind === "select") {
    if (action.value === undefined && typeof action.label === "string") { action.value = action.label; delete action.label; note(`${path}.label → ${path}.value`); }
    if (isObject(action.value)) {
      const keys = Object.keys(action.value);
      const only = keys.length === 1 && ["label", "value", "text"].includes(keys[0]!) ? action.value[keys[0]!] : undefined;
      if (typeof only === "string") { action.value = only; note(`${path}.value.${keys[0]} → ${path}.value`); }
    }
  }
  if (action.kind === "wait_for") {
    // The condition is written on the wait itself. A nested waitFor, or a flat ref/selector/role, is lifted
    // and cleaned like any waitFor; a field given in both places is left for the strict check to refuse.
    const nested = isObject(action.waitFor) ? action.waitFor : {};
    const condition: Value = { ...nested };
    let conflict = false;
    for (const key of [...WAIT_FIELDS, "ref", "selector", "role", "name"]) {
      if (action[key] === undefined) continue;
      if (condition[key] !== undefined && JSON.stringify(condition[key]) !== JSON.stringify(action[key])) conflict = true;
      condition[key] = action[key];
    }
    if (!conflict) {
      const before = JSON.stringify(condition);
      normalizeWaitFor(condition, action.waitFor !== undefined ? `${path}.waitFor` : path, note);
      // An unrecognized nested kind would replace the action's own kind: leave it for the strict check.
      if (condition.kind !== undefined) return;
      if (action.waitFor !== undefined) note(`${path}.waitFor.{${Object.keys(nested).join(",")}} → ${path}`);
      else if (JSON.stringify(condition) === before) return;
      for (const key of ["waitFor", ...WAIT_FIELDS, "ref", "selector", "role", "name"]) delete action[key];
      Object.assign(action, condition);
    }
    return;
  }
  if (isObject(action.waitFor)) normalizeWaitFor(action.waitFor, `${path}.waitFor`, note);
}

function normalizeWaitFor(waitFor: Value, path: string, note: (text: string) => void): void {
  // `kind` used for the state (`{ kind: "visible", target }`), or for a target written flat (`{ kind: "ref", ref }`).
  if (typeof waitFor.kind === "string") {
    if (WAIT_STATES.has(waitFor.kind) && waitFor.state === undefined) { waitFor.state = waitFor.kind; delete waitFor.kind; note(`${path}.kind → ${path}.state`); }
    else if (["ref", "selector", "semantic"].includes(waitFor.kind) && waitFor.target === undefined) {
      const target: Value = { kind: waitFor.kind };
      for (const key of ["ref", "selector", "role", "name", "exact"]) if (waitFor[key] !== undefined) { target[key] = waitFor[key]; delete waitFor[key]; }
      delete waitFor.kind; waitFor.target = target;
      note(`${path}.{kind,…} → ${path}.target`);
    }
  }
  // The element written flat, as releases before 0.7.8 took it.
  if (waitFor.target === undefined) {
    const flat = waitFor.ref !== undefined ? { kind: "ref", ref: waitFor.ref }
      : waitFor.selector !== undefined ? { kind: "selector", selector: waitFor.selector }
      : waitFor.role !== undefined && waitFor.name !== undefined ? { kind: "semantic", role: waitFor.role, name: waitFor.name } : undefined;
    const used = waitFor.ref !== undefined ? ["ref"] : waitFor.selector !== undefined ? ["selector"] : ["role", "name"];
    const others = ["ref", "selector", "role"].filter(key => !used.includes(key) && waitFor[key] !== undefined);
    if (flat && !others.length) {
      for (const key of used) delete waitFor[key];
      waitFor.target = flat;
      note(`${path}.${used.join("+")} → ${path}.target`);
    }
  }
  if (waitFor.target !== undefined) waitFor.target = normalizeTarget(waitFor.target, `${path}.target`, note);
  numeric(waitFor, "timeoutMs", `${path}.timeoutMs`, note);
}

/** `"e12"` is a ref; an object with exactly one way to find the element gets its `kind`. */
function normalizeTarget(target: unknown, path: string, note: (text: string) => void): unknown {
  if (typeof target === "string" && REF.test(target)) { note(`${path} "${target}" → { kind: "ref" }`); return { kind: "ref", ref: target }; }
  if (!isObject(target) || target.kind !== undefined) return target;
  const ways = [target.ref !== undefined ? "ref" : "", target.selector !== undefined ? "selector" : "", target.role !== undefined && target.name !== undefined ? "semantic" : ""].filter(Boolean);
  if (ways.length !== 1) return target;
  note(`${path}.kind = "${ways[0]}"`);
  return { kind: ways[0], ...target };
}

function numeric(value: Value, key: string, path: string, note: (text: string) => void): void {
  if (typeof value[key] === "string" && /^\d{1,15}$/u.test(value[key] as string)) { value[key] = Number(value[key]); note(`${path} "${value[key]}" → number`); }
}
