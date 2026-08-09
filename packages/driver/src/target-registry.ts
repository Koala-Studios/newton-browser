const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const IDENTIFIER_LIMIT = 128;
const ORIGIN_LIMIT = 512;
type TargetType = "page" | "iframe" | "worker";
type ErrorCode = typeof TARGET_REGISTRY_ERROR_CODES[keyof typeof TARGET_REGISTRY_ERROR_CODES];
type TargetInput = {
  targetId?: unknown;
  type?: unknown;
  parentTargetId?: unknown;
  hostFrameId?: unknown;
  sessionId?: unknown;
  origin?: unknown;
};
type FrameInput = {
  frameId?: unknown;
  targetId?: unknown;
  backendNodeId?: unknown;
  parentFrameId?: unknown;
  origin?: unknown;
};
type TargetRecord = {
  targetId: string;
  type: TargetType | null;
  parentTargetId: string | null;
  hostFrameId: string | null;
  sessionId: string | null;
  origin: string;
};
type FrameRecord = {
  frameId: string;
  targetId: string;
  backendNodeId: number | null;
  parentFrameId: string | null;
  origin: string;
  ordinal: number | null;
  generation: number;
};
type RefRoute = {
  documentEpoch: number;
  targetId: string;
  sessionId: string | null;
  frameId: string | null;
  frameOrdinal: number | null;
  frameGeneration: number | null;
  backendNodeId: number;
  origin: string;
};
type RegistryOptions = { maxTargets?: number; maxFrames?: number; maxRefs?: number };

const TARGET_TYPES = new Set<TargetType>(["page", "iframe", "worker"]);
const MAIN_REF = /^d([1-9]\d*):e([1-9]\d*)$/;
const FRAME_REF = /^d([1-9]\d*):f([1-9]\d*):e([1-9]\d*)$/;

export const TARGET_REGISTRY_ERROR_CODES = Object.freeze({
  DOCUMENT_NOT_COMMITTED: "document_not_committed",
  DOCUMENT_NOT_FOUND: "document_not_found",
  DOCUMENT_EPOCH_OVERFLOW: "document_epoch_overflow",
  FRAME_CONFLICT: "frame_conflict",
  FRAME_DETACHED: "frame_detached",
  INVALID_BACKEND_NODE: "invalid_backend_node",
  INVALID_REF: "invalid_ref",
  MAX_FRAMES_EXCEEDED: "max_frames_exceeded",
  MAX_REFS_EXCEEDED: "max_refs_exceeded",
  MAX_TARGETS_EXCEEDED: "max_targets_exceeded",
  NON_ACTIONABLE_TARGET: "non_actionable_target",
  SESSION_CONFLICT: "session_conflict",
  SESSION_DETACHED: "session_detached",
  STALE_TARGET: "stale_target",
  TARGET_CONFLICT: "target_conflict",
  TARGET_DETACHED: "target_detached",
  TARGET_NOT_FOUND: "target_not_found",
} as const);

export class TargetRegistryError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode) {
    super("target registry protocol error");
    this.name = "TargetRegistryError";
    this.code = code;
  }
}

function fail(code: ErrorCode): never {
  throw new TargetRegistryError(code);
}

function positiveInteger(value: unknown, code: ErrorCode): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) fail(code);
  return value;
}

function identifier(value: unknown, code: ErrorCode): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > IDENTIFIER_LIMIT
    || CONTROL_CHARS.test(value)
    || /\s/.test(value)
  ) fail(code);
  return value;
}

function optionalIdentifier(value: unknown, code: ErrorCode): string | null {
  return value === undefined || value === null ? null : identifier(value, code);
}

function origin(value: unknown, code: ErrorCode): string {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string" || value.length > ORIGIN_LIMIT || CONTROL_CHARS.test(value)) fail(code);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    fail(code);
  }
  if (
    !["http:", "https:"].includes(parsed.protocol)
    || parsed.username
    || parsed.password
    || parsed.pathname !== "/"
    || parsed.search
    || parsed.hash
  ) fail(code);
  return parsed.origin;
}

