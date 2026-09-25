import test from "node:test";
import assert from "node:assert/strict";
import { existingPageConnection } from "../apps/mcp-server/src/existing-page-family.ts";

const rootToken = { tabId: 1, epoch: "epoch", generation: 1 };
const childToken = { tabId: 2, epoch: "epoch", generation: 2 };

function fixture() {
  const controller = new AbortController();
  const listeners = new Set();
  const client = {
    signal: controller.signal,
    hello: { capabilities: ["owned_popups"] },
    closed: false,
    calls: [],
    onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    emit(message) { for (const listener of [...listeners]) listener(message); },
    async call(method, args) { this.calls.push({ method, args }); return {}; },
    close() { this.closed = true; controller.abort(); },
  };
  const connection = existingPageConnection(client, rootToken);
  connection.wire.onEvent(() => {});
  return { client, connection, emit: (message) => client.emit(message) };
}

function routeEvent(token, sessionId) {
  return { token, event: { method: "Target.attachedToTarget", params: { sessionId } } };
}

test("duplicate route ownership is accepted at the 256-route boundary", () => {
  const { client, emit } = fixture();
  for (let index = 0; index < 256; index += 1) emit(routeEvent(rootToken, `route-${index}`));
  assert.equal(client.closed, false);
  emit(routeEvent(rootToken, "route-0"));
  assert.equal(client.closed, false);
});

test("a genuinely new route over capacity closes the client", () => {
  const { client, emit } = fixture();
  for (let index = 0; index < 256; index += 1) emit(routeEvent(rootToken, `route-${index}`));
  emit(routeEvent(rootToken, "route-over-capacity"));
  assert.equal(client.closed, true);
});

test("a cross-tab route collision closes the client without transferring ownership", () => {
  const { client, emit } = fixture();
  emit({ token: rootToken, event: { method: "Newton.pageCreated", params: { token: childToken } } });
  emit(routeEvent(rootToken, "shared-route"));
  emit(routeEvent(childToken, "shared-route"));
  assert.equal(client.closed, true);
  assert.deepEqual(client.calls, []);
});
