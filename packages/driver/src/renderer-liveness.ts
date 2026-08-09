export type LivenessState =
  | "healthy"
  | "dialog_blocked"
  | "discarded"
  | "debugger_detached"
  | "target_gone"
  | "unresponsive"
  | "reconciling"
  | "terminal";

type LivenessFailureState = Exclude<LivenessState, "healthy" | "reconciling">;

const TRANSITIONS: Readonly<Record<LivenessState, ReadonlySet<LivenessState>>> = Object.freeze({
  healthy: transitionSet("dialog_blocked", "discarded", "debugger_detached", "target_gone", "unresponsive", "reconciling", "terminal"),
  dialog_blocked: transitionSet("healthy", "debugger_detached", "target_gone", "reconciling", "terminal"),
  discarded: transitionSet("reconciling", "target_gone", "terminal"),
  debugger_detached: transitionSet("reconciling", "target_gone", "terminal"),
  target_gone: transitionSet("terminal"),
  unresponsive: transitionSet("reconciling", "debugger_detached", "target_gone", "terminal"),
  reconciling: transitionSet("healthy", "dialog_blocked", "discarded", "debugger_detached", "target_gone", "unresponsive", "terminal"),
  terminal: transitionSet(),
});

const ERROR_CODES: Readonly<Record<LivenessFailureState, string>> = Object.freeze({
  dialog_blocked: "dialog_blocked",
  discarded: "discarded",
  debugger_detached: "debugger_conflict",
  target_gone: "target_gone",
  unresponsive: "renderer_unresponsive",
  terminal: "target_gone",
});

type LivenessFailure = Readonly<{
  status: LivenessFailureState;
  errorCode: string;
  detail?: string;
}>;

export type LivenessSnapshot = Readonly<{
  key: string;
  epoch: number;
  state: LivenessState;
  revision: number;
  detail?: string;
}>;

type FailureWaiter = (failure: LivenessFailure) => void;
type LivenessTarget = {
  key: string;
  epoch: number;
  state: LivenessState;
  detail: string | null;
  revision: number;
  waiters: Set<FailureWaiter>;
};

type RendererLivenessOptions = { maxTargets?: unknown; maxWaitersPerTarget?: unknown };

export class RendererLiveness {
  readonly maxTargets: number;
  readonly maxWaitersPerTarget: number;
  readonly targets = new Map<string, LivenessTarget>();

  constructor({ maxTargets = 64, maxWaitersPerTarget = 32 }: RendererLivenessOptions = {}) {
    this.maxTargets = positiveBound(maxTargets, 64);
    this.maxWaitersPerTarget = positiveBound(maxWaitersPerTarget, 32);
  }

  register(targetKey: unknown, epoch: unknown = 1): LivenessSnapshot {
    const key = normalizeTargetKey(targetKey);
    const normalizedEpoch = positiveEpoch(epoch);
    const existing = this.targets.get(key);
    if (existing && normalizedEpoch < existing.epoch) throw typedError("stale_target_epoch");
    if (!existing && this.targets.size >= this.maxTargets) throw typedError("liveness_target_limit");
    if (existing && normalizedEpoch === existing.epoch) return this.requiredSnapshot(key);
    if (existing) this.resolveWaiters(existing, "target_gone", "target_epoch_replaced");
    this.targets.set(key, { key, epoch: normalizedEpoch, state: "healthy", detail: null, revision: 1, waiters: new Set() });
    return this.requiredSnapshot(key);
  }

  transition(targetKey: unknown, nextState: string, { epoch, detail }: { epoch?: unknown; detail?: unknown } = {}): LivenessSnapshot {
    const key = normalizeTargetKey(targetKey);
    const target = this.targets.get(key);
    if (!target) throw typedError("unknown_liveness_target");
    if (epoch !== undefined && positiveEpoch(epoch) !== target.epoch) throw typedError("stale_target_epoch");
    if (!isLivenessState(nextState)) throw typedError("invalid_liveness_state");
    if (target.state === nextState) return this.requiredSnapshot(key);
    if (!TRANSITIONS[target.state].has(nextState)) throw typedError("invalid_liveness_transition");
    target.state = nextState;
    target.detail = boundedDetail(detail);
    target.revision += 1;
    if (isFailureState(nextState)) this.resolveWaiters(target, nextState, target.detail);
    return this.requiredSnapshot(key);
  }

  failureFor(targetKey: unknown, epoch?: unknown): Promise<LivenessFailure> {
    const key = normalizeTargetKey(targetKey);
    const target = this.targets.get(key);
    if (!target) return Promise.resolve(failureResult("target_gone", "unknown_target"));
    if (epoch !== undefined && positiveEpoch(epoch) !== target.epoch) {
      return Promise.resolve(failureResult("target_gone", "stale_target_epoch"));
    }
    if (isFailureState(target.state)) return Promise.resolve(failureResult(target.state, target.detail));
    if (target.waiters.size >= this.maxWaitersPerTarget) return Promise.resolve(failureResult("unresponsive", "liveness_waiter_limit"));
    return new Promise((resolve) => target.waiters.add(resolve));
  }

  snapshot(targetKey: unknown): LivenessSnapshot | null {
    const target = this.targets.get(normalizeTargetKey(targetKey));
    if (!target) return null;
    return Object.freeze({ key: target.key, epoch: target.epoch, state: target.state, revision: target.revision, ...(target.detail ? { detail: target.detail } : {}) });
  }

  remove(targetKey: unknown, detail: unknown = "target_removed"): boolean {
    const key = normalizeTargetKey(targetKey);
    const target = this.targets.get(key);
    if (!target) return false;
    this.resolveWaiters(target, "target_gone", boundedDetail(detail));
    this.targets.delete(key);
    return true;
  }

  private requiredSnapshot(key: string): LivenessSnapshot {
    const snapshot = this.snapshot(key);
    if (!snapshot) throw typedError("unknown_liveness_target");
    return snapshot;
  }

  private resolveWaiters(target: LivenessTarget, state: LivenessFailureState, detail: string | null): void {
    const result = failureResult(state, detail);
    for (const resolve of target.waiters) resolve(result);
    target.waiters.clear();
  }
}

function failureResult(state: LivenessFailureState, detail: string | null): LivenessFailure {
  return Object.freeze({ status: state, errorCode: ERROR_CODES[state], ...(detail ? { detail } : {}) });
}

function isLivenessState(value: string): value is LivenessState {
  return Object.hasOwn(TRANSITIONS, value);
}

function isFailureState(value: LivenessState): value is LivenessFailureState {
  return value !== "healthy" && value !== "reconciling";
}

function transitionSet(...states: LivenessState[]): ReadonlySet<LivenessState> {
  return new Set(states);
}

function normalizeTargetKey(value: unknown): string {
  const key = String(value ?? "").trim();
  if (!key || key.length > 160) throw typedError("invalid_liveness_target");
  return key;
}

function positiveEpoch(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw typedError("invalid_target_epoch");
  return Number(value);
}

function positiveBound(value: unknown, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

function boundedDetail(value: unknown): string | null {
  if (value == null) return null;
  return String(value).replace(/\s+/g, " ").trim().slice(0, 160) || null;
}

function typedError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
