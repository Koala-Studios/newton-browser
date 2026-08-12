import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { TASK_EXPECT_STATUSES, actionRequiresTarget, coerceParsedEvalTask, parseEvalPath } from "./schema.mjs";
const STEP_STATUSES = new Set(TASK_EXPECT_STATUSES);
const RESOLUTION_STATUSES = new Set(["resolved", "not_found", "ambiguous", "runner_contract_invalid"]);
const OBSERVATION_RESULT_KINDS = new Set(["observation", "observation_delta", "observation_text"]);
const RESULT_KIND_FIELDS = Object.freeze({
  screenshot: new Set(["kind"]),
  console_log: new Set(["kind"]),
  network_log: new Set(["kind"]),
  ack: new Set(["kind"]),
  observation: new Set(["kind", "nodes"]),
  observation_delta: new Set(["kind", "nodes"]),
  observation_text: new Set(["kind", "nodes"]),
});
const ALLOWED_RESULT_NODE_FIELDS = Object.freeze(["ref", "role", "name", "label", "text", "placeholder", "testId", "selector"]);
const TARGET_HINT_KEYS = Object.freeze(["ref", "role", "name", "label", "text", "placeholder", "testId", "selector"]);
const TARGET_HINT_SET = new Set(TARGET_HINT_KEYS);
const READ_ONLY_TOOLS = Object.freeze(new Set(["browser.observe", "browser.screenshot"]));
const ALLOWED_EFFECT_KEYS = Object.freeze(new Set(["origin", "method", "path", "type", "requestId"]));
const FORBID_ACTION_METHODS = Object.freeze(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "TRACE"]);
const FORBID_EFFECT_TYPES = Object.freeze(["http", "redirect", "beacon", "socket"]);
const LIMITS = Object.freeze({
  status: 96,
  reason: 320,
  path: 1024,
  code: 160,
  origin: 400,
  method: 80,
  requestId: 256,
  targetRole: 120,
  targetName: 240,
  targetLabel: 240,
  targetText: 240,
  targetPlaceholder: 240,
  targetTestId: 120,
  targetSelector: 500,
  stepRef: 240,
  nodes: 1024,
  text: 240,
});
const RESULT_NODE_FIELD_LIMITS = Object.freeze({
  ref: LIMITS.stepRef,
  role: LIMITS.targetRole,
  name: LIMITS.targetName,
  label: LIMITS.targetLabel,
  text: LIMITS.targetText,
  placeholder: LIMITS.targetPlaceholder,
  testId: LIMITS.targetTestId,
  selector: LIMITS.targetSelector,
});
const TARGET_HINT_LIMITS = Object.freeze({
  ref: LIMITS.stepRef,
  role: LIMITS.targetRole,
  name: LIMITS.targetName,
  label: LIMITS.targetLabel,
  text: LIMITS.targetText,
  placeholder: LIMITS.targetPlaceholder,
  testId: LIMITS.targetTestId,
  selector: LIMITS.targetSelector,
});
const FALLBACK_CODE = "runner_contract_invalid";
const HERMETIC_DIRECTORY_NAMES = Object.freeze(["home", "config", "cache", "profile", "downloads", "output"]);

export async function replayTask(rawTask, options = {}) {
  return withHermeticEvalRoots(
    (hermeticRoots) => replayTaskInHermeticRoots(rawTask, { ...options, hermeticRoots }),
    options.hermetic,
  );
}

