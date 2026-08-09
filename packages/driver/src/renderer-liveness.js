// @ts-check

const FAILURE_STATES = new Set(["dialog_blocked", "discarded", "debugger_detached", "target_gone", "unresponsive", "terminal"]);
const TRANSITIONS = Object.freeze({
  healthy: new Set(["dialog_blocked", "discarded", "debugger_detached", "target_gone", "unresponsive", "reconciling", "terminal"]),
  dialog_blocked: new Set(["healthy", "debugger_detached", "target_gone", "reconciling", "terminal"]),
  discarded: new Set(["reconciling", "target_gone", "terminal"]),
  debugger_detached: new Set(["reconciling", "target_gone", "terminal"]),
  target_gone: new Set(["terminal"]),
  unresponsive: new Set(["reconciling", "debugger_detached", "target_gone", "terminal"]),
  reconciling: new Set(["healthy", "dialog_blocked", "discarded", "debugger_detached", "target_gone", "unresponsive", "terminal"]),
  terminal: new Set(),
});

const ERROR_CODES = Object.freeze({
  dialog_blocked: "dialog_blocked",
  discarded: "discarded",
  debugger_detached: "debugger_conflict",
  target_gone: "target_gone",
  unresponsive: "renderer_unresponsive",
  terminal: "target_gone",
});

export class RendererLiveness {
  constructor({ maxTargets = 64, maxWaitersPerTarget = 32 } = {}) {
    this.maxTargets = positiveBound(maxTargets, 64);
    this.maxWaitersPerTarget = positiveBound(maxWaitersPerTarget, 32);
    this.targets = new Map();
  }

  register(targetKey, epoch = 1) {
    const key = normalizeTargetKey(targetKey);
    const normalizedEpoch = positiveEpoch(epoch);
    const existing = this.targets.get(key);
    if (existing && normalizedEpoch < existing.epoch) throw typedError("stale_target_epoch");
    if (!existing && this.targets.size >= this.maxTargets) throw typedError("liveness_target_limit");
    if (existing && normalizedEpoch === existing.epoch) return this.snapshot(key);
    if (existing) this.resolveWaiters(existing, "target_gone", "target_epoch_replaced");
    this.targets.set(key, { key, epoch: normalizedEpoch, state: "healthy", detail: null, revision: 1, waiters: new Set() });
    return this.snapshot(key);
  }

  transition(targetKey, nextState, { epoch, detail } = {}) {
    const key = normalizeTargetKey(targetKey);
    const target = this.targets.get(key);
    if (!target) throw typedError("unknown_liveness_target");
    if (epoch !== undefined && positiveEpoch(epoch) !== target.epoch) throw typedError("stale_target_epoch");
    if (!Object.hasOwn(TRANSITIONS, nextState)) throw typedError("invalid_liveness_state");
    if (target.state === nextState) return this.snapshot(key);
    if (!TRANSITIONS[target.state].has(nextState)) throw typedError("invalid_liveness_transition");
    target.state = nextState;
    target.detail = boundedDetail(detail);
    target.revision += 1;
    if (FAILURE_STATES.has(nextState)) this.resolveWaiters(target, nextState, target.detail);
    return this.snapshot(key);
  }

  failureFor(targetKey, epoch) {
    const key = normalizeTargetKey(targetKey);
    const target = this.targets.get(key);
    if (!target) return Promise.resolve(failureResult("target_gone", "unknown_target"));
    if (epoch !== undefined && positiveEpoch(epoch) !== target.epoch) {
      return Promise.resolve(failureResult("target_gone", "stale_target_epoch"));
    }
    if (FAILURE_STATES.has(target.state)) return Promise.resolve(failureResult(target.state, target.detail));
    if (target.waiters.size >= this.maxWaitersPerTarget) return Promise.resolve(failureResult("unresponsive", "liveness_waiter_limit"));
    return new Promise((resolve) => target.waiters.add(resolve));
  }

  snapshot(targetKey) {
    const target = this.targets.get(normalizeTargetKey(targetKey));
    if (!target) return null;
    return Object.freeze({ key: target.key, epoch: target.epoch, state: target.state, revision: target.revision, ...(target.detail ? { detail: target.detail } : {}) });
  }

  remove(targetKey, detail = "target_removed") {
    const key = normalizeTargetKey(targetKey);
    const target = this.targets.get(key);
    if (!target) return false;
    this.resolveWaiters(target, "target_gone", boundedDetail(detail));
    this.targets.delete(key);
    return true;
  }

  resolveWaiters(target, state, detail) {
    const result = failureResult(state, detail);
    for (const resolve of target.waiters) resolve(result);
    target.waiters.clear();
  }
}

function failureResult(state, detail) {
  return Object.freeze({ status: state, errorCode: ERROR_CODES[state] ?? "renderer_unresponsive", ...(detail ? { detail } : {}) });
}

function normalizeTargetKey(value) {
  const key = String(value ?? "").trim();
  if (!key || key.length > 160) throw typedError("invalid_liveness_target");
  return key;
}

function positiveEpoch(value) {
  if (!Number.isSafeInteger(value) || value <= 0) throw typedError("invalid_target_epoch");
  return value;
}

function positiveBound(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function boundedDetail(value) {
  if (value == null) return null;
  return String(value).replace(/\s+/g, " ").trim().slice(0, 160) || null;
}

function typedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
