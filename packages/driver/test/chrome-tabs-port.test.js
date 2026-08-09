import test from "node:test";
import assert from "node:assert/strict";

import { createChromeTabsPort } from "../src/chrome-tabs-port.js";

test("chrome tabs port creates owned tabs without taking the user's active tab", async () => {
  const creates = [];
  const groups = [];
  const updates = [];
  const tabUpdates = [];
  const chromeApi = {
    tabs: {
      async create(input) {
        creates.push(input);
        return { id: 101 };
      },
      async group(input) {
        groups.push(input);
        return 201;
      },
      async remove() {},
      async get() {
        return { id: 101 };
      },
      async update(tabId, input) {
        tabUpdates.push({ tabId, input });
        return { id: tabId };
      },
      onRemoved: {
        addListener() {},
        removeListener() {},
      },
    },
    tabGroups: {
      update(groupId, input) {
        updates.push({ groupId, input });
        return Promise.resolve();
      },
    },
    debugger: {
      onEvent: {
        addListener() {},
        removeListener() {},
      },
      onDetach: {
        addListener() {},
        removeListener() {},
      },
    },
  };

  const port = createChromeTabsPort(chromeApi);
  assert.deepEqual(await port.createOwnedTab("https://example.com", "blue", "QA"), { tabId: 101, groupId: 201 });
  assert.deepEqual(creates, [{ url: "https://example.com", active: false }]);
  assert.deepEqual(groups, [{ tabIds: [101] }]);
  assert.deepEqual(tabUpdates, [{ tabId: 101, input: { autoDiscardable: false } }]);
  assert.deepEqual(updates, [{ groupId: 201, input: { title: "QA", color: "blue" } }]);
});

test("incognito owned tabs open in an incognito window, reusing an existing one", async () => {
  const creates = [];
  const windowCreates = [];
  const port = createChromeTabsPort({
    tabs: {
      async create(input) { creates.push(input); return { id: 55 }; },
      async group() { return 66; },
      async remove() {}, async get() { return { id: 55 }; },
      onRemoved: { addListener() {}, removeListener() {} },
    },
    tabGroups: { async update() {} },
    windows: {
      async getAll() { return [{ id: 7, incognito: false, type: "normal" }, { id: 9, incognito: true, type: "normal" }]; },
      async create(input) { windowCreates.push(input); return { id: 999 }; },
    },
    debugger: { onEvent: { addListener() {}, removeListener() {} }, onDetach: { addListener() {}, removeListener() {} } },
  });
  const result = await port.createOwnedTab("https://example.com", "blue", "QA", { incognito: true });
  assert.deepEqual(result, { tabId: 55, groupId: 66 });
  assert.equal(creates[0].windowId, 9, "reuses the existing incognito window");
  assert.equal(windowCreates.length, 0, "does not open a second incognito window when one exists");
});

test("incognito owned tabs open a new incognito window when none exists", async () => {
  const creates = [];
  const port = createChromeTabsPort({
    tabs: {
      async create(input) { creates.push(input); return { id: 1 }; },
      async group() { return 2; }, async remove() {}, async get() { return { id: 1 }; },
      onRemoved: { addListener() {}, removeListener() {} },
    },
    tabGroups: { async update() {} },
    windows: { async getAll() { return [{ id: 1, incognito: false, type: "normal" }]; }, async create() { return { id: 42 }; } },
    debugger: { onEvent: { addListener() {}, removeListener() {} }, onDetach: { addListener() {}, removeListener() {} } },
  });
  await port.createOwnedTab("https://example.com", "blue", "QA", { incognito: true });
  assert.equal(creates[0].windowId, 42, "creates and uses a fresh incognito window");
});

test("incognito owned tabs surface incognito_not_allowed when the extension is blocked", async () => {
  const port = createChromeTabsPort({
    tabs: {
      async create() { return { id: 1 }; }, async group() { return 2; }, async remove() {}, async get() { return { id: 1 }; },
      onRemoved: { addListener() {}, removeListener() {} },
    },
    tabGroups: { async update() {} },
    windows: { async getAll() { return []; }, async create() { throw new Error("Incognito mode is not allowed"); } },
    debugger: { onEvent: { addListener() {}, removeListener() {} }, onDetach: { addListener() {}, removeListener() {} } },
  });
  await assert.rejects(port.createOwnedTab("https://example.com", "blue", "QA", { incognito: true }), /incognito_not_allowed/);
});