function immutable<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return Object.freeze(value.map(immutable)) as T;
  return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, immutable(item)]))) as T;
}

function mergeKnown<T extends string | null>(current: T, incoming: T, code: ErrorCode): T {
  if (incoming === null || incoming === "") return current;
  if (current === null || current === "") return incoming;
  if (current !== incoming) fail(code);
  return current;
}

export class TargetRegistry {
  readonly maxTargets: number;
  readonly maxFrames: number;
  readonly maxRefs: number;
  documentEpoch: number;
  mainTargetId: string | null;
  nextFrameOrdinal: number;
  readonly targets: Map<string, TargetRecord>;
  readonly pendingTargets: Map<string, TargetRecord>;
  readonly frames: Map<string, FrameRecord>;
  readonly pendingFrames: Map<string, FrameRecord>;
  readonly sessionToTarget: Map<string, string>;
  readonly detachedTargets: Set<string>;
  readonly detachedFrames: Set<string>;
  readonly refs: Map<string, RefRoute>;
  readonly deadRefs: Map<string, ErrorCode>;

  constructor({ maxTargets = 128, maxFrames = 256, maxRefs = 1024 }: RegistryOptions = {}) {
    this.maxTargets = positiveInteger(maxTargets, TARGET_REGISTRY_ERROR_CODES.MAX_TARGETS_EXCEEDED);
    this.maxFrames = positiveInteger(maxFrames, TARGET_REGISTRY_ERROR_CODES.MAX_FRAMES_EXCEEDED);
    this.maxRefs = positiveInteger(maxRefs, TARGET_REGISTRY_ERROR_CODES.MAX_REFS_EXCEEDED);
    this.documentEpoch = 0;
    this.mainTargetId = null;
    this.nextFrameOrdinal = 1;
    this.targets = new Map<string, TargetRecord>();
    this.pendingTargets = new Map<string, TargetRecord>();
    this.frames = new Map<string, FrameRecord>();
    this.pendingFrames = new Map<string, FrameRecord>();
    this.sessionToTarget = new Map<string, string>();
    this.detachedTargets = new Set<string>();
    this.detachedFrames = new Set<string>();
    this.refs = new Map<string, RefRoute>();
    this.deadRefs = new Map<string, ErrorCode>();
  }

  parseRef(value: unknown) {
    if (typeof value !== "string") fail(TARGET_REGISTRY_ERROR_CODES.INVALID_REF);
    const match = FRAME_REF.exec(value) || MAIN_REF.exec(value);
    if (!match) fail(TARGET_REGISTRY_ERROR_CODES.INVALID_REF);
    const numbers = match.slice(1).map((item) => positiveInteger(Number(item), TARGET_REGISTRY_ERROR_CODES.INVALID_REF));
    return match.length === 4
      ? { kind: "child", documentEpoch: numbers[0], frameOrdinal: numbers[1], backendNodeId: numbers[2] }
      : { kind: "main", documentEpoch: numbers[0], frameOrdinal: null, backendNodeId: numbers[1] };
  }

  registerTarget(input: TargetInput = {}) {
    const incoming = this.#targetInput(input);
    if (this.detachedTargets.has(incoming.targetId)) fail(TARGET_REGISTRY_ERROR_CODES.TARGET_CONFLICT);
    const existing = this.targets.get(incoming.targetId) || this.pendingTargets.get(incoming.targetId);
    const candidate = existing ? this.#mergeTarget(existing, incoming) : incoming;
    this.#assertTargetGraph(candidate);
    this.#assertSessionAvailable(candidate.sessionId, candidate.targetId);
    if (!existing) this.#reserveTarget();
    if (candidate.sessionId) this.#bindSession(candidate.sessionId, candidate.targetId);
    this.#storeTarget(candidate);
    this.#drain();
    return this.#publicTarget(candidate.targetId);
  }

