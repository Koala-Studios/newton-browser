import test from "node:test";
import assert from "node:assert/strict";

import { createChromeTabsPort } from "../src/chrome-tabs-port.js";

test("chrome tabs port creates owned tabs without taking the operator's active tab", async () => {
  const creates = [];
  const groups = [];
  const updates = [];
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
  assert.deepEqual(updates, [{ groupId: 201, input: { title: "QA", color: "blue" } }]);
});
