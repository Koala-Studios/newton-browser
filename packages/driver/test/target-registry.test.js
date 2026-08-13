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

test("blocked Document provenance enriches only an exact existing parent or child-session frame", () => {
  const parent = mainRegistry();
  parent.registerFrame({ frameId: "restricted", targetId: "main" });
  assert.equal(parent.recordBlockedFrameOrigin({
    frameId: "restricted",
    sourceTargetId: "main",
    sourceSessionId: null,
    origin: "https://denied.test",
  }), true);
  assert.equal(parent.listObservationRoutes().find((route) => route.frameId === "restricted")?.origin, "https://denied.test");

  const child = mainRegistry();
  child.registerTarget({
    targetId: "child", type: "iframe", parentTargetId: "main", hostFrameId: "host", sessionId: "child-session",
  });
  child.registerFrame({ frameId: "nested", targetId: "child" });
  assert.equal(child.recordBlockedFrameOrigin({
    frameId: "nested",
    sourceTargetId: "child",
    sourceSessionId: "child-session",
    origin: "https://nested-denied.test",
  }), true);
  assert.equal(child.listObservationRoutes().find((route) => route.frameId === "nested")?.origin, "https://nested-denied.test");
});

test("blocked Document provenance queues bounded metadata without creating a frame", () => {
  const registry = mainRegistry({ maxFrames: 1 });
  assert.equal(registry.recordBlockedFrameOrigin({
    frameId: "late-frame",
    sourceTargetId: "main",
    sourceSessionId: null,
    origin: "https://denied.test",
  }), true);
  assert.equal(registry.frameIdentity("late-frame"), null);
  assert.deepEqual(registry.getSnapshot().counts.frames, { active: 0, waiting: 1, detached: 0 });
  assert.equal(registry.recordBlockedFrameOrigin({
    frameId: "over-cap",
    sourceTargetId: "main",
    sourceSessionId: null,
    origin: "https://other.test",
  }), false);

  registry.registerFrame({ frameId: "late-frame", targetId: "main" });
  assert.equal(registry.listObservationRoutes().find((route) => route.frameId === "late-frame")?.origin, "https://denied.test");
  assert.deepEqual(registry.getSnapshot().counts.frames, { active: 1, waiting: 0, detached: 0 });
});

test("blocked Document provenance rejects conflicts, stale ownership, popup pages, and detached ids", () => {
  const registry = mainRegistry();
  registry.registerFrame({ frameId: "known", targetId: "main", origin: "https://known.test" });
  assert.equal(registry.recordBlockedFrameOrigin({
    frameId: "known", sourceTargetId: "main", sourceSessionId: null, origin: "https://denied.test",
  }), false);
  assert.equal(registry.listObservationRoutes().find((route) => route.frameId === "known")?.origin, "https://known.test");

  registry.registerTarget({
    targetId: "child", type: "iframe", parentTargetId: "main", hostFrameId: "host", sessionId: "child-session",
  });
  registry.registerFrame({ frameId: "child-frame", targetId: "child" });
  assert.equal(registry.recordBlockedFrameOrigin({
    frameId: "child-frame", sourceTargetId: "main", sourceSessionId: null, origin: "https://denied.test",
  }), false);
  assert.equal(registry.recordBlockedFrameOrigin({
    frameId: "child-frame", sourceTargetId: "child", sourceSessionId: "stale-session", origin: "https://denied.test",
  }), false);

  registry.registerTarget({ targetId: "popup", type: "page", parentTargetId: "main", sessionId: "popup-session" });
  assert.equal(registry.recordBlockedFrameOrigin({
    frameId: "popup-frame", sourceTargetId: "popup", sourceSessionId: "popup-session", origin: "https://popup.test",
  }), false);
  registry.detachFrame("removed");
  assert.equal(registry.recordBlockedFrameOrigin({
    frameId: "removed", sourceTargetId: "main", sourceSessionId: null, origin: "https://denied.test",
  }), false);
});

