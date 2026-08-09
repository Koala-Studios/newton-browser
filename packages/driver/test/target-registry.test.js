import assert from "node:assert/strict";
import test from "node:test";

import {
  TARGET_REGISTRY_ERROR_CODES as CODES,
  TargetRegistry,
  TargetRegistryError,
} from "../dist/target-registry.js";

function throwsCode(work, code) {
  assert.throws(work, (error) => error instanceof TargetRegistryError && error.code === code);
}

function mainRegistry(options = {}) {
  const registry = new TargetRegistry(options);
  registry.registerTarget({ targetId: "main", type: "page", origin: "https://example.test" });
  registry.commitTopLevelDocument("main");
  return registry;
}

function addChild(registry, suffix = "") {
  const hostFrameId = `host${suffix}`;
  const targetId = `child${suffix}`;
  const rootFrameId = `root${suffix}`;
  registry.registerFrame({ frameId: hostFrameId, targetId: "main", backendNodeId: 10 });
  registry.registerTarget({
    targetId,
    type: "iframe",
    parentTargetId: "main",
    hostFrameId,
    origin: "https://child.test",
  });
  registry.registerSession(targetId, `session${suffix}`);
  registry.registerFrame({ frameId: rootFrameId, targetId, backendNodeId: 20 });
  return { hostFrameId, targetId, rootFrameId };
}

test("parseRef accepts only strict positive decimal composite refs", () => {
  const registry = new TargetRegistry();
  assert.deepEqual(registry.parseRef("d1:e7"), {
    kind: "main",
    documentEpoch: 1,
    frameOrdinal: null,
    backendNodeId: 7,
  });
  assert.deepEqual(registry.parseRef("d4:f19:e22"), {
    kind: "child",
    documentEpoch: 4,
    frameOrdinal: 19,
    backendNodeId: 22,
  });
  for (const value of ["d0:e1", "d1:e01", "d1:f0:e1", "d1:f1:e0", "d1:e1x", " d1:e1", 1]) {
    throwsCode(() => registry.parseRef(value), CODES.INVALID_REF);
  }
});

test("constructor limits are strict positive safe integers", () => {
  for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1"]) {
    throwsCode(() => new TargetRegistry({ maxTargets: value }), CODES.MAX_TARGETS_EXCEEDED);
  }
  throwsCode(() => new TargetRegistry({ maxFrames: 0 }), CODES.MAX_FRAMES_EXCEEDED);
  throwsCode(() => new TargetRegistry({ maxRefs: 0 }), CODES.MAX_REFS_EXCEEDED);
});

test("origins require exact canonical HTTP(S) origins", () => {
  const registry = new TargetRegistry();
  const target = registry.registerTarget({ targetId: "main", type: "page", origin: "HTTPS://EXAMPLE.TEST:443" });
  assert.equal(target.origin, "https://example.test");
  for (const value of ["ftp://example.test", "https://u:p@example.test", "https://example.test/path", "not a url"]) {
    throwsCode(
      () => new TargetRegistry().registerTarget({ targetId: "main", type: "page", origin: value }),
      CODES.TARGET_CONFLICT,
    );
  }
});

test("origin enrichment is allowed but known conflicts are atomic", () => {
  const registry = new TargetRegistry();
  registry.registerTarget({ targetId: "main", type: "page" });
  registry.registerTarget({ targetId: "main", type: "page", origin: "https://example.test" });
  const before = registry.getSnapshot();
  throwsCode(
    () => registry.registerTarget({ targetId: "main", type: "page", origin: "https://other.test" }),
    CODES.TARGET_CONFLICT,
  );
  assert.deepEqual(registry.getSnapshot(), before);
});

