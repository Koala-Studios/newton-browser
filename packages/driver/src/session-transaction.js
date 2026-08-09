const MAX_CLEANUP_FAILURE_REPORTS = 16;
const MAX_CLEANUP_FAILURE_MESSAGE_LENGTH = 180;
const MAX_CLEANUP_STEP_NAME_LENGTH = 80;
const MAX_CLEANUP_FAILURE_CODE_LENGTH = 120;
const MAX_DEDUPE_KEY_LENGTH = 128;

const DEFAULT_LIFECYCLE_STATES = Object.freeze([
  "creating_host",
  "creating_tab",
  "attaching_debugger",
  "verifying_origin",
  "publishing_ready",
  "active",
  "finalizing",
  "stopped",
]);

export {
  DEFAULT_LIFECYCLE_STATES,
  MAX_CLEANUP_FAILURE_REPORTS,
  MAX_CLEANUP_FAILURE_MESSAGE_LENGTH,
  MAX_CLEANUP_STEP_NAME_LENGTH,
  MAX_CLEANUP_FAILURE_CODE_LENGTH,
  MAX_DEDUPE_KEY_LENGTH,
};

function safeToString(value, fallback = "") {
  try {
    return String(value);
  } catch {
    return fallback;
  }
}

function safeRead(value, key, fallback = undefined) {
  try {
    return value?.[key];
  } catch {
    return fallback;
  }
}

function clampText(value, limit) {
  const text = safeToString(value, "");
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) {
    return text;
  }
  return text.length > limit ? `${text.slice(0, Math.max(0, limit - 1))}\u2026` : text;
}

function normalizeLifecycleStates(states) {
  if (!Array.isArray(states) || states.length === 0) {
    throw new TypeError("lifecycle states must be a non-empty array");
  }
  const seen = new Set();
  const normalized = [];
  for (const rawState of states) {
    const state = safeToString(rawState, "");
    if (!state) throw new TypeError("lifecycle state names must be non-empty");
    if (seen.has(state)) throw new TypeError(`duplicate lifecycle state: ${state}`);
    seen.add(state);
    normalized.push(state);
  }
  return normalized;
}

function normalizeLifecycleTransitions(states, transitions) {
  const transitionMap = new Map();
  const stateSet = new Set(states);
  if (transitions == null) {
    for (let index = 0; index + 1 < states.length; index += 1) {
      const current = states[index];
      const next = states[index + 1];
      transitionMap.set(current, [next]);
    }
    transitionMap.set(states[states.length - 1], []);
    return transitionMap;
  }

  if (typeof transitions !== "object" || transitions === null || Array.isArray(transitions)) {
    throw new TypeError("lifecycle.transitions must be an object");
  }

  for (const [source, targets] of Object.entries(transitions)) {
    const normalizedSource = safeToString(source, "");
    if (!stateSet.has(normalizedSource)) {
      throw new TypeError(`unknown lifecycle state in transition source: ${normalizedSource}`);
    }
    if (!Array.isArray(targets)) {
      throw new TypeError(`lifecycle transition list must be an array: ${normalizedSource}`);
    }
    const uniqueTargets = [];
    for (const target of targets) {
      const normalizedTarget = safeToString(target, "");
      if (!stateSet.has(normalizedTarget)) {
        throw new TypeError(`unknown lifecycle transition target: ${normalizedTarget}`);
      }
      if (!uniqueTargets.includes(normalizedTarget)) {
        uniqueTargets.push(normalizedTarget);
      }
    }
    transitionMap.set(normalizedSource, uniqueTargets);
  }

  for (const state of states) {
    if (!transitionMap.has(state)) {
      transitionMap.set(state, []);
    }
  }

  return transitionMap;
}

function makeLifecycleController(lifecycle) {
  const hasExplicitStates = Object.prototype.hasOwnProperty.call(lifecycle ?? {}, "states");
  const states = normalizeLifecycleStates(
    hasExplicitStates ? lifecycle?.states : DEFAULT_LIFECYCLE_STATES,
  );
  const transitions = normalizeLifecycleTransitions(states, lifecycle?.transitions);
  const initialState = lifecycle && Object.prototype.hasOwnProperty.call(lifecycle, "initialState")
    ? safeToString(lifecycle.initialState, "")
    : states[0];
  if (!states.includes(initialState)) {
    throw new TypeError(`unknown lifecycle initial state: ${initialState}`);
  }

  let currentState = initialState;

  const transition = (nextState) => {
    const normalizedNextState = safeToString(nextState, "");
    const allowedTargets = transitions.get(currentState) ?? [];
    if (!stateSetHas(states, normalizedNextState)) {
      throw new Error(`invalid_lifecycle_state: ${normalizedNextState}`);
    }
    if (normalizedNextState !== currentState && !allowedTargets.includes(normalizedNextState)) {
      throw new Error(`invalid_lifecycle_transition: ${currentState} -> ${normalizedNextState}`);
    }
    currentState = normalizedNextState;
    return currentState;
  };

  return {
    getState() {
      return currentState;
    },
    transition,
  };
}

function stateSetHas(states, state) {
  for (const known of states) {
    if (known === state) return true;
  }
  return false;
}

