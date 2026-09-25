import test from "node:test";
import assert from "node:assert/strict";
import { buildTableGrid } from "../src/table-grid.ts";

const cell = (id, extra = {}) => ({ id, header: false, text: id, rowSpan: 1, colSpan: 1, ...extra });
const row = (id, cells, groupId = "body") => ({ id, cells, groupId });
const slots = (grid) => grid.rows.map((value) => value.slots);

test("multiple row and column spans preserve source identity, positions, links, and literal slots", () => {
  const input = [
    row("head", [
      cell("h1", { header: true, scope: "col", colSpan: 2, text: "Name" }),
      cell("h2", { header: true, scope: "col", text: "Status" }),
      cell("h3", { header: true, scope: "col", text: "Notes" }),
    ], "head"),
    row("r1", [
      cell("span", { rowSpan: 2, text: "spanned", links: [{ label: "Source", href: "https://example.test/source" }] }),
      cell("a", { colSpan: 2, text: "A" }),
      cell("b", { text: "B" }),
    ]),
    row("r2", [cell("c", { text: "C" }), cell("d", { text: "D" }), cell("e", { text: "E" })]),
    row("r3", [cell("f", { colSpan: 3, text: "F" }), cell("g", { text: "G" })]),
  ];
  const before = structuredClone(input);
  const grid = buildTableGrid(input);

  assert.equal(grid.state, "available");
  assert.equal(grid.columns, 4);
  assert.deepEqual(slots(grid), [
    ["h1", "h1", "h2", "h3"],
    ["span", "a", "a", "b"],
    ["span", "c", "d", "e"],
    ["f", "f", "f", "g"],
  ]);
  assert.deepEqual(grid.cells.map(({ id, row, column, effectiveRowSpan }) => ({ id, row, column, effectiveRowSpan })), [
    { id: "h1", row: 0, column: 0, effectiveRowSpan: 1 },
    { id: "h2", row: 0, column: 2, effectiveRowSpan: 1 },
    { id: "h3", row: 0, column: 3, effectiveRowSpan: 1 },
    { id: "span", row: 1, column: 0, effectiveRowSpan: 2 },
    { id: "a", row: 1, column: 1, effectiveRowSpan: 1 },
    { id: "b", row: 1, column: 3, effectiveRowSpan: 1 },
    { id: "c", row: 2, column: 1, effectiveRowSpan: 1 },
    { id: "d", row: 2, column: 2, effectiveRowSpan: 1 },
    { id: "e", row: 2, column: 3, effectiveRowSpan: 1 },
    { id: "f", row: 3, column: 0, effectiveRowSpan: 1 },
    { id: "g", row: 3, column: 3, effectiveRowSpan: 1 },
  ]);
  assert.deepEqual(grid.cells.find((value) => value.id === "span")?.links, input[1].cells[0].links);
  assert.deepEqual(input, before);
});

test("dimensions stop at the published column bound without allocating an oversized grid", () => {
  const accepted = buildTableGrid([row("r", Array.from({ length: 64 }, (_, index) => cell(`c${index}`))) ]);
  assert.equal(accepted.state, "available");
  assert.equal(accepted.columns, 64);
  assert.equal(accepted.rows[0].slots.length, 64);

  const rejected = buildTableGrid([row("r", Array.from({ length: 65 }, (_, index) => cell(`c${index}`))) ]);
  assert.deepEqual(rejected, { state: "unsupported", reason: "work_limit" });
});

test("explicit headers override scoped associations and preserve unresolved malformed references", () => {
  const grid = buildTableGrid([
    row("headers", [
      cell("column-header", { header: true, domId: "column", scope: "col", text: "Column" }),
      cell("explicit-header", { header: true, domId: "explicit", scope: "col", text: "Explicit" }),
      cell("duplicate-a", { header: true, domId: "duplicate", text: "A" }),
      cell("duplicate-b", { header: true, domId: "duplicate", text: "B" }),
    ], "head"),
    row("values", [
      cell("chosen", { explicitHeaders: ["explicit"] }),
      cell("missing", { explicitHeaders: ["missing"] }),
      cell("duplicate", { explicitHeaders: ["duplicate"] }),
      cell("self", { header: true, domId: "self", explicitHeaders: ["self"] }),
    ]),
  ]);
  assert.equal(grid.state, "available");
  const byId = new Map(grid.cells.map((value) => [value.id, value]));
  assert.deepEqual(byId.get("chosen")?.headerIds, ["explicit-header"]);
  assert.equal(byId.get("chosen")?.headersUnresolved, false);
  assert.deepEqual(byId.get("missing")?.headerIds, []);
  assert.equal(byId.get("missing")?.headersUnresolved, true);
  assert.deepEqual(byId.get("duplicate")?.headerIds, []);
  assert.equal(byId.get("duplicate")?.headersUnresolved, true);
  assert.deepEqual(byId.get("self")?.headerIds, []);
  assert.equal(byId.get("self")?.headersUnresolved, true);
});

test("row-group headers do not associate across isolated groups", () => {
  const grid = buildTableGrid([
    row("group-one-header", [cell("one-header", { header: true, scope: "rowgroup", text: "One" })], "one"),
    row("group-one-value", [cell("one-value", { text: "value one" })], "one"),
    row("group-two-header", [cell("two-header", { header: true, scope: "rowgroup", text: "Two" })], "two"),
    row("group-two-value", [cell("two-value", { text: "value two" })], "two"),
  ]);
  assert.equal(grid.state, "available");
  const byId = new Map(grid.cells.map((value) => [value.id, value]));
  assert.deepEqual(byId.get("one-value")?.headerIds, ["one-header"]);
  assert.deepEqual(byId.get("two-value")?.headerIds, ["two-header"]);
  assert.equal(byId.get("one-value")?.headerIds.includes("two-header"), false);
  assert.equal(byId.get("two-value")?.headerIds.includes("one-header"), false);
});

test("blank and empty cells remain source cells and empty logical slots remain null", () => {
  const input = [
    row("first", [cell("blank", { text: "" }), cell("spaces", { text: "   " })]),
    row("second", []),
  ];
  const grid = buildTableGrid(input);
  assert.equal(grid.state, "available");
  assert.deepEqual(slots(grid), [["blank", "spaces"], [null, null]]);
  assert.deepEqual(grid.cells.map(({ id, text }) => ({ id, text })), [
    { id: "blank", text: "" },
    { id: "spaces", text: "   " },
  ]);
});

test("duplicate row and cell identities remain explicit unsupported structures", () => {
  assert.deepEqual(buildTableGrid([row("same", [cell("a")]), row("same", [cell("b")])]), {
    state: "unsupported",
    reason: "duplicate_identity",
  });
  assert.deepEqual(buildTableGrid([row("r", [cell("same"), cell("same")])]), {
    state: "unsupported",
    reason: "duplicate_identity",
  });
});
