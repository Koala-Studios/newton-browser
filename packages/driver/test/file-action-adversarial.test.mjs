import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CommandContext } from "../src/command-context.ts";
import { PageExecutor } from "../src/page-executor.ts";

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function writePng(root, name) {
  const file = path.join(root, name);
  const content = Buffer.alloc(32);
  PNG_HEADER.copy(content);
  fs.writeFileSync(file, content);
  return file;
}

function temporaryRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "newton-file-action-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function defaultFacts(overrides = {}) {
  return { tag: "input", type: "file", disabled: false, multiple: false, visible: false, ...overrides };
}

function createHarness({ facts = defaultFacts(), inspect, send } = {}) {
  const controller = new AbortController();
  const calls = [];
  const wire = {
    onEvent: () => () => {},
    async send(method, params, route) {
      calls.push({ method, params, route });
      if (send) return send(method, params, route);
      if (method === "DOM.resolveNode") return { object: { objectId: "upload-object" } };
      if (method === "Runtime.callFunctionOn") return { result: { value: { count: 1, names: ["selected.png"] } } };
      return {};
    },
  };
  const connection = {
    rootTargetId: "page-1",
    epoch: "epoch-1",
    claimGeneration: 1,
    signal: controller.signal,
    wire,
    ownsBrowser: false,
    close: async () => {},
  };
  const executor = new PageExecutor(connection);
  executor.directory.registerRoute("route-1");
  executor.directory.addPage("page-1");
  executor.directory.navigate("page-1", { frameId: "frame-1", route: "route-1", loaderId: "loader-1" });
  executor.readonlyWorlds = { context: async () => 1, clear: () => {} };
  const page = executor.bindPage();
  const binding = executor.directory.binding(page, 42);
  executor.resolver = {
    resolve: async () => binding,
    inspect: inspect ?? (async () => facts),
  };
  return { executor, page, calls, binding };
}

function action(filePaths) {
  return { kind: "set_files", target: { kind: "selector", selector: "#upload" }, files: filePaths };
}

function methods(calls) {
  return calls.map((call) => call.method);
}

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function closeHarness(harness) {
  await harness.executor.close();
}

test("replacement during async target inspection is rejected before file dispatch", async (t) => {
  const root = temporaryRoot(t);
  const file = writePng(root, "selected.png");
  const harness = createHarness({
    inspect: async () => {
      fs.renameSync(file, `${file}.old`);
      writePng(root, "selected.png");
      return defaultFacts();
    },
  });
  const context = new CommandContext(1000);
  try {
    await assert.rejects(harness.executor.act(context, harness.page, action([file])), (error) => error?.code === "file_changed");
    assert.equal(context.dispatch, "not_started");
    assert.equal(methods(harness.calls).filter((method) => method === "DOM.setFileInputFiles").length, 0);
  } finally {
    context.dispose();
    await closeHarness(harness);
  }
});

test("cancellation during synchronous preparation prevents dispatch and late mutation", async (t) => {
  const root = temporaryRoot(t);
  const file = writePng(root, "cancel-preparation.png");
  const harness = createHarness();
  const context = new CommandContext(1000);
  const originalLstat = fs.lstatSync;
  let cancelled = false;
  fs.lstatSync = (...args) => {
    if (!cancelled) {
      cancelled = true;
      context.cancel();
    }
    return originalLstat(...args);
  };
  try {
    await assert.rejects(harness.executor.act(context, harness.page, action([file])), (error) => error?.code === "cancelled");
    assert.equal(context.dispatch, "not_started");
    assert.equal(methods(harness.calls).filter((method) => method === "DOM.setFileInputFiles").length, 0);
    await nextTurn();
    assert.equal(methods(harness.calls).filter((method) => method === "DOM.setFileInputFiles").length, 0);
  } finally {
    fs.lstatSync = originalLstat;
    context.dispose();
    await closeHarness(harness);
  }
});