  registerSession(targetId: string, sessionId: string) {
    targetId = identifier(targetId, TARGET_REGISTRY_ERROR_CODES.SESSION_CONFLICT);
    sessionId = identifier(sessionId, TARGET_REGISTRY_ERROR_CODES.SESSION_CONFLICT);
    if (this.detachedTargets.has(targetId)) fail(TARGET_REGISTRY_ERROR_CODES.SESSION_CONFLICT);
    const existing = this.targets.get(targetId) || this.pendingTargets.get(targetId);
    if (!existing) {
      this.#reserveTarget();
      this.#assertSessionAvailable(sessionId, targetId);
      this.#bindSession(sessionId, targetId);
      this.pendingTargets.set(targetId, this.#targetPlaceholder(targetId, sessionId));
      return this.#publicTarget(targetId);
    }
    if (existing.sessionId === sessionId) return this.#publicTarget(targetId);
    if (this.pendingTargets.has(targetId) && existing.sessionId !== null) {
      fail(TARGET_REGISTRY_ERROR_CODES.SESSION_CONFLICT);
    }
    this.#assertSessionAvailable(sessionId, targetId);
    if (this.targets.has(targetId)) return this.#replaceSession(existing, sessionId);
    if (existing.sessionId) this.sessionToTarget.delete(existing.sessionId);
    existing.sessionId = sessionId;
    this.#bindSession(sessionId, targetId);
    this.#drain();
    return this.#publicTarget(targetId);
  }

  registerFrame(input: FrameInput = {}) {
    const incoming = this.#frameInput(input);
    if (this.detachedFrames.has(incoming.frameId) || this.detachedTargets.has(incoming.targetId)) {
      fail(TARGET_REGISTRY_ERROR_CODES.FRAME_CONFLICT);
    }
    const existing = this.frames.get(incoming.frameId) || this.pendingFrames.get(incoming.frameId);
    const candidate = existing ? this.#mergeFrame(existing, incoming) : incoming;
    this.#assertFrameGraph(candidate);
    const targetExists = this.targets.has(candidate.targetId) || this.pendingTargets.has(candidate.targetId);
    if (!existing) this.#reserveFrame();
    if (!targetExists) {
      this.#reserveTarget();
      this.pendingTargets.set(candidate.targetId, this.#targetPlaceholder(candidate.targetId));
    }
    if (existing && this.frames.has(candidate.frameId) && this.#frameIdentityChanged(existing, candidate)) {
      this.#retireRefs((route) => route.frameId === candidate.frameId, TARGET_REGISTRY_ERROR_CODES.FRAME_DETACHED);
      candidate.generation = existing.generation + 1;
      candidate.ordinal = null;
    }
    this.#storeFrame(candidate);
    this.#drain();
    return this.#publicFrame(candidate.frameId);
  }

  targetForSession(sessionId: string) {
    sessionId = identifier(sessionId, TARGET_REGISTRY_ERROR_CODES.SESSION_CONFLICT);
    const targetId = this.sessionToTarget.get(sessionId);
    return targetId ? this.#publicTarget(targetId) : undefined;
  }

  listObservationRoutes() {
    const routes = [];
    const main = this.mainTargetId === null ? undefined : this.targets.get(this.mainTargetId);
    if (main) routes.push({ targetId: main.targetId, sessionId: main.sessionId, frameId: null, origin: main.origin });
    for (const frame of this.frames.values()) {
      const target = this.targets.get(frame.targetId);
      if (!target || target.type === "worker" || !this.#liveFrame(frame)) continue;
      routes.push({ targetId: target.targetId, sessionId: target.sessionId, frameId: frame.frameId, origin: frame.origin || target.origin });
    }
    return immutable(routes);
  }

  commitTopLevelDocument(targetId: string | null = this.mainTargetId, nextOrigin?: unknown) {
    if (targetId === null) fail(TARGET_REGISTRY_ERROR_CODES.DOCUMENT_NOT_FOUND);
    const target = this.targets.get(identifier(targetId, TARGET_REGISTRY_ERROR_CODES.TARGET_NOT_FOUND));
    if (!target) fail(TARGET_REGISTRY_ERROR_CODES.TARGET_NOT_FOUND);
    if (target.type !== "page" || target.parentTargetId !== null) {
      fail(TARGET_REGISTRY_ERROR_CODES.TARGET_CONFLICT);
    }
    if (nextOrigin !== undefined) target.origin = origin(nextOrigin, TARGET_REGISTRY_ERROR_CODES.TARGET_CONFLICT);
    this.#advanceDocumentEpoch();
    this.mainTargetId = targetId;
    this.#clearChildGraph(targetId);
    return this.#publicTarget(targetId);
  }

  createRef(targetId: string, backendNodeId: number, { frameId }: { frameId?: string } = {}) {
    targetId = identifier(targetId, TARGET_REGISTRY_ERROR_CODES.TARGET_NOT_FOUND);
    backendNodeId = positiveInteger(backendNodeId, TARGET_REGISTRY_ERROR_CODES.INVALID_BACKEND_NODE);
    if (this.documentEpoch === 0) fail(TARGET_REGISTRY_ERROR_CODES.DOCUMENT_NOT_COMMITTED);
    const target = this.targets.get(targetId);
    if (!target) fail(TARGET_REGISTRY_ERROR_CODES.TARGET_NOT_FOUND);
    if (target.type === "worker") fail(TARGET_REGISTRY_ERROR_CODES.NON_ACTIONABLE_TARGET);
    let frame = null;
    if (frameId !== undefined) {
      frameId = identifier(frameId, TARGET_REGISTRY_ERROR_CODES.FRAME_CONFLICT);
      frame = this.frames.get(frameId);
      if (!frame || frame.targetId !== targetId || !this.#liveFrame(frame)) {
        fail(TARGET_REGISTRY_ERROR_CODES.FRAME_DETACHED);
      }
    } else if (targetId !== this.mainTargetId) {
      fail(TARGET_REGISTRY_ERROR_CODES.FRAME_CONFLICT);
    }
    if (targetId !== this.mainTargetId && !target.sessionId) fail(TARGET_REGISTRY_ERROR_CODES.SESSION_DETACHED);
    const ref = frame
      ? `d${this.documentEpoch}:f${this.#frameOrdinal(frame)}:e${backendNodeId}`
      : `d${this.documentEpoch}:e${backendNodeId}`;
    const terminalReason = this.deadRefs.get(ref);
    if (terminalReason) fail(terminalReason);
    if (this.refs.has(ref)) return ref;
    if (this.refs.size + this.deadRefs.size >= this.maxRefs) fail(TARGET_REGISTRY_ERROR_CODES.MAX_REFS_EXCEEDED);
    this.refs.set(ref, {
      documentEpoch: this.documentEpoch,
      targetId,
      sessionId: target.sessionId,
      frameId: frame?.frameId ?? null,
      frameOrdinal: frame?.ordinal ?? null,
      frameGeneration: frame?.generation ?? null,
      backendNodeId,
      origin: frame?.origin || target.origin,
    });
    return ref;
  }

  resolveRef(ref: string) {
    const parsed = this.parseRef(ref);
    if (parsed.documentEpoch !== this.documentEpoch) fail(TARGET_REGISTRY_ERROR_CODES.STALE_TARGET);
    const route = this.refs.get(ref);
    if (!route) fail(this.deadRefs.get(ref) || TARGET_REGISTRY_ERROR_CODES.STALE_TARGET);
    const target = this.targets.get(route.targetId);
    if (!target) return this.#failRef(ref, TARGET_REGISTRY_ERROR_CODES.TARGET_DETACHED);
    if (target.sessionId !== route.sessionId) return this.#failRef(ref, TARGET_REGISTRY_ERROR_CODES.SESSION_DETACHED);
    if (route.frameId) {
      const frame = this.frames.get(route.frameId);
      if (
        !frame
        || frame.ordinal !== route.frameOrdinal
        || frame.generation !== route.frameGeneration
        || !this.#liveFrame(frame)
      ) return this.#failRef(ref, TARGET_REGISTRY_ERROR_CODES.FRAME_DETACHED);
    }
    return immutable({
      documentEpoch: route.documentEpoch,
      targetId: route.targetId,
      sessionId: target.sessionId,
      frameId: route.frameId,
      frameOrdinal: route.frameOrdinal,
      backendNodeId: route.backendNodeId,
      origin: route.origin,
    });
  }

  detachTarget(targetId: string): void {
    targetId = identifier(targetId, TARGET_REGISTRY_ERROR_CODES.TARGET_NOT_FOUND);
    if (this.detachedTargets.has(targetId)) return;
    const targets = this.#targetSubtree(targetId);
    if (targets.size === 0) {
      this.#reserveTarget();
      targets.add(targetId);
    }
    const frames = new Set([...this.frames.values()].filter((frame) => targets.has(frame.targetId)).map((frame) => frame.frameId));
    this.#retireRefs((route) => targets.has(route.targetId), TARGET_REGISTRY_ERROR_CODES.TARGET_DETACHED);
    for (const id of targets) this.#removeTarget(id, true);
    for (const frameId of frames) this.#removeFrame(frameId, true);
    this.#removePendingDescendants(targets, frames);
  }

  detachFrame(frameId: string): void {
    frameId = identifier(frameId, TARGET_REGISTRY_ERROR_CODES.FRAME_CONFLICT);
    if (this.detachedFrames.has(frameId)) return;
    const frames = this.#frameSubtree(frameId);
    if (frames.size === 0) {
      this.#reserveFrame();
      frames.add(frameId);
    }
    this.#retireRefs((route) => route.frameId !== null && frames.has(route.frameId), TARGET_REGISTRY_ERROR_CODES.FRAME_DETACHED);
    const hostedTargets = new Set(
      [...this.targets.values()].filter((target) => target.hostFrameId && frames.has(target.hostFrameId)).map((target) => target.targetId),
    );
    for (const id of frames) this.#removeFrame(id, true);
    for (const targetId of hostedTargets) this.detachTarget(targetId);
    this.#removePendingDescendants(new Set(), frames);
  }

  getSnapshot() {
    const origins = new Set<string>();
    const records = [
      ...this.targets.values(),
      ...this.pendingTargets.values(),
      ...this.frames.values(),
      ...this.pendingFrames.values(),
    ];
    for (const record of records) {
      if (record.origin) origins.add(record.origin);
    }
    return immutable({
      documentEpoch: this.documentEpoch,
      mainTargetId: this.mainTargetId,
      limits: { maxTargets: this.maxTargets, maxFrames: this.maxFrames, maxRefs: this.maxRefs },
      counts: {
        targets: { active: this.targets.size, waiting: this.pendingTargets.size, detached: this.detachedTargets.size },
        frames: { active: this.frames.size, waiting: this.pendingFrames.size, detached: this.detachedFrames.size },
        refs: { active: this.refs.size, terminal: this.deadRefs.size },
      },
      origins: [...origins].sort(),
    });
  }

  snapshot() {
    return this.getSnapshot();
  }

  #targetInput(input: TargetInput): TargetRecord {
    const code = TARGET_REGISTRY_ERROR_CODES.TARGET_CONFLICT;
    const targetId = identifier(input.targetId, code);
    const type = input.type === undefined ? null : input.type;
    if (type !== null && (typeof type !== "string" || !TARGET_TYPES.has(type as TargetType))) fail(code);
    const parentTargetId = optionalIdentifier(input.parentTargetId, code);
    const hostFrameId = optionalIdentifier(input.hostFrameId, code);
    if (type === "iframe" && (!parentTargetId || !hostFrameId)) fail(code);
    if (type !== "iframe" && hostFrameId) fail(code);
    if (type === "worker" && hostFrameId) fail(code);
    return {
      targetId,
      type: type as TargetType | null,
      parentTargetId,
      hostFrameId,
      sessionId: optionalIdentifier(input.sessionId, TARGET_REGISTRY_ERROR_CODES.SESSION_CONFLICT),
      origin: origin(input.origin, code),
    };
  }

  #frameInput(input: FrameInput): FrameRecord {
    const code = TARGET_REGISTRY_ERROR_CODES.FRAME_CONFLICT;
    const backendNodeId = input.backendNodeId === undefined || input.backendNodeId === null
      ? null
      : positiveInteger(input.backendNodeId, TARGET_REGISTRY_ERROR_CODES.INVALID_BACKEND_NODE);
    return {
      frameId: identifier(input.frameId, code),
      targetId: identifier(input.targetId, code),
      backendNodeId,
      parentFrameId: optionalIdentifier(input.parentFrameId, code),
      origin: origin(input.origin, code),
      ordinal: null,
      generation: 0,
    };
  }

  #targetPlaceholder(targetId: string, sessionId: string | null = null): TargetRecord {
    return { targetId, type: null, parentTargetId: null, hostFrameId: null, sessionId, origin: "" };
  }