async function replayTaskInHermeticRoots(rawTask, options) {
  const task = coerceParsedEvalTask(rawTask, options.label ?? "task");
  const runner = options.runner;
  if (typeof runner !== "function") {
    throw new TypeError("replayTask requires a runner function");
  }
  const fixtureAdapter = options.fixtureAdapter ?? {};
  const resolveRef = fixtureAdapter.resolveRef ?? options.resolveRef ?? fixtureResolveRef;
  const now = options.now ?? Date.now;
  const context = {
    taskId: task.id,
    fixture: task.fixture,
    grant: task.grant,
    state: {},
    hermetic: options.hermeticRoots,
    recordLocalWrite: options.hermeticRoots.recordWrite,
  };
  const steps = [];
  const startedAt = now();
  let setupFailure;
  let teardownFailure;
  if (typeof fixtureAdapter.setup === "function") {
    try {
      await fixtureAdapter.setup(task, context);
    } catch (error) {
      setupFailure = makeFailure("setup_failed", error);
    }
  }
  try {
    if (!setupFailure) {
      let halted = false;
      let previousResult = null;
      let previousObservation = null;
      for (let index = 0; index < task.steps.length; index += 1) {
        const step = task.steps[index];
        if (halted) {
          if (!options.diagnosticContinuation) break;
          if (!READ_ONLY_TOOLS.has(step.tool)) continue;
        }
        const stepResult = await runStep({
          index,
          task,
          step,
          previousResult,
          previousObservation,
          runner,
          resolveRef,
          forbiddenRules: task.forbid,
          fixtureAdapter,
          context,
        });
        steps.push(stepResult);
        previousResult = stepResult.result ?? previousResult;
        if (stepResult.result && OBSERVATION_RESULT_KINDS.has(stepResult.result.kind)) {
          previousObservation = stepResult.result;
        }
        if (!stepResult.passed || stepResult.forbidden.violated) halted = true;
      }
    }
  } finally {
    if (typeof fixtureAdapter.teardown === "function") {
      const teardownStatus = setupFailure ? "failed" : (steps.every((entry) => entry.passed && !entry.forbidden?.violated) ? "passed" : "failed");
      try {
        await fixtureAdapter.teardown(task, context, {
          status: teardownStatus,
          stepCount: steps.length,
        });
      } catch (error) {
        teardownFailure = makeFailure("teardown_failed", error);
      }
    }
  }
  return finalizeTask(task, steps, startedAt, now(), setupFailure, teardownFailure);
}
export async function replayTasks(tasks, options = {}) {
  const results = [];
  for (const task of tasks) {
    results.push(await replayTask(task, { ...options, label: task?.id ?? "task" }));
  }
  return results;
}

export async function withHermeticEvalRoots(callback, options = {}) {
  if (typeof callback !== "function") throw new TypeError("withHermeticEvalRoots requires a callback");
  const parent = path.resolve(options.parent ?? os.tmpdir());
  const root = await fs.promises.mkdtemp(path.join(parent, "newton-browser-eval-"));
  const recordedWrites = [];
  const directories = Object.fromEntries(HERMETIC_DIRECTORY_NAMES.map((name) => [name, path.join(root, name)]));
  try {
    await Promise.all(Object.values(directories).map((directory) => fs.promises.mkdir(directory, { recursive: false })));
    const roots = Object.freeze({
      root,
      ...directories,
      recordWrite(value) {
        const candidate = validateHermeticPath(value, root, "local write");
        recordedWrites.push(candidate);
        return candidate;
      },
    });
    const result = await callback(roots);
    if (typeof options.beforeCleanup === "function") await options.beforeCleanup(roots, result);
    for (const recorded of recordedWrites) validateHermeticPath(recorded, root, "recorded local write");
    return result;
  } finally {
    validateOwnedTempRoot(root, parent);
    await fs.promises.rm(root, { recursive: true, force: true });
  }
}

