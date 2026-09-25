import test from "node:test";
import assert from "node:assert/strict";
import { UpdateBinding } from "../apps/tab-adapter/src/update-binding.ts";

const PROFILE = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/update.html";
const OTHER_PROFILE = "chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/update.html";
const TICKET = "a".repeat(64);
const OTHER_TICKET = "b".repeat(64);

function markerUrl(profile, ticket) {
  return `about:blank#newton-browser-update/${new URL(profile).hostname}/${ticket}`;
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

function fakeTabs(initial = []) {
  let nextId = 1;
  const state = {
    tabs: initial.map((tab) => ({ ...tab })),
    queries: [],
    creates: [],
    removes: [],
    updatedListeners: new Set(),
    removedListeners: new Set(),
    queryError: undefined,
    getError: undefined,
    createError: undefined,
    removeError: undefined,
    autoCommit: true,
    commitBeforeSubscription: false,
  };
  const api = {
    state,
    async query(query) {
      state.queries.push(query);
      if (state.queryError) throw state.queryError;
      const prefix = typeof query.url === "string" ? (query.url.endsWith("*") ? query.url.slice(0, -1) : query.url) : "";
      return state.tabs.filter((tab) => typeof tab.url === "string" && tab.url.startsWith(prefix)).map((tab) => ({ ...tab }));
    },
    async get(tabId) {
      if (state.getError) throw state.getError;
      const tab = state.tabs.find((candidate) => candidate.id === tabId);
      if (!tab) throw new Error("tab_missing");
      return { ...tab };
    },
    async create(properties) {
      state.creates.push({ ...properties });
      if (state.createError) throw state.createError;
      const tab = { id: nextId++, url: state.commitBeforeSubscription ? properties.url : `${properties.url.slice(0, properties.url.indexOf("#"))}#pending` };
      state.tabs.push(tab);
      if (state.commitBeforeSubscription) return { ...tab };
      if (state.autoCommit) queueMicrotask(() => api.emitUpdated(tab.id, properties.url));
      return { ...tab };
    },
    async remove(tabId) {
      state.removes.push(tabId);
      if (state.removeError) throw state.removeError;
      state.tabs = state.tabs.filter((tab) => tab.id !== tabId);
    },
    onUpdated: {
      addListener(listener) { state.updatedListeners.add(listener); },
      removeListener(listener) { state.updatedListeners.delete(listener); },
    },
    onRemoved: {
      addListener(listener) { state.removedListeners.add(listener); },
      removeListener(listener) { state.removedListeners.delete(listener); },
    },
    emitUpdated(tabId, url) {
      const tab = state.tabs.find((candidate) => candidate.id === tabId);
      if (tab) tab.url = url;
      for (const listener of [...state.updatedListeners]) listener(tabId, { status: "complete" }, { url });
    },
    emitRemoved(tabId) {
      state.tabs = state.tabs.filter((tab) => tab.id !== tabId);
      for (const listener of [...state.removedListeners]) listener(tabId);
    },
  };
  return api;
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

async function waitForUpdatedListener(tabs) {
  for (let attempt = 0; attempt < 8 && tabs.state.updatedListeners.size === 0; attempt++) await Promise.resolve();
  assert.equal(tabs.state.updatedListeners.size, 1);
  assert.equal(tabs.state.removedListeners.size, 1);
}

test("rejects invalid tickets and extension profiles before tab operations", async () => {
  const tabs = fakeTabs();
  assert.throws(() => new UpdateBinding(tabs, "https://example.test/update.html"), /update_binding_invalid/);
  const binding = new UpdateBinding(tabs, PROFILE);
  for (const operation of [
    () => binding.prepare("short"),
    () => binding.prove("not-hex-".repeat(8)),
    () => binding.finish("C".repeat(64)),
  ]) await assert.rejects(operation, /update_ticket_invalid/);
  assert.deepEqual(tabs.state.queries, []);

  await assert.deepEqual(await binding.prepare(TICKET), { tabId: 1 });
  const foreign = new UpdateBinding(tabs, OTHER_PROFILE);
  await assert.rejects(foreign.prove(TICKET), /update_binding_lost/);
  await binding.finish(TICKET);
});

test("creates one inactive exact marker and a new class instance proves it after reload", async () => {
  const tabs = fakeTabs();
  const first = new UpdateBinding(tabs, PROFILE);
  assert.deepEqual(await first.prepare(TICKET), { tabId: 1 });
  assert.deepEqual(tabs.state.creates, [{ url: markerUrl(PROFILE, TICKET), active: false }]);

  const afterReload = new UpdateBinding(tabs, PROFILE);
  assert.deepEqual(await afterReload.prove(TICKET), { tabId: 1 });
  await afterReload.finish(TICKET);
  assert.deepEqual(tabs.state.removes, [1]);
  assert.deepEqual(tabs.state.tabs, []);
});

test("waits for a pending marker to commit before prepare resolves", async () => {
  const tabs = fakeTabs();
  tabs.state.autoCommit = false;
  const binding = new UpdateBinding(tabs, PROFILE);
  const pending = binding.prepare(TICKET);
  await flushMicrotasks();
  assert.equal(tabs.state.tabs[0].url, "about:blank#pending");
  assert.equal(tabs.state.updatedListeners.size, 1);
  assert.equal(tabs.state.removedListeners.size, 1);
  tabs.emitUpdated(1, markerUrl(PROFILE, TICKET));
  assert.deepEqual(await pending, { tabId: 1 });
  assert.equal(tabs.state.updatedListeners.size, 0);
  assert.equal(tabs.state.removedListeners.size, 0);
});

test("rejects removal before commit and releases the busy gate", async () => {
  const tabs = fakeTabs();
  tabs.state.autoCommit = false;
  const binding = new UpdateBinding(tabs, PROFILE);
  const pending = binding.prepare(TICKET);
  await waitForUpdatedListener(tabs);
  tabs.emitRemoved(1);
  await assert.rejects(pending, /update_binding_lost/);
  assert.equal(tabs.state.updatedListeners.size, 0);
  assert.equal(tabs.state.removedListeners.size, 0);

  tabs.state.autoCommit = true;
  assert.deepEqual(await binding.prepare(OTHER_TICKET), { tabId: 2 });
  await binding.finish(OTHER_TICKET);
});

test("initial get reconciles a commit event missed before listener subscription", async () => {
  const tabs = fakeTabs();
  tabs.state.commitBeforeSubscription = true;
  const binding = new UpdateBinding(tabs, PROFILE);
  assert.deepEqual(await binding.prepare(TICKET), { tabId: 1 });
  assert.equal(tabs.state.updatedListeners.size, 0);
  assert.equal(tabs.state.removedListeners.size, 0);
  await binding.finish(TICKET);
});

test("deadline failure removes both listeners and releases the busy gate", async (t) => {
  const tabs = fakeTabs();
  tabs.state.autoCommit = false;
  const binding = new UpdateBinding(tabs, PROFILE);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const pending = binding.prepare(TICKET);
    await flushMicrotasks();
    assert.equal(tabs.state.updatedListeners.size, 1);
    t.mock.timers.tick(5000);
    await assert.rejects(pending, /update_binding_timeout/);
    assert.equal(tabs.state.updatedListeners.size, 0);
    assert.equal(tabs.state.removedListeners.size, 0);
  } finally {
    t.mock.timers.reset();
  }
});

test("rejects ambiguous markers, wrong ticket markers, removal, and navigation", async () => {
  const tabs = fakeTabs([
    { id: 7, url: markerUrl(PROFILE, TICKET) },
    { id: 8, url: markerUrl(PROFILE, OTHER_TICKET) },
  ]);
  const binding = new UpdateBinding(tabs, PROFILE);
  await assert.rejects(binding.prove(TICKET), /update_binding_lost/);
  assert.deepEqual(tabs.state.removes, []);

  tabs.state.tabs = [{ id: 7, url: markerUrl(PROFILE, OTHER_TICKET) }];
  await assert.rejects(binding.prove(TICKET), /update_binding_lost/);
  await assert.rejects(binding.finish(TICKET), /update_binding_lost/);
  assert.deepEqual(tabs.state.removes, []);

  tabs.state.tabs = [];
  await assert.rejects(binding.prove(TICKET), /update_binding_lost/);
  await binding.finish(TICKET);
  await binding.finish(TICKET);
  assert.deepEqual(tabs.state.removes, []);
});

test("serializes simultaneous prepare calls without leaking busy state", async () => {
  const tabs = fakeTabs();
  const queryGate = deferred();
  let firstQuery = true;
  const originalQuery = tabs.query;
  tabs.query = async (...args) => {
    if (firstQuery) {
      firstQuery = false;
      await queryGate.promise;
    }
    return originalQuery.apply(tabs, args);
  };
  const binding = new UpdateBinding(tabs, PROFILE);
  const first = binding.prepare(TICKET);
  await assert.rejects(binding.prepare(OTHER_TICKET), /adapter_update_busy/);
  queryGate.resolve();
  assert.deepEqual(await first, { tabId: 1 });
  await binding.finish(TICKET);
  assert.deepEqual(await binding.prepare(OTHER_TICKET), { tabId: 2 });
});

test("query, create, and remove failures propagate and preparation always releases busy state", async () => {
  const tabs = fakeTabs();
  const binding = new UpdateBinding(tabs, PROFILE);

  tabs.state.queryError = new Error("query_failed");
  await assert.rejects(binding.prepare(TICKET), /query_failed/);
  tabs.state.queryError = undefined;

  tabs.state.getError = new Error("get_failed");
  await assert.rejects(binding.prepare(TICKET), /update_binding_lost/);
  tabs.state.getError = undefined;
  assert.deepEqual(tabs.state.tabs, [{ id: 1, url: markerUrl(PROFILE, TICKET) }]);
  tabs.state.tabs = [];

  tabs.state.createError = new Error("create_failed");
  await assert.rejects(binding.prepare(TICKET), /create_failed/);
  tabs.state.createError = undefined;
  assert.deepEqual(await binding.prepare(TICKET), { tabId: 2 });

  tabs.state.removeError = new Error("remove_failed");
  await assert.rejects(binding.finish(TICKET), /remove_failed/);
  assert.deepEqual(tabs.state.removes, [2]);
});

test("finish removes only the exact proven marker", async () => {
  const tabs = fakeTabs([{ id: 11, url: markerUrl(PROFILE, TICKET) }]);
  const binding = new UpdateBinding(tabs, PROFILE);
  await assert.rejects(binding.finish(OTHER_TICKET), /update_binding_lost/);
  assert.deepEqual(tabs.state.removes, []);
  await binding.finish(TICKET);
  assert.deepEqual(tabs.state.removes, [11]);
  assert.deepEqual(tabs.state.tabs, []);
});

test('retrying the same ticket after a failed commit read reuses the exact marker',async()=>{
  const tabs=fakeTabs(),first=new UpdateBinding(tabs,PROFILE);
  tabs.state.getError=new Error('get_failed');
  await assert.rejects(first.prepare(TICKET),/update_binding_lost/);
  tabs.state.getError=undefined;
  const recovered=new UpdateBinding(tabs,PROFILE);
  await assert.rejects(recovered.prepare(OTHER_TICKET),/adapter_update_busy/);
  assert.deepEqual(await recovered.prepare(TICKET),{tabId:1});
  assert.equal(tabs.state.creates.length,1);
  await recovered.finish(TICKET);assert.deepEqual(tabs.state.removes,[1]);
});