  #mergeTarget(current: TargetRecord, next: TargetRecord): TargetRecord {
    const code = TARGET_REGISTRY_ERROR_CODES.TARGET_CONFLICT;
    return {
      targetId: current.targetId,
      type: mergeKnown(current.type, next.type, code),
      parentTargetId: mergeKnown(current.parentTargetId, next.parentTargetId, code),
      hostFrameId: mergeKnown(current.hostFrameId, next.hostFrameId, code),
      sessionId: mergeKnown(current.sessionId, next.sessionId, TARGET_REGISTRY_ERROR_CODES.SESSION_CONFLICT),
      origin: mergeKnown(current.origin, next.origin, code),
    };
  }

  #mergeFrame(current: FrameRecord, next: FrameRecord): FrameRecord {
    if (current.targetId !== next.targetId) fail(TARGET_REGISTRY_ERROR_CODES.FRAME_CONFLICT);
    return {
      ...current,
      backendNodeId: next.backendNodeId ?? current.backendNodeId,
      parentFrameId: mergeKnown(current.parentFrameId, next.parentFrameId, TARGET_REGISTRY_ERROR_CODES.FRAME_CONFLICT),
      origin: next.origin || current.origin,
    };
  }

  #frameIdentityChanged(current: FrameRecord, next: FrameRecord): boolean {
    return current.backendNodeId !== next.backendNodeId || current.parentFrameId !== next.parentFrameId || (next.origin !== "" && current.origin !== next.origin);
  }

  #assertTargetGraph(target: TargetRecord): void {
    if (target.parentTargetId === target.targetId) fail(TARGET_REGISTRY_ERROR_CODES.TARGET_CONFLICT);
    const seen = new Set([target.targetId]);
    let cursor = target.parentTargetId;
    while (cursor) {
      if (seen.has(cursor)) fail(TARGET_REGISTRY_ERROR_CODES.TARGET_CONFLICT);
      seen.add(cursor);
      cursor = (this.targets.get(cursor) || this.pendingTargets.get(cursor))?.parentTargetId ?? null;
    }
  }

  #assertFrameGraph(frame: FrameRecord): void {
    if (frame.parentFrameId === frame.frameId) fail(TARGET_REGISTRY_ERROR_CODES.FRAME_CONFLICT);
    const seen = new Set([frame.frameId]);
    let cursor = frame.parentFrameId;
    while (cursor) {
      if (seen.has(cursor)) fail(TARGET_REGISTRY_ERROR_CODES.FRAME_CONFLICT);
      seen.add(cursor);
      const parent = this.frames.get(cursor) || this.pendingFrames.get(cursor);
      if (parent && parent.targetId !== frame.targetId) fail(TARGET_REGISTRY_ERROR_CODES.FRAME_CONFLICT);
      cursor = parent?.parentFrameId ?? null;
    }
  }

  #assertSessionAvailable(sessionId: string | null, targetId: string): void {
    if (!sessionId) return;
    const owner = this.sessionToTarget.get(sessionId);
    if (owner && owner !== targetId) fail(TARGET_REGISTRY_ERROR_CODES.SESSION_CONFLICT);
  }

  #bindSession(sessionId: string, targetId: string): void {
    this.#assertSessionAvailable(sessionId, targetId);
    this.sessionToTarget.set(sessionId, targetId);
  }

  #reserveTarget() {
    if (this.targets.size + this.pendingTargets.size + this.detachedTargets.size >= this.maxTargets) {
      fail(TARGET_REGISTRY_ERROR_CODES.MAX_TARGETS_EXCEEDED);
    }
  }

  #reserveFrame() {
    if (this.frames.size + this.pendingFrames.size + this.detachedFrames.size >= this.maxFrames) {
      fail(TARGET_REGISTRY_ERROR_CODES.MAX_FRAMES_EXCEEDED);
    }
  }

  #storeTarget(target: TargetRecord): void {
    const map = this.#canActivateTarget(target) ? this.targets : this.pendingTargets;
    this.targets.delete(target.targetId);
    this.pendingTargets.delete(target.targetId);
    map.set(target.targetId, target);
  }

  #storeFrame(frame: FrameRecord): void {
    const map = this.#canActivateFrame(frame) ? this.frames : this.pendingFrames;
    this.frames.delete(frame.frameId);
    this.pendingFrames.delete(frame.frameId);
    map.set(frame.frameId, frame);
  }

  #canActivateTarget(target: TargetRecord): boolean {
    if (!target.type) return false;
    if (target.type !== "iframe") return !target.parentTargetId || this.targets.has(target.parentTargetId);
    return target.parentTargetId !== null && this.targets.has(target.parentTargetId);
  }

  #canActivateFrame(frame: FrameRecord): boolean {
    if (!this.targets.has(frame.targetId)) return false;
    if (!frame.parentFrameId) return true;
    const parent = this.frames.get(frame.parentFrameId);
    return Boolean(parent && parent.targetId === frame.targetId && this.#liveFrame(parent));
  }

  #drain() {
    let changed = true;
    while (changed) {
      changed = false;
      for (const target of [...this.pendingTargets.values()]) {
        if (!this.#canActivateTarget(target)) continue;
        this.pendingTargets.delete(target.targetId);
        this.targets.set(target.targetId, target);
        changed = true;
      }
      for (const frame of [...this.pendingFrames.values()]) {
        if (!this.#canActivateFrame(frame)) continue;
        this.pendingFrames.delete(frame.frameId);
        this.frames.set(frame.frameId, frame);
        changed = true;
      }
    }
  }

  #replaceSession(target: TargetRecord, sessionId: string) {
    this.#bindSession(sessionId, target.targetId);
    if (target.sessionId) this.sessionToTarget.delete(target.sessionId);
    target.sessionId = sessionId;
    if (target.targetId === this.mainTargetId) {
      this.#advanceDocumentEpoch();
      this.#clearChildGraph(target.targetId);
    } else {
      this.#retireRefs((route) => route.targetId === target.targetId, TARGET_REGISTRY_ERROR_CODES.SESSION_DETACHED);
      for (const frame of this.frames.values()) {
        if (frame.targetId === target.targetId) {
          frame.generation += 1;
          frame.ordinal = null;
        }
      }
    }
    return this.#publicTarget(target.targetId);
  }

  #advanceDocumentEpoch() {
    if (this.documentEpoch === Number.MAX_SAFE_INTEGER) fail(TARGET_REGISTRY_ERROR_CODES.DOCUMENT_EPOCH_OVERFLOW);
    this.documentEpoch += 1;
    this.nextFrameOrdinal = 1;
    this.refs.clear();
    this.deadRefs.clear();
  }

  #clearChildGraph(mainTargetId: string): void {
    for (const [targetId, target] of [...this.targets, ...this.pendingTargets]) {
      if (targetId === mainTargetId) continue;
      if (target.sessionId) this.sessionToTarget.delete(target.sessionId);
      this.targets.delete(targetId);
      this.pendingTargets.delete(targetId);
    }
    this.frames.clear();
    this.pendingFrames.clear();
    this.detachedTargets.clear();
    this.detachedFrames.clear();
  }

  #frameOrdinal(frame: FrameRecord): number {
    if (frame.ordinal !== null) return frame.ordinal;
    if (this.nextFrameOrdinal > Number.MAX_SAFE_INTEGER) fail(TARGET_REGISTRY_ERROR_CODES.DOCUMENT_EPOCH_OVERFLOW);
    frame.ordinal = this.nextFrameOrdinal++;
    return frame.ordinal;
  }

  #liveFrame(frame: FrameRecord): boolean {
    if (this.detachedFrames.has(frame.frameId) || !this.targets.has(frame.targetId)) return false;
    const seen = new Set([frame.frameId]);
    let cursor = frame.parentFrameId;
    while (cursor) {
      if (seen.has(cursor)) return false;
      seen.add(cursor);
      const parent = this.frames.get(cursor);
      if (!parent || parent.targetId !== frame.targetId) return false;
      cursor = parent.parentFrameId;
    }
    return true;
  }

  #retireRefs(predicate: (route: RefRoute) => boolean, reason: ErrorCode): void {
    for (const [ref, route] of [...this.refs]) {
      if (!predicate(route)) continue;
      this.refs.delete(ref);
      this.deadRefs.set(ref, reason);
    }
  }

  #failRef(ref: string, reason: ErrorCode): never {
    this.refs.delete(ref);
    this.deadRefs.set(ref, reason);
    fail(reason);
  }

  #targetSubtree(root: string): Set<string> {
    const result = new Set<string>();
    const queue = [root];
    while (queue.length) {
      const id = queue.shift()!;
      if (result.has(id) || (!this.targets.has(id) && !this.pendingTargets.has(id))) continue;
      result.add(id);
      for (const target of [...this.targets.values(), ...this.pendingTargets.values()]) {
        if (target.parentTargetId === id) queue.push(target.targetId);
      }
    }
    return result;
  }

  #frameSubtree(root: string): Set<string> {
    const result = new Set<string>();
    const queue = [root];
    while (queue.length) {
      const id = queue.shift()!;
      if (result.has(id) || (!this.frames.has(id) && !this.pendingFrames.has(id))) continue;
      result.add(id);
      for (const frame of [...this.frames.values(), ...this.pendingFrames.values()]) {
        if (frame.parentFrameId === id) queue.push(frame.frameId);
      }
    }
    return result;
  }

  #removeTarget(targetId: string, detached: boolean): void {
    const target = this.targets.get(targetId) || this.pendingTargets.get(targetId);
    if (target?.sessionId) this.sessionToTarget.delete(target.sessionId);
    this.targets.delete(targetId);
    this.pendingTargets.delete(targetId);
    if (detached) this.detachedTargets.add(targetId);
  }

  #removeFrame(frameId: string, detached: boolean): void {
    this.frames.delete(frameId);
    this.pendingFrames.delete(frameId);
    if (detached) this.detachedFrames.add(frameId);
  }

  #removePendingDescendants(targets: Set<string>, frames: Set<string>): void {
    for (const target of [...this.pendingTargets.values()]) {
      if (targets.has(target.targetId)
        || (target.parentTargetId !== null && targets.has(target.parentTargetId))
        || (target.hostFrameId !== null && frames.has(target.hostFrameId))) {
        this.#removeTarget(target.targetId, true);
      }
    }
    for (const frame of [...this.pendingFrames.values()]) {
      if (targets.has(frame.targetId) || frames.has(frame.frameId) || (frame.parentFrameId !== null && frames.has(frame.parentFrameId))) {
        this.#removeFrame(frame.frameId, true);
      }
    }
  }

  #publicTarget(targetId: string) {
    const target = this.targets.get(targetId) || this.pendingTargets.get(targetId);
    if (!target) return undefined;
    return immutable({ ...target, state: this.targets.has(targetId) ? "active" : "pending" });
  }

  #publicFrame(frameId: string) {
    const frame = this.frames.get(frameId) || this.pendingFrames.get(frameId);
    if (!frame) return undefined;
    const { ordinal: _ordinal, generation: _generation, ...publicFrame } = frame;
    return immutable({ ...publicFrame, state: this.frames.has(frameId) ? "active" : "pending" });
  }
}