test("cancellation during async target inspection prevents dispatch and late follow-up", async (t) => {
  const root = temporaryRoot(t);
  const file = writePng(root, "cancel-inspection.png");
  let inspectionStarted;
  const started = new Promise((resolve) => { inspectionStarted = resolve; });
  const harness = createHarness({
    inspect: async (context) => {
      inspectionStarted();
      await new Promise((_resolve, reject) => context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true }));
    },
  });
  const context = new CommandContext(1000);
  try {
    const operation = harness.executor.act(context, harness.page, action([file]));
    await started;
    context.cancel();
    await assert.rejects(operation, (error) => error?.code === "cancelled");
    assert.equal(context.dispatch, "not_started");
    await nextTurn();
    assert.deepEqual(methods(harness.calls), []);
  } finally {
    context.dispose();
    await closeHarness(harness);
  }
});

test("rejects disabled, non-file, and multiple-file actions on unsuitable inputs", async (t) => {
  const root = temporaryRoot(t);
  const cases = [
    { name: "disabled", facts: defaultFacts({ disabled: true }), files: [writePng(root, "disabled.png")] },
    { name: "non-file", facts: defaultFacts({ tag: "button", type: "submit" }), files: [writePng(root, "button.png")] },
    { name: "single input with multiple files", facts: defaultFacts({ multiple: false }), files: [writePng(root, "one.png"), writePng(root, "two.png")] },
  ];
  for (const current of cases) {
    const harness = createHarness({ facts: current.facts });
    const context = new CommandContext(1000);
    try {
      await assert.rejects(harness.executor.act(context, harness.page, action(current.files)), (error) => error?.code === "target_not_editable", current.name);
      assert.equal(context.dispatch, "not_started", current.name);
      assert.equal(methods(harness.calls).filter((method) => method === "DOM.setFileInputFiles").length, 0, current.name);
    } finally {
      context.dispose();
      await closeHarness(harness);
    }
  }
});

test("allows a uniquely targeted hidden file input but reports an accepted-name mismatch", async (t) => {
  const root = temporaryRoot(t);
  const file = writePng(root, "selected.png");
  const harness = createHarness({
    facts: defaultFacts({ visible: false }),
    send: async (method) => method === "Runtime.callFunctionOn"
      ? { result: { value: { count: 1, names: ["different.png"] } } }
      : method === "DOM.resolveNode" ? { object: { objectId: "upload-object" } } : {},
  });
  const context = new CommandContext(1000);
  try {
    const result = await harness.executor.act(context, harness.page, action([file]));
    assert.deepEqual(result, { state: "not_met", kind: "files" });
    assert.equal(context.dispatch, "acknowledged");
    assert.deepEqual(methods(harness.calls), ["DOM.setFileInputFiles", "DOM.resolveNode", "Runtime.callFunctionOn", "Runtime.releaseObject"]);
  } finally {
    context.dispose();
    await closeHarness(harness);
  }
});

test("renderer read failure after acknowledged selection stays evidence-uncertain and releases the object", async (t) => {
  const root = temporaryRoot(t);
  const file = writePng(root, "accepted.png");
  const harness = createHarness({
    send: async (method) => method === "DOM.resolveNode"
      ? { object: { objectId: "upload-object" } }
      : method === "Runtime.callFunctionOn" ? { exceptionDetails: { text: "renderer read failed" } } : {},
  });
  const context = new CommandContext(1000);
  try {
    await assert.rejects(harness.executor.act(context, harness.page, action([file])), (error) => error?.code === "evidence_unavailable");
    assert.equal(context.dispatch, "acknowledged");
    await nextTurn();
    assert.deepEqual(methods(harness.calls), ["DOM.setFileInputFiles", "DOM.resolveNode", "Runtime.callFunctionOn", "Runtime.releaseObject"]);
    assert.equal(methods(harness.calls).filter((method) => method === "DOM.setFileInputFiles").length, 1);
  } finally {
    context.dispose();
    await closeHarness(harness);
  }
});
