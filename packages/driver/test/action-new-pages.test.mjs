import test from "node:test";
import assert from "node:assert/strict";
import { encodeEngineResult, readObservationBudget } from "@newton-browser/core";
import { CommandContext } from "../src/command-context.ts";
import { PageExecutor } from "../src/page-executor.ts";

function fixture() {
  const controller = new AbortController();
  const calls = [];
  const connection = {
    epoch: "epoch",
    claimGeneration: 1,
    rootTargetId: "root",
    ownsBrowser: false,
    tracksOwnedPages: true,
    signal: controller.signal,
    wire: {
      async send(method, params, sessionId) {
        calls.push({ method, params, sessionId });
        return {};
      },
      onEvent() { return () => {}; },
    },
  };
  const executor = new PageExecutor(connection);
  addPage(executor, "root", undefined, "root-route", "https://example.test/root", "Root");
  const page = executor.directory.stamp("root");
  return { executor, page, calls, controller };
}

function addPage(executor, pageId, openerPageId, route, url, title) {
  executor.directory.addPage(pageId, openerPageId);
  executor.directory.registerRoute(route);
  executor.directory.navigate(pageId, {
    frameId: `${pageId}-frame`,
    route,
    loaderId: `${pageId}-loader`,
    url,
  });
  executor.directory.describe(executor.directory.stamp(pageId), { title, url });
}

function observed(page, nodes = []) {
  return {
    state: "available",
    trust: "untrusted_page_content",
    scope: "page",
    page,
    snapshotId: "s1",
    expiredSnapshots: [],
    nodes,
  };
}

function seedBaseline(executor, context, pageIds) {
  executor.actionPages.set(context, new Set(pageIds));
}

async function project(executor, context, page, value, budget) {
  executor.observeLocalFeedback = async () => value;
  return executor.observeAfterAction(context, page, budget);
}

test("excludes unchanged pages and does not perform a second browser observation", async () => {
  const { executor, page, calls } = fixture();
  const context = new CommandContext(10_000);
  try {
    addPage(executor, "existing", "root", "existing-route", "https://example.test/existing", "Existing");
    seedBaseline(executor, context, ["root", "existing"]);
    const before = observed(page, [{ ref: "e1", role: "button", name: "Keep" }]);
    const result = await project(executor, context, page, before, readObservationBudget(100_000));
    assert.deepEqual(result, before);
    assert.equal(calls.length, 0);
  } finally {
    context.dispose();
  }
});

test("projects bounded new page identities, opener metadata, and selection without selecting a page", async () => {
  const { executor, page } = fixture();
  const context = new CommandContext(10_000);
  try {
    seedBaseline(executor, context, ["root"]);
    for (let index = 1; index <= 10; index += 1) {
      const id = `popup-${index}`;
      const longTitle = `popup-${index}-\"\\\n<&`.repeat(60);
      const longUrl = `https://example.test/popup-${index}?q=${"%22%3C%26".repeat(120)}`;
      addPage(executor, id, "root", `${id}-route`, longUrl, longTitle);
    }
    const result = await project(executor, context, page, observed(page), readObservationBudget(1_000_000));
    assert.equal(result.newPages.length, 8);
    assert.deepEqual(result.newPages.map((item) => item.pageId), Array.from({ length: 8 }, (_, i) => `popup-${i + 1}`));
    for (const item of result.newPages) {
      assert.equal(item.openerPageId, "root");
      assert.equal(item.selected, false);
      assert.ok(item.title.length <= 128);
      assert.ok(item.url.length <= 256);
    }
    assert.equal(result.page.pageId, "root");
    assert.equal(result.newPagesIncomplete, true);
    assert.equal(result.state, "incomplete");
    assert.equal(result.incompleteReason, "output_limit");
  } finally {
    context.dispose();
  }
});

test("uses exact escaped-byte budgets while trimming crowded controls and page metadata", async () => {
  const make = () => {
    const value = fixture();
    const context = new CommandContext(10_000);
    seedBaseline(value.executor, context, ["root"]);
    for (let index = 1; index <= 8; index += 1) {
      const id = `crowded-${index}`;
      addPage(value.executor, id, "root", `${id}-route`, `https://example.test/popup-${index}`, `popup-${index}`);
    }
    const nodes = Array.from({ length: 12 }, (_, index) => ({
      ref: `e${index + 1}`,
      role: "button",
      name: `control-${index}-${"<&\"\\".repeat(80)}`,
      value: "value",
      readonly: false,
      disabled: false,
    }));
    return { ...value, context, before: observed(value.page, nodes) };
  };

  const full = make();
  let fullResult;
  try {
    fullResult = await project(full.executor, full.context, full.page, full.before, readObservationBudget(1_000_000));
  } finally {
    full.context.dispose();
  }
  const exactBytes = Buffer.byteLength(JSON.stringify(encodeEngineResult({
    nextCommandId: Number.MAX_SAFE_INTEGER,
    observation: fullResult,
  })), "utf8");

  const constrained = make();
  let constrainedResult;
  try {
    constrainedResult = await project(constrained.executor, constrained.context, constrained.page, constrained.before, readObservationBudget(exactBytes - 1));
    assert.equal(constrainedResult.state, "incomplete");
    assert.equal(constrainedResult.newPagesIncomplete, undefined);
    assert.equal(constrainedResult.incompleteReason, "output_limit");
    assert.ok(constrainedResult.nodes.length < fullResult.nodes.length);
  } finally {
    constrained.context.dispose();
  }
  const constrainedBytes = Buffer.byteLength(JSON.stringify(encodeEngineResult({
    nextCommandId: Number.MAX_SAFE_INTEGER,
    observation: constrainedResult,
  })), "utf8");

  const exact = make();
  try {
    const result = await project(exact.executor, exact.context, exact.page, exact.before, readObservationBudget(constrainedBytes));
    const encodedBytes = Buffer.byteLength(JSON.stringify(encodeEngineResult({
      nextCommandId: Number.MAX_SAFE_INTEGER,
      observation: result,
    })), "utf8");
    assert.equal(encodedBytes, constrainedBytes);
    assert.equal(result.state, constrainedResult.state);
    assert.equal(result.newPages.length, fullResult.newPages.length);
    assert.equal(result.newPagesIncomplete, undefined);
    assert.equal(result.incompleteReason, "output_limit");
    assert.equal(result.nodes.length, constrainedResult.nodes.length);
    assert.ok(result.newPages.every((item) => item.title.length <= 128 && item.url.length <= 256));
  } finally {
    exact.context.dispose();
  }
});

test("cancellation while a known attachment is pending aborts projection", async () => {
  const { executor, page } = fixture();
  const context = new CommandContext(10_000);
  const attachment = new Promise(() => {});
  executor.pendingAttachments.add(attachment);
  seedBaseline(executor, context, ["root"]);
  executor.observeLocalFeedback = async () => observed(page);
  const operation = executor.observeAfterAction(context, page, readObservationBudget(100_000));
  await Promise.resolve();
  context.cancel();
  await assert.rejects(operation, /cancelled/);
  executor.pendingAttachments.delete(attachment);
  context.dispose();
});