test("refs require a committed document and main routing survives commits", () => {
  const registry = new TargetRegistry();
  registry.registerTarget({ targetId: "main", type: "page", sessionId: "root-session" });
  throwsCode(() => registry.createRef("main", 1), CODES.DOCUMENT_NOT_COMMITTED);
  registry.commitTopLevelDocument("main");
  const first = registry.createRef("main", 1);
  assert.equal(registry.resolveRef(first).sessionId, "root-session");
  registry.commitTopLevelDocument("main");
  throwsCode(() => registry.resolveRef(first), CODES.STALE_TARGET);
  const second = registry.createRef("main", 1);
  assert.equal(registry.resolveRef(second).sessionId, "root-session");
  assert.notEqual(first, second);
});

test("top-level commit clears child graph and preserves the main target", () => {
  const registry = mainRegistry();
  const child = addChild(registry);
  const childRef = registry.createRef(child.targetId, 21, { frameId: child.rootFrameId });
  registry.commitTopLevelDocument("main");
  throwsCode(() => registry.resolveRef(childRef), CODES.STALE_TARGET);
  assert.deepEqual(registry.getSnapshot().counts.targets, { active: 1, waiting: 0, detached: 0 });
  assert.equal(registry.createRef("main", 1), "d2:e1");
});

test("same-process frames use collision-safe ordinals", () => {
  const registry = mainRegistry();
  registry.registerFrame({ frameId: "a", targetId: "main", backendNodeId: 1 });
  registry.registerFrame({ frameId: "b", targetId: "main", backendNodeId: 2 });
  const first = registry.createRef("main", 99, { frameId: "a" });
  const second = registry.createRef("main", 99, { frameId: "b" });
  assert.notEqual(first, second);
  assert.equal(registry.resolveRef(first).frameId, "a");
  assert.equal(registry.resolveRef(second).frameId, "b");
});

test("OOPIF refs require a live child session and route through it", () => {
  const registry = mainRegistry();
  registry.registerFrame({ frameId: "host", targetId: "main", backendNodeId: 10 });
  registry.registerTarget({
    targetId: "child",
    type: "iframe",
    parentTargetId: "main",
    hostFrameId: "host",
  });
  registry.registerFrame({ frameId: "root", targetId: "child", backendNodeId: 20 });
  throwsCode(() => registry.createRef("child", 21, { frameId: "root" }), CODES.SESSION_DETACHED);
  registry.registerSession("child", "child-session");
  const ref = registry.createRef("child", 21, { frameId: "root" });
  assert.equal(registry.resolveRef(ref).sessionId, "child-session");
});

test("out-of-order session, frame, and target events reconcile deterministically", () => {
  const registry = new TargetRegistry();
  registry.registerSession("child", "child-session");
  registry.registerFrame({ frameId: "root", targetId: "child", backendNodeId: 20 });
  registry.registerTarget({
    targetId: "child",
    type: "iframe",
    parentTargetId: "main",
    hostFrameId: "host",
  });
  registry.registerTarget({ targetId: "main", type: "page" });
  registry.registerFrame({ frameId: "host", targetId: "main", backendNodeId: 10 });
  assert.deepEqual(registry.getSnapshot().counts.targets, { active: 2, waiting: 0, detached: 0 });
  assert.deepEqual(registry.getSnapshot().counts.frames, { active: 2, waiting: 0, detached: 0 });
  registry.commitTopLevelDocument("main");
  assert.deepEqual(registry.getSnapshot().counts.targets, { active: 1, waiting: 0, detached: 0 });
  assert.deepEqual(registry.getSnapshot().counts.frames, { active: 0, waiting: 0, detached: 0 });
});

test("frame lifecycle can register before an owner backend node is known", () => {
  const registry = mainRegistry();
  const frame = registry.registerFrame({ frameId: "frame", targetId: "main", origin: "https://frame.test" });
  assert.equal(frame.backendNodeId, null);
  registry.registerFrame({ frameId: "frame", targetId: "main", backendNodeId: 9 });
  assert.equal(registry.createRef("main", 10, { frameId: "frame" }), "d1:f1:e10");
});