function normalizePrimaryError(error) {
  if (error instanceof Error) return error;
  if (error && typeof error === "object") {
    const rawMessage = safeRead(error, "message", safeToString(error, ""));
    const message = typeof rawMessage === "string"
      ? rawMessage
      : safeToString(rawMessage, "");
    const wrapper = new Error(message);
    const rawCode = safeRead(error, "code");
    if (
      typeof rawCode === "string"
      || typeof rawCode === "number"
      || typeof rawCode === "boolean"
      || typeof rawCode === "bigint"
    ) {
      wrapper.code = safeToString(rawCode, "");
    }
    return wrapper;
  }
  return new Error(safeToString(error, ""));
}

function normalizeCleanupCode(code) {
  if (
    typeof code === "string"
    || typeof code === "number"
    || typeof code === "boolean"
    || typeof code === "bigint"
  ) {
    return clampText(code, MAX_CLEANUP_FAILURE_CODE_LENGTH);
  }
  return undefined;
}

function normalizeFailureStepName(step) {
  const nameFromObject = step && typeof step === "object" ? safeRead(step, "name", undefined) : undefined;
  const stepNameSource = typeof nameFromObject === "undefined"
    ? step
    : nameFromObject;

  return clampText(
    safeToString(stepNameSource, "unnamed") || "unnamed",
    MAX_CLEANUP_STEP_NAME_LENGTH,
  );
}

function normalizeCleanupFailure(step, error) {
  const stepName = normalizeFailureStepName(step);
  if (error instanceof Error) {
    return {
      step: stepName,
      code: normalizeCleanupCode(safeRead(error, "code")),
      name: clampText(safeRead(error, "name", "Error") || "Error", MAX_CLEANUP_STEP_NAME_LENGTH),
      message: clampText(safeRead(error, "message", safeToString(error, "")), MAX_CLEANUP_FAILURE_MESSAGE_LENGTH),
    };
  }

  const messageValue = safeRead(error, "message", safeToString(error, ""));
  return {
    step: stepName,
    code: normalizeCleanupCode(safeRead(error, "code")),
    name: "Error",
    message: clampText(
      typeof messageValue === "string" ? messageValue : safeToString(messageValue, ""),
      MAX_CLEANUP_FAILURE_MESSAGE_LENGTH,
    ),
  };
}

function normalizeDedupeKey(value) {
  if (
    typeof value !== "string"
    && typeof value !== "number"
    && typeof value !== "boolean"
    && typeof value !== "bigint"
  ) {
    throw new TypeError("dedupeKey must be a non-empty scalar up to 128 characters");
  }

  const key = String(value);
  if (key.length === 0 || key.length > MAX_DEDUPE_KEY_LENGTH) {
    throw new TypeError("dedupeKey must be a non-empty scalar up to 128 characters");
  }

  return key;
}

async function rollbackAll(entries) {
  const failures = [];
  let attempted = 0;
  let completed = 0;
  for (const entry of [...entries].reverse()) {
    if (entry.executed) continue;
    entry.executed = true;
    attempted += 1;
    try {
      await Promise.resolve(entry.fn());
      completed += 1;
    } catch (failure) {
      failures.push(normalizeCleanupFailure(entry, failure));
    }
  }

  const totalFailures = failures.length;
  return {
    attempts: attempted,
    completed,
    failureCount: totalFailures,
    failures: failures.slice(0, MAX_CLEANUP_FAILURE_REPORTS),
    truncated: totalFailures > MAX_CLEANUP_FAILURE_REPORTS,
  };
}

export async function runSessionTransaction(work, options = {}) {
  if (typeof work !== "function") {
    throw new TypeError("work must be a function");
  }

  const lifecycle = options?.lifecycle ? makeLifecycleController(options.lifecycle) : null;
  const rollbacks = [];
  const dedupeKeys = new Set();
  let settled = false;
  let rollbackAttempted = false;
  let rollbackSummary = null;

  const registerCleanup = (name, fn, { dedupeKey } = {}) => {
    if (settled) throw new Error("session_transaction_settled");
    if (typeof fn !== "function") {
      throw new TypeError("cleanup handler must be a function");
    }
    if (typeof dedupeKey !== "undefined") {
      const key = normalizeDedupeKey(dedupeKey);
      if (dedupeKeys.has(key)) return false;
      dedupeKeys.add(key);
    }
    rollbacks.push({ name, fn, executed: false });
    return true;
  };

  const runRollback = async () => {
    if (rollbackAttempted) return rollbackSummary;
    rollbackAttempted = true;
    rollbackSummary = await rollbackAll(rollbacks);
    return rollbackSummary;
  };

  const context = {
    defer: registerCleanup,
  };
  if (lifecycle) {
    context.lifecycle = {
      getState: lifecycle.getState,
      transition: lifecycle.transition,
    };
  }

  try {
    const result = await Promise.resolve(work(context));
    settled = true;
    return result;
  } catch (error) {
    settled = true;
    const primary = normalizePrimaryError(error);
    const rollback = await runRollback();
    primary.cleanup = {
      attempts: rollback.attempts,
      completed: rollback.completed,
      failureCount: rollback.failureCount,
      failures: rollback.failures,
      truncated: rollback.truncated,
      total: rollback.attempts,
    };
    throw primary;
  }
}
