import test from "node:test";
import assert from "node:assert/strict";
import { SessionEngine } from "../src/session-engine.ts";

const pageOne = { pageId: "p1", frameId: "f1", documentGeneration: 1 };
const control = (recordId, ref, name = recordId) => ({
  kind: "control", recordId, ref, role: "textbox", name, readonly: false, disabled: false,
});
const field = (recordId, ref, name) => ({
  recordId, ref, role: "textbox", name, readonly: false, disabled: false,
});
const form = (ref, nameRef, emailRef, name = "Profile") => ({
  kind: "form", recordId: "form", ref, name, complete: true,
  fields: [field("name", nameRef, "Name"), field("email", emailRef, "Email")],
});

function harness() {
  let snapshot = 0;
  let records = [];
  let state = "available";
  let page = { ...pageOne };
  const engine = new SessionEngine("record-delta-adversarial", {
    bindPage: () => page,
    close: async () => {},
    act: async () => ({ state: "not_requested" }),
    observe: async () => ({
      state,
      trust: "untrusted_page_content",
      scope: "page",
      nodes: [],
      records,
      snapshotId: `s${++snapshot}`,
    }),
  });
  return {
    engine,
    setRecords(value) { records = value; },
    setState(value) { state = value; },
    setPage(value) { page = value; },
  };
}

function applyDelta(baseline, delta) {
  const records = new Map(baseline.map((record) => [record.recordId, structuredClone(record)]));
  for (const recordId of delta.removed) records.delete(recordId);
  for (const record of [...delta.added, ...delta.changed]) records.set(record.recordId, structuredClone(record));
  for (const update of delta.refs ?? []) {
    const record = records.get(update.recordId);
    if (record) record.ref = update.ref;
    else {
      const owner = [...records.values()].find((value) => value.kind === "form" && value.fields.some((fieldValue) => fieldValue.recordId === update.recordId));
      owner?.fields.find((fieldValue) => fieldValue.recordId === update.recordId) && (owner.fields.find((fieldValue) => fieldValue.recordId === update.recordId).ref = update.ref);
    }
  }
  return delta.order.map((recordId) => records.get(recordId));
}

test("mixed control and form deltas reconstruct with fresh refs for every actionable field", async () => {
  const h = harness();
  h.setRecords([
    control("changed", "c1", "Before"),
    form("form1", "name1", "email1"),
    control("removed", "r1"),
    control("unchanged", "u1"),
  ]);
  const first = await h.engine.observe({ mode: "records", recordShape: "form" });
  const wanted = [
    control("unchanged", "u2"),
    form("form2", "name2", "email2"),
    control("changed", "c2", "After"),
    control("added", "a1", "Added"),
  ];
  h.setRecords(wanted);
  const next = await h.engine.observe({ mode: "records", recordShape: "form", previousSnapshotId: first.snapshotId });

  assert.equal(next.state, "available");
  assert.equal(next.delta.reset, false);
  assert.deepEqual(next.delta.removed, ["removed"]);
  assert.deepEqual(next.delta.changed.map((record) => record.recordId), ["changed"]);
  assert.deepEqual(next.delta.added.map((record) => record.recordId), ["added"]);
  assert.deepEqual(next.delta.refs, [
    { recordId: "unchanged", ref: "u2" },
    { recordId: "form", ref: "form2" },
    { recordId: "name", ref: "name2" },
    { recordId: "email", ref: "email2" },
  ]);
  assert.deepEqual(next.delta.order, ["unchanged", "form", "changed", "added"]);
  assert.deepEqual(applyDelta(first.records, next.delta), wanted);
});

test("scope and record-shape changes reset instead of applying an incompatible delta", async () => {
  const h = harness();
  const records = [control("a", "a1")];
  h.setRecords(records);
  const scopeA = { kind: "selector", selector: "#first" };
  const scopeB = { kind: "selector", selector: "#second" };
  const first = await h.engine.observe({ mode: "records", recordShape: "controls", scope: scopeA });
  const scopeReset = await h.engine.observe({ mode: "records", recordShape: "controls", scope: scopeB, previousSnapshotId: first.snapshotId });
  assert.equal(scopeReset.delta.reset, true);
  assert.equal(scopeReset.delta.resetReason, "incompatible_scope");
  assert.deepEqual(scopeReset.records, records);

  const shapeFirst = await h.engine.observe({ mode: "records", recordShape: "controls", scope: scopeA });
  const shapeReset = await h.engine.observe({ mode: "records", recordShape: "links", scope: scopeA, previousSnapshotId: shapeFirst.snapshotId });
  assert.equal(shapeReset.delta.reset, true);
  assert.equal(shapeReset.delta.resetReason, "incompatible_scope");
  assert.deepEqual(shapeReset.records, records);
});

test("page and document-generation changes reset the baseline", async () => {
  const h = harness();
  h.setRecords([control("a", "a1")]);
  const first = await h.engine.observe({ mode: "records" });

  h.setPage({ pageId: "p2", frameId: "f2", documentGeneration: 1 });
  const pageReset = await h.engine.observe({ mode: "records", previousSnapshotId: first.snapshotId });
  assert.equal(pageReset.delta.reset, true);
  assert.equal(pageReset.delta.resetReason, "document_changed");

  h.setPage({ pageId: "p2", frameId: "f2", documentGeneration: 2 });
  const generationReset = await h.engine.observe({ mode: "records", previousSnapshotId: pageReset.snapshotId });
  assert.equal(generationReset.delta.reset, true);
  assert.equal(generationReset.delta.resetReason, "document_changed");
});

test("an incomplete baseline resets when a complete view becomes available", async () => {
  const h = harness();
  h.setRecords([control("a", "a1")]);
  h.setState("incomplete");
  const incomplete = await h.engine.observe({ mode: "records" });
  h.setState("available");
  const reset = await h.engine.observe({ mode: "records", previousSnapshotId: incomplete.snapshotId });

  assert.equal(reset.delta.reset, true);
  assert.equal(reset.delta.resetReason, "incomplete_view");
  assert.deepEqual(reset.records, [control("a", "a1")]);
});

test("a baseline is usable through two newer snapshots, then resets after eviction", async () => {
  const h = harness();
  h.setRecords([control("a", "a1")]);
  const first = await h.engine.observe({ mode: "records" });
  const second = await h.engine.observe({ mode: "records" });
  const third = await h.engine.observe({ mode: "records", previousSnapshotId: first.snapshotId });
  assert.equal(third.delta.reset, false);

  const evicted = await h.engine.observe({ mode: "records", previousSnapshotId: first.snapshotId });
  assert.equal(evicted.delta.reset, true);
  assert.equal(evicted.delta.resetReason, "baseline_unavailable");
  assert.deepEqual(evicted.records, [control("a", "a1")]);
  assert.notEqual(second.snapshotId, third.snapshotId);
});

test("a small output budget returns a bounded honest result rather than a partial delta", async () => {
  const h = harness();
  h.setRecords([control("base", "base-ref", "Base")]);
  const first = await h.engine.observe({ mode: "records" });
  h.setRecords(Array.from({ length: 20 }, (_, index) => control(`large-${index}`, `ref-${index}`, "Large record ".repeat(80))));
  const result = await h.engine.observe({ mode: "records", maxBytes: 2048, previousSnapshotId: first.snapshotId });

  assert.equal(result.state, "unavailable");
  assert.equal(result.errorCode, "output_budget");
});