test("pending target and frame state obeys exact caps", () => {
  const targetRegistry = new TargetRegistry({ maxTargets: 1 });
  targetRegistry.registerSession("one", "s-one");
  throwsCode(() => targetRegistry.registerSession("two", "s-two"), CODES.MAX_TARGETS_EXCEEDED);

  const frameRegistry = mainRegistry({ maxFrames: 1 });
  frameRegistry.registerFrame({ frameId: "one", targetId: "main", backendNodeId: 1 });
  throwsCode(
    () => frameRegistry.registerFrame({ frameId: "two", targetId: "main", backendNodeId: 2 }),
    CODES.MAX_FRAMES_EXCEEDED,
  );
});

test("detach-before-attach fences target and frame identifiers", () => {
  const registry = new TargetRegistry({ maxTargets: 2, maxFrames: 2 });
  registry.detachTarget("late-target");
  registry.detachFrame("late-frame");
  throwsCode(
    () => registry.registerTarget({ targetId: "late-target", type: "page" }),
    CODES.TARGET_CONFLICT,
  );
  throwsCode(
    () => registry.registerFrame({ frameId: "late-frame", targetId: "other", backendNodeId: 1 }),
    CODES.FRAME_CONFLICT,
  );
  registry.detachTarget("exact-boundary");
  throwsCode(() => registry.detachTarget("overflow"), CODES.MAX_TARGETS_EXCEEDED);
});

test("detaching a child target preserves ancestor refs", () => {
  const registry = mainRegistry();
  const parentRef = registry.createRef("main", 1);
  const child = addChild(registry);
  const childRef = registry.createRef(child.targetId, 21, { frameId: child.rootFrameId });
  registry.detachTarget(child.targetId);
  assert.equal(registry.resolveRef(parentRef).targetId, "main");
  throwsCode(() => registry.resolveRef(childRef), CODES.TARGET_DETACHED);
});

test("frame detach retires frame refs without invalidating main refs", () => {
  const registry = mainRegistry();
  registry.registerFrame({ frameId: "frame", targetId: "main", backendNodeId: 2 });
  const mainRef = registry.createRef("main", 1);
  const frameRef = registry.createRef("main", 3, { frameId: "frame" });
  registry.detachFrame("frame");
  assert.equal(registry.resolveRef(mainRef).targetId, "main");
  throwsCode(() => registry.resolveRef(frameRef), CODES.FRAME_DETACHED);
});

test("main session replacement advances epoch and preserves routing", () => {
  const registry = mainRegistry();
  const oldRef = registry.createRef("main", 1);
  registry.registerSession("main", "replacement");
  throwsCode(() => registry.resolveRef(oldRef), CODES.STALE_TARGET);
  assert.equal(registry.getSnapshot().documentEpoch, 2);
  const route = registry.resolveRef(registry.createRef("main", 1));
  assert.equal(route.sessionId, "replacement");
});

test("child session replacement retires old routes and bumps frame identity", () => {
  const registry = mainRegistry();
  const child = addChild(registry);
  const oldRef = registry.createRef(child.targetId, 21, { frameId: child.rootFrameId });
  registry.registerSession(child.targetId, "replacement");
  throwsCode(() => registry.resolveRef(oldRef), CODES.SESSION_DETACHED);
  const newRef = registry.createRef(child.targetId, 21, { frameId: child.rootFrameId });
  assert.notEqual(newRef, oldRef);
  assert.equal(registry.resolveRef(newRef).sessionId, "replacement");
});

test("sessions have exactly one target owner and failures do not half-register", () => {
  const registry = new TargetRegistry();
  registry.registerSession("one", "shared");
  assert.equal(registry.targetForSession("shared").targetId, "one");
  const before = registry.getSnapshot();
  throwsCode(() => registry.registerSession("two", "shared"), CODES.SESSION_CONFLICT);
  assert.deepEqual(registry.getSnapshot(), before);
});