function validateHermeticPath(value, root, label) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} path required`);
  const candidate = path.resolve(value);
  const relative = path.relative(root, candidate);
  if (relative === "" || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    throw new Error(`${label} escaped hermetic root`);
  }
  return candidate;
}

function validateOwnedTempRoot(root, parent) {
  const relative = path.relative(parent, root);
  if (!relative.startsWith("newton-browser-eval-") || relative.includes(path.sep) || path.isAbsolute(relative)) {
    throw new Error("refusing to remove unowned eval root");
  }
}
async function runStep({
  index,
  task,
  step,
  previousResult,
  previousObservation,
  runner,
  resolveRef,
  forbiddenRules,
  fixtureAdapter,
  context,
}) {
  let prepared;
  try {
    prepared = await prepareStep({ step, previousObservation, resolveRef, context });
  } catch (error) {
    return failStep(index, step, parseText(error?.message, LIMITS.reason, FALLBACK_CODE));
  }
  if (prepared.skipped) {
    const passed = !prepared.forbidden?.violated && step.expect.status === prepared.status;
    return makeStepResult({
      index,
      step,
      status: prepared.status,
      reason: prepared.reason,
      passed,
      resolvedRef: prepared.resolvedRef,
      forbidden: prepared.forbidden ?? { violated: false, matchCount: 0 },
      errorCode: !passed ? (prepared.errorCode ?? "resolution_failed") : undefined,
    });
  }
  if (typeof fixtureAdapter.prepareStep === "function") {
    try {
      await fixtureAdapter.prepareStep({ task, step, index, action: prepared.action, context, previousResult, previousObservation });
    } catch (error) {
      return failStep(index, step, parseText(error?.message, LIMITS.reason, FALLBACK_CODE));
    }
  }
  let rawOutcome;
  try {
    rawOutcome = await runner({ task, step, index, action: prepared.action, context, previousResult });
  } catch (error) {
    rawOutcome = {
      status: FALLBACK_CODE,
      reason: parseText(error?.message, LIMITS.reason, FALLBACK_CODE),
      error: { code: FALLBACK_CODE },
    };
  }
  const outcome = validateRunnerOutcome(rawOutcome);
  const forbidden = checkForbidden(forbiddenRules, outcome.effects);
  const passed = !forbidden.violated && step.expect.status === outcome.status;
  const errorCode = outcome.error?.code || (forbidden.violated ? "forbidden" : passed ? undefined : outcome.status === FALLBACK_CODE ? FALLBACK_CODE : "runner_contract_invalid");
  return makeStepResult({
    index,
    step,
    status: outcome.status,
    reason: outcome.reason,
    passed,
    resolvedRef: prepared.resolvedRef,
    forbidden,
    result: outcome.result,
    errorCode,
  });
}
async function prepareStep({ step, previousObservation, resolveRef, context }) {
  if (step.tool !== "browser.act") {
    return {
      skipped: false,
      action: {
        ...(step.query !== undefined ? { query: step.query } : {}),
      },
    };
  }
  const action = step.action;
  if (!actionRequiresTarget(action.kind) || hasTargetHint(action)) {
    return { skipped: false, action };
  }
  const resolution = normalizeResolution(await resolveRef({
    previousObservation,
    hint: step.semanticRef,
    action,
    step,
    context,
  }));
  if (resolution.status !== "resolved") {
    return {
      skipped: true,
      status: resolution.status,
      reason: resolution.reason,
      resolvedRef: null,
      forbidden: { violated: false, matchCount: 0 },
      errorCode: resolution.status === FALLBACK_CODE ? FALLBACK_CODE : "resolution_failed",
    };
  }
  return {
    skipped: false,
    action: { ...action, ref: resolution.ref },
    resolvedRef: resolution.ref,
  };
}
function normalizeResolution(rawResolution) {
  if (rawResolution == null) return { status: "not_found", reason: "no resolution" };
  if (typeof rawResolution === "string") {
    const ref = parseText(rawResolution, LIMITS.stepRef, null);
    return ref
      ? { status: "resolved", ref, reason: "resolved" }
      : { status: FALLBACK_CODE, reason: "resolution ref invalid" };
  }
  if (!isObject(rawResolution)) return { status: FALLBACK_CODE, reason: "resolution must be an object" };
  for (const key of Object.keys(rawResolution)) {
    if (key !== "status" && key !== "ref" && key !== "reason") {
      return { status: FALLBACK_CODE, reason: "resolution contains unknown key" };
    }
  }
  const status = parseSet(rawResolution.status, RESOLUTION_STATUSES, FALLBACK_CODE, LIMITS.status);
  if (!status) return { status: FALLBACK_CODE, reason: "resolution status invalid" };
  if (status !== "resolved") return { status, reason: parseText(rawResolution.reason, LIMITS.reason, status) };
  const ref = parseText(rawResolution.ref, LIMITS.stepRef, null);
  return ref
    ? { status: "resolved", ref, reason: parseText(rawResolution.reason, LIMITS.reason, "resolved") }
    : { status: FALLBACK_CODE, reason: "resolved node missing ref" };
}
function validateRunnerOutcome(raw) {
  if (!isObject(raw)) return fallbackOutcome("result must be an object");
  const status = parseSet(raw.status, STEP_STATUSES, null, LIMITS.status);
  if (!status) return fallbackOutcome("status unsupported");
  const reason = raw.reason === undefined ? "" : parseText(raw.reason, LIMITS.reason, null);
  if (raw.reason !== undefined && reason === null) return fallbackOutcome("reason must be text");
  const result = parseResult(raw.result);
  if (!result.ok) return fallbackOutcome(result.reason);
  const effects = parseEffects(raw.effects);
  if (!effects.ok) return fallbackOutcome(effects.reason);
  if (status === "failed") {
    const parsedError = parseOutcomeError(raw.error);
    if (!parsedError.ok) return fallbackOutcome(parsedError.reason);
    return { status, reason, result: result.value, effects: effects.value, error: { code: parsedError.value } };
  }
  if (raw.error !== undefined) return fallbackOutcome("error is not allowed for non-failed outcomes");
  return { status, reason, result: result.value, effects: effects.value };
}
function parseOutcomeError(raw) {
  if (raw === undefined) return { ok: false, reason: "failed outcome requires error" };
  if (typeof raw === "string") {
    const value = parseText(raw, LIMITS.code, null);
    return value ? { ok: true, value } : { ok: false, reason: "error code must be text" };
  }
  if (!isObject(raw) || Object.keys(raw).length !== 1 || typeof raw.code !== "string") {
    return { ok: false, reason: "error must be string or object" };
  }
  const value = parseText(raw.code, LIMITS.code, null);
  return value ? { ok: true, value } : { ok: false, reason: "error code must be text" };
}
function parseResult(raw) {
  if (raw == null) return { ok: true, value: null };
  if (!isObject(raw)) return { ok: false, reason: "result must be an object" };
  const kind = parseText(raw.kind, LIMITS.status, null);
  if (!kind || !Object.hasOwn(RESULT_KIND_FIELDS, kind)) return { ok: false, reason: "result kind unsupported" };
  const allowedFields = RESULT_KIND_FIELDS[kind];
  for (const key of Object.keys(raw)) {
    if (!allowedFields.has(key)) return { ok: false, reason: `result contains unknown key '${key}'` };
  }
  if (!OBSERVATION_RESULT_KINDS.has(kind)) {
    return { ok: true, value: { kind } };
  }
  if (!Object.hasOwn(raw, "nodes")) return { ok: true, value: { kind } };
  if (!Array.isArray(raw.nodes)) return { ok: false, reason: "result.nodes must be an array" };
  if (raw.nodes.length > LIMITS.nodes) return { ok: false, reason: "result.nodes too long" };
  const nodes = [];
  for (let index = 0; index < raw.nodes.length; index += 1) {
    const entry = raw.nodes[index];
    if (!isObject(entry)) return { ok: false, reason: `result.nodes[${index}] must be an object` };
    const node = {};
    for (const key of ALLOWED_RESULT_NODE_FIELDS) {
      if (!Object.hasOwn(entry, key)) continue;
      const value = parseText(entry[key], RESULT_NODE_FIELD_LIMITS[key], undefined);
      if (value !== undefined) node[key] = value;
    }
    nodes.push(node);
  }
  return { ok: true, value: { kind, ...(nodes.length ? { nodes } : {}) } };
}
function parseEffects(raw) {
  if (raw === undefined) return { ok: true, value: [] };
  if (!Array.isArray(raw)) return { ok: false, reason: "result.effects must be an array" };
  if (raw.length > LIMITS.nodes) return { ok: false, reason: "result.effects too long" };
  const out = [];
  for (let index = 0; index < raw.length; index += 1) {
    const parsed = parseEffect(raw[index], index);
    if (!parsed.ok) return parsed;
    out.push(parsed.value);
  }
  return { ok: true, value: out };
}
function parseEffect(rawEffect, index) {
  if (!isObject(rawEffect)) return { ok: false, reason: `effects[${index}] must be an object` };
  for (const key of Object.keys(rawEffect)) {
    if (!ALLOWED_EFFECT_KEYS.has(key)) return { ok: false, reason: `effects[${index}] contains unknown key '${key}'` };
  }
  const origin = parseEffectOrigin(rawEffect.origin, `effects[${index}].origin`);
  if (!origin.ok) return origin;
  const type = rawEffect.type === undefined
    ? { ok: true, value: "http" }
    : ((rawType) => {
      if (rawType === null || !FORBID_EFFECT_TYPES.includes(rawType)) {
        return { ok: false, reason: `effects[${index}].type unsupported` };
      }
      return { ok: true, value: rawType };
    })(parseText(rawEffect.type, LIMITS.code, null));
  if (!type.ok) return type;
  const value = {
    origin: origin.value,
    type: type.value,
  };
  if (rawEffect.method !== undefined) {
    const method = parseText(rawEffect.method, LIMITS.method, null);
    if (!method || !FORBID_ACTION_METHODS.includes(method)) return { ok: false, reason: `effects[${index}].method unsupported` };
    value.method = method;
  }
  if (rawEffect.path !== undefined) {
    const parsedPath = parseEffectPath(rawEffect.path, `effects[${index}].path`);
    if (!parsedPath.ok) return parsedPath;
    value.path = parsedPath.value;
  }
  if (rawEffect.requestId !== undefined) {
    const requestId = parseText(rawEffect.requestId, LIMITS.requestId, null);
    if (!requestId) return { ok: false, reason: `effects[${index}].requestId must be text` };
    value.requestId = requestId;
  }
  return { ok: true, value };
}
function parseEffectOrigin(raw, label) {
  const value = parseText(raw, LIMITS.origin, null);
  if (!value) return { ok: false, reason: `${label} must be an HTTP(S) origin` };
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return { ok: false, reason: `${label} must be HTTP(S)` };
    if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
      return { ok: false, reason: `${label} must be a strict origin` };
    }
    return { ok: true, value: `${parsed.protocol}//${parsed.host}` };
  } catch {
    return { ok: false, reason: `${label} must be an HTTP(S) origin` };
  }
}
function parseEffectPath(raw, label) {
  try {
    return { ok: true, value: parseEvalPath(raw, label) };
  } catch (error) {
    return { ok: false, reason: error?.message ?? `${label} must be a path` };
  }
}
function checkForbidden(rules, effects) {
  if (!effects.length || !rules.length) return { violated: false, matchCount: 0 };
  let matchCount = 0;
  for (const effect of effects) {
    for (const rule of rules) {
      if (rule.origin !== effect.origin) continue;
      if (rule.type !== effect.type) continue;
      if (rule.method !== undefined && rule.method !== effect.method) continue;
      if (rule.path !== undefined && (effect.path == null || (effect.path !== rule.path && !effect.path.startsWith(`${rule.path}/`)))) continue;
      if (rule.requestId !== undefined && rule.requestId !== effect.requestId) continue;
      matchCount += 1;
    }
  }
  return { violated: matchCount > 0, matchCount };
}
function makeStepResult({ index, step, status, reason, passed, resolvedRef, forbidden, result, errorCode }) {
  return {
    index,
    tool: step.tool,
    expect: step.expect,
    status,
    reason,
    passed,
    resolvedRef,
    forbidden,
    ...(result ? { result } : {}),
    ...(errorCode ? { error: { code: errorCode } } : {}),
  };
}
function failStep(index, step, reason, status = FALLBACK_CODE) {
  return makeStepResult({
    index,
    step,
    status,
    reason,
    passed: false,
    forbidden: { violated: false, matchCount: 0 },
    errorCode: FALLBACK_CODE,
  });
}
function finalizeTask(task, steps, startedAt, finishedAt, setupFailure, teardownFailure) {
  const status = steps.every((entry) => entry.passed && !entry.forbidden?.violated) ? "passed" : "failed";
  const base = {
    taskId: task.id,
    fixture: task.fixture,
    startedAt: safeDate(startedAt),
    finishedAt: safeDate(finishedAt),
    durationMs: safeDuration(startedAt, finishedAt),
    status,
    steps,
  };
  if (setupFailure) return { ...base, status: "failed", error: appendCleanup(setupFailure, teardownFailure) };
  const firstFailure = steps.find((entry) => !entry.passed || entry.forbidden?.violated);
  if (!firstFailure) {
    return teardownFailure
      ? { ...base, status: "failed", error: appendCleanup({ code: "teardown_failed" }, teardownFailure) }
      : base;
  }
  const primaryCode = firstFailure.error?.code ?? (firstFailure.status === FALLBACK_CODE ? FALLBACK_CODE : "runner_contract_invalid");
  return { ...base, status: "failed", error: appendCleanup({ code: primaryCode }, teardownFailure) };
}
function appendCleanup(primary, teardownFailure) {
  if (!teardownFailure) return primary;
  return { ...primary, cleanup: { ...(primary.cleanup ?? {}), teardown: { code: teardownFailure.code } } };
}
function parseSet(raw, allowed, fallback = undefined, limit = LIMITS.text) {
  const value = parseText(raw, limit, fallback);
  return value && allowed.has(value) ? value : null;
}
function isObject(raw) {
  return raw && typeof raw === "object" && !Array.isArray(raw);
}
function parseText(raw, maxLength, fallback = undefined) {
  if (typeof raw !== "string") return fallback;
  const value = raw.trim();
  return !value || value.length > maxLength ? fallback : value;
}
function safeDate(value) {
  const parsed = new Date(value ?? Date.now());
  return Number.isNaN(parsed.valueOf()) ? new Date(0).toISOString() : parsed.toISOString();
}
function safeDuration(startedAt, finishedAt) {
  const started = Number(startedAt);
  const finished = Number(finishedAt);
  return Number.isFinite(started) && Number.isFinite(finished) ? Math.max(0, finished - started) : 0;
}
function hasTargetHint(value) {
  if (!value || typeof value !== "object") return false;
  for (const key of TARGET_HINT_KEYS) {
    if (value[key] !== undefined) return true;
  }
  return false;
}
export function fixtureResolveRef({ previousObservation, hint }) {
  if (hint === undefined || !isObject(hint)) {
    return { status: "runner_contract_invalid", reason: "hint must be an object" };
  }
  for (const key of Object.keys(hint)) {
    if (!TARGET_HINT_SET.has(key)) {
      return { status: "runner_contract_invalid", reason: "hint contains unknown key" };
    }
  }
  const normalizedHint = {};
  for (const key of TARGET_HINT_KEYS) {
    if (hint[key] === undefined) continue;
    const value = parseText(hint[key], TARGET_HINT_LIMITS[key], null);
    if (!value) {
      return { status: FALLBACK_CODE, reason: `${key} hint must be text` };
    }
    normalizedHint[key] = value;
  }
  if (!hasTargetHint(normalizedHint)) {
    return { status: "runner_contract_invalid", reason: "hint requires a target field" };
  }
  const nodes = previousObservation?.nodes;
  if (!Array.isArray(nodes) || !nodes.length) {
    return { status: "not_found", reason: "no previous observation" };
  }
  const matches = nodes.filter((entry) => isObject(entry) && hasTargetHint(entry) && targetMatch(entry, normalizedHint));
  if (!matches.length) return { status: "not_found", reason: "no match" };
  if (matches.length > 1) return { status: "ambiguous", reason: "multiple matches" };
  const ref = parseText(matches[0]?.ref, LIMITS.stepRef, null);
  if (!ref) return { status: FALLBACK_CODE, reason: "resolved node missing ref" };
  return { status: "resolved", ref, reason: "resolved" };
}
function targetMatch(node, hint) {
  return matchField("ref", node.ref, hint.ref)
    && matchField("role", node.role, hint.role)
    && matchField("name", node.name, hint.name)
    && matchField("label", node.label, hint.label)
    && matchField("text", node.text, hint.text)
    && matchField("placeholder", node.placeholder, hint.placeholder)
    && matchField("testId", node.testId, hint.testId)
    && matchField("selector", node.selector, hint.selector);
}
function matchField(field, value, expected) {
  if (expected === undefined) return true;
  const expectedValue = parseText(expected, TARGET_HINT_LIMITS[field], null);
  if (!expectedValue) return false;
  return parseText(value, TARGET_HINT_LIMITS[field], null) === expectedValue;
}
function makeFailure(code, error) {
  return { code, reason: parseText(error?.message, LIMITS.reason, code) };
}
function fallbackOutcome(reason) {
  return { status: FALLBACK_CODE, reason, result: null, effects: [], error: { code: FALLBACK_CODE } };
}