test("chrome tabs port hands a retained tab back without touching close or deliverable tabs", async () => {
  const ungrouped = [];
  const updated = [];
  const port = createChromeTabsPort({
    tabs: {
      async ungroup(tabId) { ungrouped.push(tabId); },
      async update(tabId, input) { updated.push({ tabId, input }); },
      async create() { return { id: 1 }; },
      async group() { return 1; },
      async remove() {},
      async get() { return { id: 1 }; },
      onRemoved: { addListener() {}, removeListener() {} },
    },
    tabGroups: { async update() {} },
    debugger: {
      onEvent: { addListener() {}, removeListener() {} },
      onDetach: { addListener() {}, removeListener() {} },
    },
  });

  await port.finalizeTab(10, "deliverable");
  await port.finalizeTab(11, "close");
  await port.finalizeTab(12, "handoff");
  assert.deepEqual(ungrouped, [12]);
  assert.deepEqual(updated, [{ tabId: 12, input: { active: true } }]);
});

test("chrome tabs port can focus one exact owned session tab for a local observer", async () => {
  const calls = [];
  const port = createChromeTabsPort({
    tabs: {
      async get() { return { id: 9, windowId: 4 }; },
      async update(tabId, input) { calls.push(["tab", tabId, input]); },
      onRemoved: { addListener() {}, removeListener() {} },
    },
    windows: { async update(windowId, input) { calls.push(["window", windowId, input]); } },
    debugger: { onEvent: { addListener() {}, removeListener() {} }, onDetach: { addListener() {}, removeListener() {} } },
  });
  await port.focusTab(9);
  assert.deepEqual(calls, [["tab", 9, { active: true }], ["window", 4, { focused: true }]]);
});

test("chrome tabs port focuses the window without mutating an already active tab", async () => {
  const calls = [];
  const port = createChromeTabsPort({
    tabs: {
      async get() { return { id: 9, windowId: 4, active: true }; },
      async update(tabId, input) { calls.push(["tab", tabId, input]); },
      onRemoved: { addListener() {}, removeListener() {} },
    },
    windows: { async update(windowId, input) { calls.push(["window", windowId, input]); } },
    debugger: { onEvent: { addListener() {}, removeListener() {} }, onDetach: { addListener() {}, removeListener() {} } },
  });
  await port.focusTab(9);
  assert.deepEqual(calls, [["window", 4, { focused: true }]]);
});

test("chrome tabs port accepts a concurrent activation after Chrome rejects the redundant update", async () => {
  const calls = [];
  let reads = 0;
  const port = createChromeTabsPort({
    tabs: {
      async get() {
        reads += 1;
        return { id: 9, windowId: 4, active: reads > 1 };
      },
      async update() { throw new Error("Tabs cannot be edited right now (user may be dragging a tab)."); },
      onRemoved: { addListener() {}, removeListener() {} },
    },
    windows: { async update(windowId, input) { calls.push(["window", windowId, input]); } },
    debugger: { onEvent: { addListener() {}, removeListener() {} }, onDetach: { addListener() {}, removeListener() {} } },
  });
  await port.focusTab(9);
  assert.equal(reads, 2);
  assert.deepEqual(calls, [["window", 4, { focused: true }]]);
});

test("chrome tabs port preserves a focus failure when the target tab did not become active", async () => {
  const port = createChromeTabsPort({
    tabs: {
      async get() { return { id: 9, windowId: 4, active: false }; },
      async update() { throw new Error("Tabs cannot be edited right now (user may be dragging a tab)."); },
      onRemoved: { addListener() {}, removeListener() {} },
    },
    windows: { async update() {} },
    debugger: { onEvent: { addListener() {}, removeListener() {} }, onDetach: { addListener() {}, removeListener() {} } },
  });
  await assert.rejects(port.focusTab(9), /Tabs cannot be edited right now/);
});