test("queued blocked provenance is fenced by session replacement, detach, and document commit", () => {
  const registry = mainRegistry();
  registry.registerTarget({
    targetId: "child", type: "iframe", parentTargetId: "main", hostFrameId: "host", sessionId: "old-session",
  });
  assert.equal(registry.recordBlockedFrameOrigin({
    frameId: "late-child", sourceTargetId: "child", sourceSessionId: "old-session", origin: "https://denied.test",
  }), true);
  registry.registerSession("child", "new-session");
  registry.registerFrame({ frameId: "late-child", targetId: "child" });
  assert.equal(registry.listObservationRoutes().find((route) => route.frameId === "late-child")?.origin, "");

  assert.equal(registry.recordBlockedFrameOrigin({
    frameId: "removed", sourceTargetId: "main", sourceSessionId: null, origin: "https://removed.test",
  }), true);
  registry.detachFrame("removed");
  assert.equal(registry.getSnapshot().counts.frames.waiting, 0);

  assert.equal(registry.recordBlockedFrameOrigin({
    frameId: "next-document", sourceTargetId: "main", sourceSessionId: null, origin: "https://next.test",
  }), true);
  registry.commitTopLevelDocument("main");
  assert.equal(registry.getSnapshot().counts.frames.waiting, 0);
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

test("iframe owner routes are exact, bounded, and ordered outer-to-inner", () => {
  const registry = mainRegistry();
  registry.registerTarget({
    targetId: "child",
    type: "iframe",
    parentTargetId: "main",
    hostFrameId: "outer-frame",
    sessionId: "child-session",
  });
  registry.registerTarget({
    targetId: "nested",
    type: "iframe",
    parentTargetId: "child",
    hostFrameId: "inner-frame",
    sessionId: "nested-session",
  });

  assert.deepEqual(registry.iframeOwnerRoutes("nested"), [
    { targetId: "main", sessionId: null, frameId: "outer-frame" },
    { targetId: "child", sessionId: "child-session", frameId: "inner-frame" },
  ]);
  assert.equal(Object.isFrozen(registry.iframeOwnerRoutes("nested")), true);
  assert.deepEqual(registry.iframeOwnerRoutes("child"), [
    { targetId: "main", sessionId: null, frameId: "outer-frame" },
  ]);
  assert.deepEqual(registry.iframeOwnerRoutes("main"), []);

  registry.registerTarget({
    targetId: "ambiguous",
    type: "iframe",
    parentTargetId: "main",
    hostFrameId: "outer-frame",
    sessionId: "ambiguous-session",
  });
  throwsCode(() => registry.iframeOwnerRoutes("child"), CODES.FRAME_CONFLICT);

  registry.detachTarget("child");
  throwsCode(() => registry.iframeOwnerRoutes("nested"), CODES.TARGET_NOT_FOUND);
});

test("same-process frame owner routes are exact, sessionless, and ordered outer-to-inner", () => {
  const registry = mainRegistry();
  registry.registerFrame({ frameId: "outer", targetId: "main", backendNodeId: 10 });
  registry.registerFrame({ frameId: "inner", targetId: "main", parentFrameId: "outer", backendNodeId: 20 });

  assert.deepEqual(registry.frameOwnerRoutes("outer"), [
    { targetId: "main", sessionId: null, frameId: "outer" },
  ]);
  assert.deepEqual(registry.frameOwnerRoutes("inner"), [
    { targetId: "main", sessionId: null, frameId: "outer" },
    { targetId: "main", sessionId: null, frameId: "inner" },
  ]);
  assert.equal(Object.isFrozen(registry.frameOwnerRoutes("inner")), true);

  registry.detachFrame("outer");
  throwsCode(() => registry.frameOwnerRoutes("inner"), CODES.FRAME_DETACHED);

  const pending = mainRegistry();
  pending.registerFrame({ frameId: "waiting", targetId: "missing", parentFrameId: "unknown" });
  throwsCode(() => pending.frameOwnerRoutes("waiting"), CODES.FRAME_DETACHED);

  const mismatched = mainRegistry();
  mismatched.registerTarget({ targetId: "other", type: "page" });
  mismatched.registerFrame({ frameId: "parent", targetId: "main" });
  mismatched.registerFrame({ frameId: "child", targetId: "main", parentFrameId: "parent" });
  mismatched.frames.get("parent").targetId = "other";
  throwsCode(() => mismatched.frameOwnerRoutes("child"), CODES.FRAME_CONFLICT);

  const cyclic = mainRegistry();
  cyclic.registerFrame({ frameId: "parent", targetId: "main" });
  cyclic.registerFrame({ frameId: "child", targetId: "main", parentFrameId: "parent" });
  cyclic.frames.get("parent").parentFrameId = "child";
  throwsCode(() => cyclic.frameOwnerRoutes("child"), CODES.FRAME_CONFLICT);
});

test("combined owner routes preserve same-process ancestry across nested OOPIF boundaries", () => {
  const registry = mainRegistry();
  registry.registerFrame({ frameId: "outer-same", targetId: "main" });
  registry.registerFrame({ frameId: "child-host", targetId: "main", parentFrameId: "outer-same" });
  registry.registerTarget({
    targetId: "child-host",
    type: "iframe",
    parentTargetId: "main",
    hostFrameId: "child-host",
    sessionId: "child-session",
  });
  registry.reconcileOopifFrame({ frameId: "child-host", targetId: "child-host" });
  registry.registerFrame({ frameId: "child-same", targetId: "child-host", parentFrameId: "child-host" });
  registry.registerFrame({ frameId: "nested-host", targetId: "child-host", parentFrameId: "child-same" });
  registry.registerTarget({
    targetId: "nested-host",
    type: "iframe",
    parentTargetId: "child-host",
    hostFrameId: "nested-host",
    sessionId: "nested-session",
  });
  registry.reconcileOopifFrame({ frameId: "nested-host", targetId: "nested-host" });
  registry.registerFrame({ frameId: "nested-same", targetId: "nested-host", parentFrameId: "nested-host" });

  assert.deepEqual(registry.embeddingOwnerRoutes("child-host", "child-same"), [
    { targetId: "main", sessionId: null, frameId: "outer-same" },
    { targetId: "main", sessionId: null, frameId: "child-host" },
    { targetId: "child-host", sessionId: "child-session", frameId: "child-same" },
  ]);
  assert.deepEqual(registry.embeddingOwnerRoutes("nested-host", "nested-same"), [
    { targetId: "main", sessionId: null, frameId: "outer-same" },
    { targetId: "main", sessionId: null, frameId: "child-host" },
    { targetId: "child-host", sessionId: "child-session", frameId: "child-same" },
    { targetId: "child-host", sessionId: "child-session", frameId: "nested-host" },
    { targetId: "nested-host", sessionId: "nested-session", frameId: "nested-same" },
  ]);
  registry.detachFrame("child-same");
  throwsCode(() => registry.embeddingOwnerRoutes("nested-host", "nested-same"), CODES.FRAME_CONFLICT);
});

test("OOPIF boundary reconciliation adopts a parent-first frame and fences its prior refs", () => {
  const registry = mainRegistry();
  registry.registerFrame({ frameId: "main-frame", targetId: "main", backendNodeId: 1 });
  registry.registerFrame({
    frameId: "oopif",
    targetId: "main",
    parentFrameId: "main-frame",
    backendNodeId: 2,
  });
  const oldRef = registry.createRef("main", 3, { frameId: "oopif" });
  registry.registerTarget({
    targetId: "oopif",
    type: "iframe",
    parentTargetId: "main",
    hostFrameId: "oopif",
  });
  registry.registerSession("oopif", "oopif-session");

  const frame = registry.reconcileOopifFrame({
    frameId: "oopif",
    targetId: "oopif",
    backendNodeId: 4,
  });

  assert.equal(frame.targetId, "oopif");
  assert.equal(frame.parentFrameId, null);
  throwsCode(() => registry.resolveRef(oldRef), CODES.FRAME_DETACHED);
  const newRef = registry.createRef("oopif", 3, { frameId: "oopif" });
  assert.notEqual(newRef, oldRef);
  assert.equal(registry.resolveRef(newRef).sessionId, "oopif-session");
});

test("OOPIF boundary reconciliation keeps child ownership when the parent observation arrives second", () => {
  const registry = mainRegistry();
  registry.registerFrame({ frameId: "main-frame", targetId: "main", backendNodeId: 1 });
  registry.registerTarget({
    targetId: "oopif",
    type: "iframe",
    parentTargetId: "main",
    hostFrameId: "oopif",
    sessionId: "oopif-session",
  });
  registry.reconcileOopifFrame({ frameId: "oopif", targetId: "oopif", backendNodeId: 2 });
  const ref = registry.createRef("oopif", 3, { frameId: "oopif" });

  const frame = registry.reconcileOopifFrame({
    frameId: "oopif",
    targetId: "main",
    parentFrameId: "main-frame",
    backendNodeId: 4,
  });

  assert.equal(frame.targetId, "oopif");
  assert.equal(registry.resolveRef(ref).targetId, "oopif");
  throwsCode(
    () => registry.registerFrame({ frameId: "oopif", targetId: "main", parentFrameId: "main-frame" }),
    CODES.FRAME_CONFLICT,
  );
});

test("frame swap reconciliation permits one exact OOPIF adoption and keeps old refs fenced", () => {
  const registry = mainRegistry();
  registry.registerFrame({ frameId: "oopif", targetId: "main", backendNodeId: 2 });
  const oldRef = registry.createRef("main", 3, { frameId: "oopif" });
  registry.beginFrameSwap("oopif", "main");
  throwsCode(() => registry.resolveRef(oldRef), CODES.FRAME_DETACHED);
  throwsCode(
    () => registry.registerFrame({ frameId: "oopif", targetId: "main", backendNodeId: 4 }),
    CODES.FRAME_CONFLICT,
  );
  registry.registerTarget({
    targetId: "oopif",
    type: "iframe",
    parentTargetId: "main",
    hostFrameId: "oopif",
    sessionId: "oopif-session",
  });

  registry.reconcileOopifFrame({ frameId: "oopif", targetId: "oopif", backendNodeId: 4 });

  const newRef = registry.createRef("oopif", 3, { frameId: "oopif" });
  assert.notEqual(newRef, oldRef);
  assert.equal(registry.resolveRef(newRef).sessionId, "oopif-session");
  const duplicate = registry.reconcileOopifFrame({ frameId: "oopif", targetId: "main", backendNodeId: 5 });
  assert.equal(duplicate.targetId, "oopif");
  registry.beginFrameSwap("oopif", "main");
  assert.equal(registry.resolveRef(newRef).targetId, "oopif");
});

test("an unknown swap is a no-op and does not mislabel the frame as terminally detached", () => {
  const registry = mainRegistry();
  registry.beginFrameSwap("oopif", "main");
  assert.deepEqual(registry.getSnapshot().counts.frames, { active: 0, waiting: 0, detached: 0 });
  registry.registerTarget({
    targetId: "oopif",
    type: "iframe",
    parentTargetId: "main",
    hostFrameId: "oopif",
    sessionId: "oopif-session",
  });
  registry.reconcileOopifFrame({ frameId: "oopif", targetId: "oopif", backendNodeId: 1 });
  assert.equal(registry.createRef("oopif", 2, { frameId: "oopif" }), "d1:f1:e2");
});

test("an active child OOPIF can swap, detach its old target session, and reattach with the same identity", () => {
  const registry = mainRegistry({ maxTargets: 2, maxFrames: 1 });
  registry.registerTarget({
    targetId: "oopif",
    type: "iframe",
    parentTargetId: "main",
    hostFrameId: "oopif",
    sessionId: "old-session",
  });
  registry.reconcileOopifFrame({ frameId: "oopif", targetId: "oopif", backendNodeId: 1 });
  const oldRef = registry.createRef("oopif", 2, { frameId: "oopif" });

  registry.beginFrameSwap("oopif", "oopif");
  assert.equal(registry.targetForSession("old-session"), undefined);
  assert.deepEqual(registry.getSnapshot().counts.targets, { active: 1, waiting: 0, detached: 1 });
  assert.deepEqual(registry.getSnapshot().counts.frames, { active: 0, waiting: 0, detached: 1 });
  throwsCode(
    () => registry.registerTarget({ targetId: "overflow", type: "page", parentTargetId: "main" }),
    CODES.MAX_TARGETS_EXCEEDED,
  );
  throwsCode(
    () => registry.registerFrame({ frameId: "overflow", targetId: "main", backendNodeId: 3 }),
    CODES.MAX_FRAMES_EXCEEDED,
  );

  registry.detachTarget("oopif");
  registry.registerTarget({
    targetId: "oopif",
    type: "iframe",
    parentTargetId: "main",
    hostFrameId: "oopif",
    sessionId: "new-session",
  });
  registry.reconcileOopifFrame({ frameId: "oopif", targetId: "oopif", backendNodeId: 4 });

  throwsCode(() => registry.resolveRef(oldRef), CODES.FRAME_DETACHED);
  const newRef = registry.createRef("oopif", 2, { frameId: "oopif" });
  assert.notEqual(newRef, oldRef);
  assert.equal(registry.resolveRef(newRef).sessionId, "new-session");
});

test("a normal frame removal terminalizes an active swap exactly once", () => {
  const registry = mainRegistry({ maxTargets: 2, maxFrames: 1 });
  registry.registerTarget({
    targetId: "oopif",
    type: "iframe",
    parentTargetId: "main",
    hostFrameId: "oopif",
    sessionId: "old-session",
  });
  registry.reconcileOopifFrame({ frameId: "oopif", targetId: "oopif", backendNodeId: 1 });
  const oldRef = registry.createRef("oopif", 2, { frameId: "oopif" });

  registry.beginFrameSwap("oopif", "oopif");
  registry.detachFrame("oopif");
  registry.detachFrame("oopif");

  throwsCode(() => registry.resolveRef(oldRef), CODES.FRAME_DETACHED);
  assert.deepEqual(registry.getSnapshot().counts.targets, { active: 1, waiting: 0, detached: 1 });
  assert.deepEqual(registry.getSnapshot().counts.frames, { active: 0, waiting: 0, detached: 1 });
  throwsCode(
    () => registry.registerTarget({
      targetId: "oopif",
      type: "iframe",
      parentTargetId: "main",
      hostFrameId: "oopif",
      sessionId: "new-session",
    }),
    CODES.TARGET_CONFLICT,
  );
  throwsCode(
    () => registry.reconcileOopifFrame({ frameId: "oopif", targetId: "oopif", backendNodeId: 3 }),
    CODES.FRAME_CONFLICT,
  );
});

test("exact swap reattachment updates origin and ignores stale old-session detach", () => {
  const registry = mainRegistry();
  registry.registerTarget({
    targetId: "oopif",
    type: "iframe",
    parentTargetId: "main",
    hostFrameId: "oopif",
    sessionId: "old-session",
    origin: "https://old.test",
  });
  registry.reconcileOopifFrame({
    frameId: "oopif",
    targetId: "oopif",
    backendNodeId: 1,
    origin: "https://old.test",
  });
  registry.beginFrameSwap("oopif", "oopif");
  throwsCode(
    () => registry.registerTarget({
      targetId: "oopif",
      type: "iframe",
      parentTargetId: "main",
      hostFrameId: "oopif",
      sessionId: "old-session",
      origin: "https://new.test",
    }),
    CODES.SESSION_CONFLICT,
  );
  assert.equal(registry.targetForSession("old-session"), undefined);
  assert.deepEqual(registry.getSnapshot().counts.targets, { active: 1, waiting: 0, detached: 1 });
  registry.registerTarget({
    targetId: "oopif",
    type: "iframe",
    parentTargetId: "main",
    hostFrameId: "oopif",
    sessionId: "new-session",
    origin: "https://new.test",
  });
  registry.detachTarget("oopif", "old-session");
  registry.reconcileOopifFrame({
    frameId: "oopif",
    targetId: "oopif",
    backendNodeId: 2,
    origin: "https://new.test",
  });
  registry.detachTarget("oopif", "old-session");

  const ref = registry.createRef("oopif", 3, { frameId: "oopif" });
  const route = registry.resolveRef(ref);
  assert.equal(route.sessionId, "new-session");
  assert.equal(route.origin, "https://new.test");
});

test("a pending hosted target subtree is suspended nonterminally across swap", () => {
  const registry = mainRegistry({ maxTargets: 3, maxFrames: 1 });
  registry.registerFrame({ frameId: "oopif", targetId: "parent", backendNodeId: 1 });
  registry.registerTarget({
    targetId: "oopif",
    type: "iframe",
    parentTargetId: "parent",
    hostFrameId: "oopif",
    sessionId: "old-session",
    origin: "https://old.test",
  });
  registry.beginFrameSwap("oopif", "parent");

  assert.equal(registry.targetForSession("old-session"), undefined);
  assert.deepEqual(registry.getSnapshot().counts.targets, { active: 1, waiting: 1, detached: 1 });
  assert.deepEqual(registry.getSnapshot().counts.frames, { active: 0, waiting: 0, detached: 1 });

  registry.registerTarget({
    targetId: "parent",
    type: "iframe",
    parentTargetId: "main",
    hostFrameId: "parent-host",
    origin: "https://parent.test",
  });
  registry.registerTarget({
    targetId: "oopif",
    type: "iframe",
    parentTargetId: "parent",
    hostFrameId: "oopif",
    sessionId: "new-session",
    origin: "https://new.test",
  });
  registry.reconcileOopifFrame({
    frameId: "oopif",
    targetId: "oopif",
    backendNodeId: 2,
    origin: "https://new.test",
  });
  assert.equal(registry.resolveRef(registry.createRef("oopif", 3, { frameId: "oopif" })).sessionId, "new-session");
});

test("frame swap reconciliation rejects terminal, unrelated, and over-cap resurrection", () => {
  const removed = mainRegistry();
  removed.registerFrame({ frameId: "oopif", targetId: "main", backendNodeId: 1 });
  removed.detachFrame("oopif");
  removed.registerTarget({
    targetId: "oopif",
    type: "iframe",
    parentTargetId: "main",
    hostFrameId: "oopif",
  });
  throwsCode(
    () => removed.reconcileOopifFrame({ frameId: "oopif", targetId: "oopif", backendNodeId: 2 }),
    CODES.FRAME_CONFLICT,
  );

  const unrelated = mainRegistry();
  unrelated.registerTarget({ targetId: "other", type: "page", parentTargetId: "main" });
  unrelated.registerFrame({ frameId: "oopif", targetId: "main", backendNodeId: 1 });
  const stableRef = unrelated.createRef("main", 2, { frameId: "oopif" });
  throwsCode(() => unrelated.beginFrameSwap("oopif", "other"), CODES.FRAME_CONFLICT);
  assert.equal(unrelated.resolveRef(stableRef).targetId, "main");
  unrelated.beginFrameSwap("oopif", "main");
  unrelated.registerTarget({
    targetId: "oopif",
    type: "iframe",
    parentTargetId: "other",
    hostFrameId: "oopif",
  });
  throwsCode(
    () => unrelated.reconcileOopifFrame({ frameId: "oopif", targetId: "oopif", backendNodeId: 2 }),
    CODES.FRAME_CONFLICT,
  );

  const bounded = mainRegistry({ maxFrames: 1 });
  bounded.registerFrame({ frameId: "oopif", targetId: "main", backendNodeId: 1 });
  bounded.beginFrameSwap("oopif", "main");
  assert.equal(bounded.getSnapshot().counts.frames.detached, 1);
  throwsCode(
    () => bounded.registerFrame({ frameId: "other-frame", targetId: "main", backendNodeId: 2 }),
    CODES.MAX_FRAMES_EXCEEDED,
  );
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

test("dedicated and module workers are tracked but excluded from observation and action routes", () => {
  const registry = mainRegistry();
  registry.registerTarget({
    targetId: "dedicated-worker",
    type: "worker",
    sessionId: "dedicated-worker-session",
    origin: "https://example.test",
  });
  registry.registerTarget({
    targetId: "module-worker",
    type: "worker",
    sessionId: "module-worker-session",
    origin: "https://example.test",
  });
  throwsCode(() => registry.createRef("dedicated-worker", 1), CODES.NON_ACTIONABLE_TARGET);
  throwsCode(() => registry.createRef("module-worker", 1), CODES.NON_ACTIONABLE_TARGET);
  assert.deepEqual(registry.listObservationRoutes().map((route) => route.targetId), ["main"]);
  assert.equal(registry.getSnapshot().counts.targets.active, 3);
});

test("related page target subtrees remain containment-only and non-actionable", () => {
  const registry = mainRegistry();
  registry.registerTarget({
    targetId: "popup", type: "page", parentTargetId: "main", sessionId: "popup-session", origin: "https://example.test",
  });
  registry.registerFrame({ frameId: "popup-root", targetId: "popup", origin: "https://example.test" });
  registry.registerFrame({ frameId: "popup-host", targetId: "popup", backendNodeId: 10, origin: "https://example.test" });
  registry.registerTarget({
    targetId: "popup-oopif", type: "iframe", parentTargetId: "popup", hostFrameId: "popup-host",
    sessionId: "popup-oopif-session", origin: "https://example.test",
  });
  registry.registerFrame({ frameId: "popup-oopif-root", targetId: "popup-oopif", origin: "https://example.test" });
  registry.registerTarget({
    targetId: "popup-worker", type: "worker", parentTargetId: "popup", sessionId: "popup-worker-session",
  });

  assert.deepEqual(registry.listObservationRoutes().map((route) => route.targetId), ["main"]);
  assert.equal(registry.relatedPageAncestorForSession("popup-session")?.targetId, "popup");
  assert.equal(registry.relatedPageAncestorForSession("popup-oopif-session")?.targetId, "popup");
  assert.equal(registry.relatedPageAncestorForSession("popup-worker-session")?.targetId, "popup");
  throwsCode(() => registry.createRef("popup", 1, { frameId: "popup-root" }), CODES.NON_ACTIONABLE_TARGET);
  throwsCode(() => registry.createRef("popup-oopif", 2, { frameId: "popup-oopif-root" }), CODES.NON_ACTIONABLE_TARGET);
  throwsCode(() => registry.frameOwnerRoutes("popup-oopif-root"), CODES.FRAME_CONFLICT);
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
