import test from "node:test";
import assert from "node:assert/strict";
import { TabClaims } from "../apps/tab-adapter/src/claims.ts";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolveValue, rejectValue) => {
    resolve = resolveValue;
    reject = rejectValue;
  });
  return { promise, resolve, reject };
}

function debuggerApi({ attach = async () => {}, detach = async () => {} } = {}) {
  const attached = [];
  const detached = [];
  return {
    attached,
    detached,
    api: {
      async attach(target, version) { attached.push({ target, version }); return attach(target, version); },
      async detach(target) { detached.push(target.tabId); return detach(target); },
      async sendCommand() { return {}; },
    },
  };
}

test("creates an inactive blank tab and claims it before navigation", async () => {
  const debug = debuggerApi();
  const creates = [];
  const removes = [];
  const tabs = {
    async create(properties) { creates.push(properties); return { id: 7 }; },
    async remove(tabId) { removes.push(tabId); },
  };
  const authority = new TabClaims(debug.api, "epoch");
  const owner = authority.bindPort();
  const token = await authority.createTab(owner, tabs);

  assert.deepEqual(creates, [{ url: "about:blank", active: false }]);
  assert.deepEqual(debug.attached, [{ target: { tabId: 7 }, version: "1.3" }]);
  assert.deepEqual(token, { tabId: 7, epoch: "epoch", generation: 1 });
  assert.equal(authority.isClaimed(7), true);
  assert.deepEqual(await authority.command(owner, token, "Page.enable", {}), {});
  assert.deepEqual(removes, []);
  await authority.disconnect(owner);
});

test("failed attach removes only the newly created tab", async () => {
  const debug = debuggerApi({ attach: async ({ tabId }) => { if (tabId === 2) throw new Error("attach_failed"); } });
  const removes = [];
  const tabs = {
    async create() { return { id: 2 }; },
    async remove(tabId) { removes.push(tabId); },
  };
  const authority = new TabClaims(debug.api, "epoch");
  const owner = authority.bindPort();
  const existing = await authority.claim(owner, 1);

  await assert.rejects(authority.createTab(owner, tabs), /attach_failed/);
  assert.equal(authority.isClaimed(1), true);
  assert.equal(authority.isClaimed(2), false);
  assert.deepEqual(removes, [2]);
  assert.deepEqual(await authority.command(owner, existing, "DOM.getDocument", {}), {});
  await authority.disconnect(owner);
});

test("disconnect and quiesce wait for pending creation cleanup and reject late ownership", async () => {
  for (const mode of ["disconnect", "quiesce"]) {
    const debug = debuggerApi();
    const createGate = deferred();
    const removes = [];
    const tabs = {
      async create() { return createGate.promise; },
      async remove(tabId) { removes.push(tabId); },
    };
    const authority = new TabClaims(debug.api, "epoch");
    const owner = authority.bindPort();
    const creation = authority.createTab(owner, tabs);
    const cleanup = mode === "disconnect" ? authority.disconnect(owner) : authority.quiesce();
    createGate.resolve({ id: mode === "disconnect" ? 10 : 11 });

    const [created, cleaned] = await Promise.allSettled([creation, cleanup]);
    assert.equal(created.status, "rejected", mode);
    assert.match(created.reason.message, /connection_closed/);
    assert.equal(cleaned.status, "fulfilled", mode);
    assert.deepEqual(removes, [mode === "disconnect" ? 10 : 11], mode);
    assert.equal(authority.isClaimed(mode === "disconnect" ? 10 : 11), false);
  }
});

test("concurrent creation reserves capacity before tab creation completes", async () => {
  const debug = debuggerApi();
  const gates = [];
  let nextId = 100;
  const tabs = {
    create() {
      const gate = deferred();
      gates.push({ gate, id: nextId++ });
      return gate.promise;
    },
    async remove() {},
  };
  const authority = new TabClaims(debug.api, "epoch");
  const owner = authority.bindPort();
  const creations = Array.from({ length: 32 }, () => authority.createTab(owner, tabs));
  await assert.rejects(authority.createTab(owner, tabs), /claim_capacity/);
  assert.equal(gates.length, 32);

  gates.forEach(({ gate, id }) => gate.resolve({ id }));
  const tokens = await Promise.all(creations);
  assert.equal(new Set(tokens.map((token) => token.tabId)).size, 32);
  assert.equal(authority.isClaimed(133), false);
  await authority.disconnect(owner);
});

test("a foreign intervening claim is never removed by failed create ownership", async () => {
  const debug = debuggerApi();
  const authority = new TabClaims(debug.api, "epoch");
  const creator = authority.bindPort();
  const foreign = authority.bindPort();
  const removes = [];
  let foreignClaim;
  const tabs = {
    async create() {
      foreignClaim = authority.claim(foreign, 50);
      return { id: 50 };
    },
    async remove(tabId) { removes.push(tabId); },
  };

  await assert.rejects(authority.createTab(creator, tabs), /tab_owned/);
  const token = await foreignClaim;
  assert.deepEqual(removes, []);
  assert.equal(authority.isClaimed(50), true);
  assert.deepEqual(await authority.command(foreign, token, "DOM.getDocument", {}), {});
  await authority.disconnect(foreign);
  await authority.disconnect(creator);
});