test("target and frame cycles are rejected without partial mutation", () => {
  const targets = new TargetRegistry();
  throwsCode(
    () => targets.registerTarget({ targetId: "self", type: "page", parentTargetId: "self" }),
    CODES.TARGET_CONFLICT,
  );
  const frames = mainRegistry();
  throwsCode(
    () => frames.registerFrame({ frameId: "self", targetId: "main", parentFrameId: "self", backendNodeId: 1 }),
    CODES.FRAME_CONFLICT,
  );
  assert.equal(frames.getSnapshot().counts.frames.active, 0);
});

test("frame identity or origin changes retire prior refs and publish the new route", () => {
  const registry = mainRegistry();
  registry.registerFrame({ frameId: "frame", targetId: "main", backendNodeId: 1, origin: "https://frame.test" });
  const ref = registry.createRef("main", 10, { frameId: "frame" });
  registry.registerFrame({ frameId: "frame", targetId: "main", backendNodeId: 1, origin: "https://other.test" });
  throwsCode(() => registry.resolveRef(ref), CODES.FRAME_DETACHED);
  assert.equal(registry.listObservationRoutes().find((route) => route.frameId === "frame").origin, "https://other.test");
  const navigatedRef = registry.createRef("main", 10, { frameId: "frame" });
  registry.registerFrame({ frameId: "frame", targetId: "main", backendNodeId: 2 });
  throwsCode(() => registry.resolveRef(navigatedRef), CODES.FRAME_DETACHED);
});

test("top-level navigation may replace the document origin", () => {
  const registry = mainRegistry();
  registry.commitTopLevelDocument("main", "https://next.test");
  assert.equal(registry.listObservationRoutes()[0].origin, "https://next.test");
  assert.equal(registry.createRef("main", 1), "d2:e1");
});

test("workers are tracked but never actionable", () => {
  const registry = mainRegistry();
  registry.registerTarget({ targetId: "worker", type: "worker", sessionId: "worker-session" });
  throwsCode(() => registry.createRef("worker", 1), CODES.NON_ACTIONABLE_TARGET);
  assert.equal(registry.getSnapshot().counts.targets.active, 2);
});

test("ref storage is exact, bounded, and cannot resurrect a retired ref", () => {
  const registry = mainRegistry({ maxRefs: 2 });
  assert.equal(registry.createRef("main", 1), "d1:e1");
  assert.equal(registry.createRef("main", 2), "d1:e2");
  throwsCode(() => registry.createRef("main", 3), CODES.MAX_REFS_EXCEEDED);

  const framed = mainRegistry({ maxRefs: 1 });
  framed.registerFrame({ frameId: "frame", targetId: "main", backendNodeId: 1 });
  const ref = framed.createRef("main", 2, { frameId: "frame" });
  framed.detachFrame("frame");
  throwsCode(() => framed.resolveRef(ref), CODES.FRAME_DETACHED);
  throwsCode(() => framed.createRef("main", 2), CODES.MAX_REFS_EXCEEDED);
});

test("snapshot exposes bounded immutable metadata only", () => {
  const registry = mainRegistry({ maxTargets: 4, maxFrames: 4, maxRefs: 4 });
  const popup = registry.registerTarget({
    targetId: "popup",
    type: "page",
    parentTargetId: "main",
    origin: "https://popup.test",
  });
  const snapshot = registry.getSnapshot();
  assert.equal(Object.isFrozen(popup), true);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.counts.targets), true);
  assert.deepEqual(snapshot.origins, ["https://example.test", "https://popup.test"]);
  assert.equal(JSON.stringify(snapshot).includes("backendNode"), false);
  assert.throws(() => { snapshot.counts.targets.active = 99; }, TypeError);
  assert.throws(() => { popup.origin = "https://mutated.test"; }, TypeError);
  throwsCode(() => registry.commitTopLevelDocument("popup"), CODES.TARGET_CONFLICT);
});
