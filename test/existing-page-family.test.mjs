import test from "node:test";
import assert from "node:assert/strict";
import { existingPageConnection } from "../apps/mcp-server/src/existing-page-family.ts";

const rootToken = { tabId: 1, epoch: "epoch", generation: 1 };
const childToken = { tabId: 2, epoch: "epoch", generation: 2 };

function pageCreated(opener, child) {
  return { token: opener, event: { method: "Newton.pageCreated", params: { token: child } } };
}

function fixture(initial = []) {
  const controller = new AbortController();
  const listeners = new Set();
  const calls = [];
  const client = {
    signal: controller.signal,
    hello: { capabilities: ["owned_popups"] },
    closed: false,
    async call(method, args, readOnly) {
      calls.push({ method, args, readOnly });
      return {};
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(message) {
      for (const listener of [...listeners]) listener(message);
    },
    close() {
      this.closed = true;
      controller.abort();
    },
  };
  const connection = existingPageConnection(client, rootToken, initial);
  return { client, connection, calls, emit: (message) => client.emit(message) };
}

test("accepts an owned browser popup, rejects foreign/stale openers, and uses the child token", async () => {
  const { connection, calls, emit } = fixture();
  const events = [];
  const unsubscribe = connection.wire.onEvent((event) => events.push(event));
  emit(pageCreated({ tabId: 99, epoch: "epoch", generation: 1 }, childToken));
  emit(pageCreated({ tabId: 1, epoch: "other", generation: 1 }, childToken));
  emit(pageCreated({ tabId: 1, epoch: "epoch", generation: 99 }, childToken));
  emit(pageCreated(rootToken, childToken));

  assert.equal(connection.tracksOwnedPages, true);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {
    method: "Target.targetCreated",
    params: { targetInfo: { type: "page", targetId: "tab_2", openerId: "tab_1" } },
    sessionId: null,
  });
  await connection.wire.send("Runtime.evaluate", { expression: "1" }, "tab_2");
  assert.deepEqual(calls[0].args.token, childToken);
  assert.equal(calls[0].args.sessionId, undefined);
  unsubscribe();
  await connection.close();
});

test("OOPIF routes remain bound to their child claim and cross-claim routes close the client", async () => {
  const { connection, client, calls, emit } = fixture();
  emit(pageCreated(rootToken, childToken));
  emit({ token: childToken, event: { method: "Target.attachedToTarget", params: { sessionId: "child-route" } } });
  await connection.wire.send("DOM.getDocument", {}, "child-route");
  assert.deepEqual(calls[0].args.token, childToken);
  assert.equal(calls[0].args.sessionId, "child-route");

  emit({ token: rootToken, event: { method: "Target.attachedToTarget", params: { sessionId: "shared-route" } } });
  emit({ token: childToken, event: { method: "Target.attachedToTarget", params: { sessionId: "shared-route" } } });
  assert.equal(client.closed, true);
  await connection.close();
});

test("closed children lose routes and late events cannot resurrect their claim", async () => {
  const { connection, calls, emit } = fixture();
  const events = [];
  connection.wire.onEvent((event) => events.push(event));
  emit(pageCreated(rootToken, childToken));
  emit({ token: childToken, event: { method: "Target.attachedToTarget", params: { sessionId: "child-route" } } });
  emit({ token: childToken, event: { method: "Newton.pageClosed", params: {} } });
  emit({ token: childToken, event: { method: "Target.attachedToTarget", params: { sessionId: "late-route" } } });

  assert.equal(events.filter((event) => event.method === "Target.targetCreated").length, 1);
  assert.equal(events.filter((event) => event.method === "Target.targetDestroyed").length, 1);
  await assert.rejects(connection.wire.send("Runtime.evaluate", {}, "tab_2"), /foreign_target/);
  assert.equal(calls.length, 0);
  await connection.close();
});

test("initial buffered popup reaches the first listener and close releases only owned claims", async () => {
  const buffered = fixture([pageCreated(rootToken, childToken)]);
  const events = [];
  buffered.connection.wire.onEvent((event) => events.push(event));
  assert.equal(events.length, 1);
  assert.equal(events[0].method, "Target.targetCreated");
  await buffered.connection.close();
  const releaseCalls = buffered.calls.filter((call) => call.method === "release");
  assert.deepEqual(releaseCalls.map((call) => call.args.token), [rootToken, childToken]);
  assert.equal(buffered.calls.some((call) => call.method.startsWith("Target.")), false);
});
