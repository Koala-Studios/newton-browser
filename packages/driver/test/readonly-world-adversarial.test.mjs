import test from "node:test";
import assert from "node:assert/strict";
import { PageDirectory } from "../src/page-directory.ts";
import { ReadonlyWorlds } from "../src/readonly-world.ts";

function setup() {
  const directory = new PageDirectory("epoch");
  directory.registerRoute("route-a");
  directory.addPage("p1");
  directory.navigate("p1", { frameId: "f1", route: "route-a", loaderId: "loader-1" });
  return directory;
}

function binding(directory, frameId = "f1", backendNodeId = 1) {
  const stamp = directory.frames("p1").find((value) => value.frameId === frameId);
  assert.ok(stamp, `missing frame ${frameId}`);
  return directory.binding(stamp, backendNodeId);
}

function wireFor(responder, calls) {
  return {
    send(method, params, route) {
      calls.push({ method, params, route });
      return responder(method, params, route, calls.length);
    },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolveValue, rejectValue) => {
    resolve = resolveValue;
    reject = rejectValue;
  });
  return { promise, resolve, reject };
}

test("reuses one context promise for the same frame generation and route", async () => {
  const directory = setup();
  const calls = [];
  const worlds = new ReadonlyWorlds(directory, wireFor(async () => ({ executionContextId: 11 }), calls));
  const page = binding(directory);

  const first = worlds.context(page);
  const second = worlds.context(page);
  assert.strictEqual(first, second);
  assert.equal(await first, 11);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    method: "Page.createIsolatedWorld",
    params: { frameId: "f1", worldName: "newton-browser-read", grantUniveralAccess: false },
    route: "route-a",
  });
});

test("isolates cache entries by frame", async () => {
  const directory = setup();
  directory.registerRoute("route-child");
  directory.navigate("p1", { frameId: "f2", parentId: "f1", route: "route-child", loaderId: "child-1" });
  const calls = [];
  const worlds = new ReadonlyWorlds(directory, wireFor(async (_method, _params, route) => ({ executionContextId: route === "route-a" ? 21 : 22 }), calls));

  const rootContext = worlds.context(binding(directory, "f1"));
  const childContext = worlds.context(binding(directory, "f2", 2));
  assert.notStrictEqual(rootContext, childContext);
  assert.deepEqual(await Promise.all([rootContext, childContext]), [21, 22]);
  assert.deepEqual(calls.map((call) => [call.params.frameId, call.route]), [["f1", "route-a"], ["f2", "route-child"]]);
});

test("navigation generation invalidates a cached context", async () => {
  const directory = setup();
  const calls = [];
  const worlds = new ReadonlyWorlds(directory, wireFor(async (_method, _params, _route, count) => ({ executionContextId: count + 30 }), calls));
  const oldContext = worlds.context(binding(directory));
  assert.equal(await oldContext, 31);

  directory.navigate("p1", { frameId: "f1", route: "route-a", loaderId: "loader-2" });
  const newContext = worlds.context(binding(directory));
  assert.notStrictEqual(newContext, oldContext);
  assert.equal(await newContext, 32);
  assert.equal(calls.length, 2);
});

test("route rebinding invalidates a cached context and uses the new route", async () => {
  const directory = setup();
  directory.registerRoute("route-b");
  const calls = [];
  const worlds = new ReadonlyWorlds(directory, wireFor(async () => ({ executionContextId: 40 + calls.length }), calls));
  const oldContext = worlds.context(binding(directory));
  assert.equal(await oldContext, 41);

  directory.navigate("p1", { frameId: "f1", route: "route-b", loaderId: "loader-2" });
  const newContext = worlds.context(binding(directory));
  assert.notStrictEqual(newContext, oldContext);
  assert.equal(await newContext, 42);
  assert.deepEqual(calls.map((call) => call.route), ["route-a", "route-b"]);
});

test("failed context creation is evicted so the next request retries", async () => {
  const directory = setup();
  const calls = [];
  const worlds = new ReadonlyWorlds(directory, wireFor(async (_method, _params, _route, count) => {
    if (count === 1) throw new Error("create failed");
    return { executionContextId: 51 };
  }, calls));

  await assert.rejects(worlds.context(binding(directory)), /create failed/);
  assert.equal(await worlds.context(binding(directory)), 51);
  assert.equal(calls.length, 2);
});

test("malformed execution context IDs fail safely and can be retried", async () => {
  const directory = setup();
  const calls = [];
  const worlds = new ReadonlyWorlds(directory, wireFor(async (_method, _params, _route, count) => (
    count === 1 ? { executionContextId: "not-a-number" } : { executionContextId: 61 }
  ), calls));

  await assert.rejects(worlds.context(binding(directory)), (error) => error?.code === "evidence_unavailable");
  assert.equal(await worlds.context(binding(directory)), 61);
  assert.equal(calls.length, 2);
});

test("a late old response cannot evict or satisfy a newer navigation context", async () => {
  const directory = setup();
  const oldResponse = deferred();
  const calls = [];
  const worlds = new ReadonlyWorlds(directory, wireFor((_method, _params, _route, count) => (
    count === 1 ? oldResponse.promise : Promise.resolve({ executionContextId: 72 })
  ), calls));
  const oldContext = worlds.context(binding(directory));

  directory.navigate("p1", { frameId: "f1", route: "route-a", loaderId: "loader-new" });
  const newBinding = binding(directory);
  const newContext = worlds.context(newBinding);
  oldResponse.resolve({ executionContextId: 71 });

  await assert.rejects(oldContext, (error) => error?.code === "stale_target");
  assert.equal(await newContext, 72);
  assert.strictEqual(worlds.context(newBinding), newContext);
  assert.equal(calls.length, 2);
});

test("clear drops cached contexts without changing directory bindings", async () => {
  const directory = setup();
  const calls = [];
  const worlds = new ReadonlyWorlds(directory, wireFor(async (_method, _params, _route, count) => ({ executionContextId: 80 + count }), calls));
  const page = binding(directory);
  const first = worlds.context(page);
  assert.equal(await first, 81);

  worlds.clear();
  const second = worlds.context(page);
  assert.notStrictEqual(second, first);
  assert.equal(await second, 82);
  assert.equal(directory.route(page), "route-a");
  assert.equal(calls.length, 2);
});
