import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  enforceObservationBudget,
  normalizeActionResult,
  normalizeObservationOptions,
  projectCompactObservation,
  projectLeanObservation,
  normalizeAgentActionResult,
} from "../src/agent-output.ts";
import {
  estimateTokensFromString,
  serializeForBudget,
} from "../../../scripts/evals/token-budget.mjs";
import {
  parseFixtureCase,
  measureObservationCase,
  measureDeferredCase,
  runMeasurement,
  readFixtures,
} from "../../../scripts/measure-agent-cost.mjs";

const fixtureDir = path.join(process.cwd(), "test", "evals", "agent-output-fixtures");
const compactFixture = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "test", "evals", "agent-output-fixtures", "compact-observation.json"), "utf8"),
);
const leanFixture = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "test", "evals", "agent-output-fixtures", "lean-observation.json"), "utf8"),
);
const workflowFixture = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "test", "evals", "agent-output-fixtures", "workflow.json"), "utf8"),
);

const sample = {
  kind: "observation",
  mode: "cdp",
  origin: "https://example.com/shop",
  title: "Checkout",
  capturedAt: "2024-01-01T00:00:00.000Z",
  nodeCount: 4,
  truncated: false,
  actionStatus: "completed",
  verified: true,
  reason: "ready",
  nodes: [
    { ref: "n-01", role: "textbox", name: "Email", value: "alice@example.org" },
    { ref: "n-02", role: "button", name: "Continue" },
  ],
};

function readFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(process.cwd(), "test", "evals", "agent-output-fixtures", name), "utf8"));
}

test("normalizeObservationOptions defaults are compact and bounded", () => {
  const normalized = normalizeObservationOptions({});
  assert.equal(normalized.format, "compact");
  assert.equal(normalized.includeGeometry, false);
  assert.equal(normalized.limit, 80);
  assert.equal(normalized.roles.length, 0);
  assert.equal(normalized.query, "");
});

test("normalizeObservationOptions normalizes roles/query and caps limit", () => {
  const normalized = normalizeObservationOptions({
    format: "json",
    includeGeometry: true,
    query: "Button",
    limit: "2000",
    roles: ["Button", "button", "textbox", "link", "heading", "image", "input", "form", "extra"],
  });

  assert.equal(normalized.format, "json");
  assert.equal(normalized.includeGeometry, true);
  assert.equal(normalized.query, "button");
  assert.equal(normalized.limit, 200);
  assert.equal(normalized.roles.includes("button"), true);
  assert.equal(normalized.roles.includes("textbox"), true);
  assert.equal(normalized.roles.length <= 12, true);
});

test("query normalization lowers case for matcher safety", () => {
  const normalized = normalizeObservationOptions({ query: "AbC\nEmail" });
  assert.equal(normalized.query, "abc email");
});

test("redaction runs before role/query matching", () => {
  const projection = projectLeanObservation(
    {
      ...sample,
      nodes: [{ ref: "sensitive", role: "textbox", name: "User email", value: "alice@example.org" }],
    },
    { query: "alice@example.org" },
  );

  assert.equal(projection.ok, true);
  assert.equal((projection.projection.nodes as Array<unknown>).length, 0);
});

test("measurement observation case reads root format and limit", () => {
  const raw = {
    id: "measurement-root-case",
    caseType: "observation",
    format: "json",
    limit: 2,
    maxTokens: 500,
    input: {
      kind: "observation",
      mode: "cdp",
      origin: "https://shop.example/checkout",
      title: "Checkout",
      capturedAt: "2024-01-01T00:00:00.000Z",
      nodeCount: 3,
      truncated: false,
      nodes: [
        { ref: "n1", role: "textbox", name: "Email", value: "alice@example.org" },
        { ref: "n2", role: "button", name: "Continue" },
        { ref: "n3", role: "button", name: "Checkout" },
      ],
    },
  };

  const parsed = parseFixtureCase(raw);
  const measured = measureObservationCase(parsed);
  assert.equal(measured.format, "json");
  assert.equal(measured.type, "observation");
  assert.equal(measured.status, "deferred");
  assert.equal("tokens" in measured, false);
  assert.equal(typeof measured.bytes, "number");
});

test("measurement parser rejects malformed case fields instead of defaulting", () => {
  assert.throws(
    () =>
      parseFixtureCase({
        id: "invalid-case",
        caseType: "observation",
        format: "compact",
        options: { format: "json" },
        input: {
          kind: "observation",
          mode: "cdp",
          origin: "https://shop.example/checkout",
          title: "Checkout",
          capturedAt: "2024-01-01T00:00:00.000Z",
          nodeCount: 1,
          truncated: false,
          nodes: [{ ref: "a", role: "heading", name: "Checkout" }],
        },
        maxTokens: 200,
      }),
    /unsupported field/,
  );
});

test("measurement deferred case is explicitly non-pass", () => {
  const parsed = parseFixtureCase({
    id: "deferred-measure",
    caseType: "deferred",
    reason: "defer: catalog benchmark",
    maxTokens: 3000,
  });
  const measured = measureDeferredCase(parsed);
  assert.equal(measured.status, "deferred");
  assert.equal("pass" in measured, false);
});

test("compact output line-escapes page content", () => {
  const hostile = 'quote" in\nvalue\\ with [brackets] and \\u2028line';
  const projection = projectCompactObservation(
    {
      ...sample,
      nodes: [{ ref: "n-1", role: "button", name: hostile, value: hostile }],
    },
    { includeGeometry: true },
  );
  assert.equal(projection.ok, true);
  const output = projection.projection.output;
  assert.equal(output.includes(hostile), false);
  assert.equal(output.includes("\\\""), true);
  assert.equal(/[\n\r]/.test(output), true);
});

test("compact output escapes title and origin for output safety", () => {
  const projection = projectCompactObservation(
    {
      ...sample,
      title: 'line"\nwith\nquote',
      origin: "https://example.com",
      nodes: [{ ref: "n-1", role: "textbox", name: "Email", value: "v" }],
    },
    {},
  );

  assert.equal(projection.ok, true);
  assert.equal(projection.projection.output.includes("\\\""), true);
  assert.match(projection.projection.output, /^page trust=untrusted_page_content title="line\\" with quote" origin="https:\/\/example\.com" observation$/m);
});

test("geometry is omitted by default", () => {
  const projection = projectLeanObservation(
    {
      ...sample,
      nodes: [{ ref: "n-g", role: "button", name: "Open", bbox: { x: 10, y: 20, width: 30, height: 40 } }],
    },
  );
  assert.equal(projection.ok, true);
  assert.equal("geometry" in ((projection.projection.nodes as any)[0] ?? {}), false);
});

test("geometry appears only when includeGeometry is true", () => {
  const projection = projectLeanObservation(
    {
      ...sample,
      nodes: [{ ref: "n-g", role: "button", name: "Open", bbox: { x: 10, y: 20, width: 30, height: 40 } }],
    },
    { includeGeometry: true },
  );
  assert.equal(projection.ok, true);
  assert.equal((projection.projection.nodes as any)[0].geometry !== undefined, true);
});

test("compact and JSON observations preserve bounded excluded-frame provenance", () => {
  const input = {
    ...sample,
    excludedFrames: [
      { frameId: "frame-cross", frameOrigin: "https://cross.example", reason: "origin_not_granted" },
      { frameId: "", frameOrigin: "https://ignored.example", reason: "origin_not_granted" },
    ],
  };
  const compact = projectCompactObservation(input);
  const json = projectLeanObservation(input);
  assert.equal(compact.ok, true);
  assert.equal(json.ok, true);
  const expected = [{ frameId: "frame-cross", frameOrigin: "https://cross.example", reason: "origin_not_granted" }];
  assert.deepEqual(compact.projection.excludedFrames, expected);
  assert.deepEqual(json.projection.excludedFrames, expected);
});

test("compact and lean projections preserve rich state and target provenance", () => {
  const rich = {
    ...sample,
    nodes: [{
      ref: "d4:fchild:e9", role: "checkbox", name: "Terms", checked: "mixed", selected: false,
      expanded: true, disabled: false, required: true, level: 2, href: "https://shop.example/terms",
      elementType: "input:checkbox", documentEpoch: 4, frameId: "child", frameOrigin: "https://shop.example",
    }],
    nodeCount: 1,
  };
  const compact = projectCompactObservation(rich);
  const lean = projectLeanObservation(rich);
  assert.equal(compact.ok, true);
  assert.equal(lean.ok, true);
  if (!compact.ok || !lean.ok) assert.fail("rich observations must project");
  assert.match(compact.projection.output ?? "", /checked="mixed"/);
  assert.match(compact.projection.output ?? "", /frame=/);
  assert.equal((lean.projection.nodes[0] as any).required, true);
  assert.equal((lean.projection.nodes[0] as any).documentEpoch, 4);
  assert.equal((lean.projection.nodes[0] as any).elementType, "input:checkbox");
});

test("dedupe removes duplicate semantic rows while preserving first ref order", () => {
  const projection = projectLeanObservation(
    {
      ...sample,
      nodeCount: 4,
      nodes: [
        { ref: "a", role: "button", name: "A" },
        { ref: "a", role: "button", name: "A" },
        { ref: "b", role: "textbox", name: "B" },
        { ref: "c", role: "checkbox", name: "C" },
      ],
    },
    {},
  );

  assert.equal(projection.ok, true);
  assert.deepEqual((projection.projection.nodes as Array<{ ref: string }>).map((node) => node.ref), ["a", "b", "c"]);
});

test("query and role filtering are deterministic and stable", () => {
  const projection = projectLeanObservation(
    {
      ...sample,
      nodes: [
        { ref: "a", role: "textbox", name: "User email" },
        { ref: "b", role: "button", name: "Save" },
        { ref: "c", role: "button", name: "Cancel" },
      ],
    },
    { roles: ["button"], query: "save" },
  );

  assert.equal(projection.ok, true);
  assert.deepEqual((projection.projection.nodes as Array<{ ref: string }>).map((node) => node.ref), ["b"]);
});

test("budget uses source nodeCount and reports omitted/truncation from source", () => {
  const projection = projectLeanObservation(
    {
      ...sample,
      nodeCount: 10,
      nodes: [
        { ref: "1", role: "button", name: "A" },
        { ref: "2", role: "button", name: "B" },
        { ref: "3", role: "button", name: "C" },
        { ref: "4", role: "button", name: "D" },
      ],
    },
    { limit: 2 },
  );

  assert.equal(projection.ok, true);
  assert.equal(projection.projection.budget.nodesScanned, 10);
  assert.equal(projection.projection.budget.nodesReturned, 2);
  assert.equal(projection.projection.budget.nodesOmitted, 8);
  assert.equal(projection.projection.budget.truncated, true);
});

test("continuation hint is bounded and useful", () => {
  const projection = projectCompactObservation(
    {
      ...sample,
      nodes: [
        { ref: "1", role: "button", name: "Alpha" },
        { ref: "2", role: "button", name: "Beta" },
        { ref: "3", role: "button", name: "Gamma" },
      ],
      nodeCount: 6,
    },
    { limit: 1, roles: ["button"], query: "a" },
  );

  assert.equal(projection.ok, true);
  assert.equal(Boolean((projection.projection as any).budget.continuation), true);
  const continuation = (projection.projection as any).budget.continuation;
  if (continuation) {
    assert.equal(continuation.tool, "browser.observe");
    assert.equal(continuation.strategy, "raise_limit");
    assert.equal(continuation.reason, "node_limit");
    assert.equal(continuation.arguments.limit, 2);
    assert.equal(continuation.arguments.roles?.length, 1);
    assert.equal(continuation.arguments.query, "a");
  }
});

test("source truncation suggests query-or-role refinement", () => {
  const projection = projectCompactObservation(
    {
      ...sample,
      nodeCount: 10,
      truncated: true,
      nodes: [{ ref: "1", role: "button", name: "Alpha" }],
    },
    { limit: 2, roles: ["button"] },
  );
  const continuation = projection.projection.budget.continuation;
  assert.equal(projection.ok, true);
  assert.equal(projection.projection.budget.truncated, true);
  assert.equal(continuation?.strategy, "refine_query_or_roles");
});

test("observation_text json keeps plain string and compact serializes safely", () => {
  const observationText = {
    kind: "observation_text",
    mode: "text",
    origin: "https://example.com",
    title: "Debug",
    capturedAt: "2024-01-01T00:00:00.000Z",
    text: 'line1\nline2"quote"',
    nodeCount: 1,
    truncated: false,
  };

  const json = projectLeanObservation(observationText, { format: "json" });
  assert.equal(json.ok, true);
  assert.equal(typeof (json.projection as any).text, "string");
  assert.equal((json.projection as any).text.includes("\n"), false);
  assert.equal((json.projection as any).text.includes("\\n"), false);
  assert.equal((json.projection as any).text.includes("\""), true);

  const compact = projectCompactObservation(observationText);
  assert.equal(compact.ok, true);
  assert.equal(compact.projection.output.includes("line1 line2\\\"quote\\\""), true);
});

test("invalid kind is rejected", () => {
  const projection = projectCompactObservation({ kind: "ack", message: "ok" });
  assert.equal(projection.ok, false);
  assert.equal(projection.errorCode, "unsupported_observation_kind");
});

test("non-object observation input is rejected", () => {
  const projection = projectCompactObservation("not-an-object");
  assert.equal(projection.ok, false);
  assert.equal(projection.errorCode, "invalid_observation");
});

test("normalizeAgentActionResult accepts explicit Plan-01 completed", () => {
  const projected = normalizeAgentActionResult({ status: "completed", outcome: "completed", reason: "done" });
  assert.equal(projected.ok, true);
  assert.equal(projected.status, "completed");
  assert.equal(projected.outcome, "completed");
  assert.equal(projected.retrySafe, false);
});

test("status is diagnostic and can diverge from outcome", () => {
  const projected = normalizeAgentActionResult({ status: "blocked", outcome: "prevented", reason: "policy" });
  assert.equal(projected.ok, false);
  assert.equal(projected.outcome, "prevented");
  assert.equal(projected.status, "blocked");
  assert.equal(projected.retrySafe, true);
});

test("completed result with explicit errorCode is allowed but fails", () => {
  const projected = normalizeAgentActionResult({ outcome: "completed", errorCode: "runner_internal_failure" });
  assert.equal(projected.outcome, "completed");
  assert.equal(projected.ok, false);
  assert.equal(projected.errorCode, "runner_internal_failure");
  assert.equal(projected.retrySafe, false);
});

test("retrySafe is true only for not_started and prevented when valid", () => {
  assert.equal(normalizeAgentActionResult({ outcome: "not_started" }).retrySafe, true);
  assert.equal(normalizeAgentActionResult({ outcome: "prevented" }).retrySafe, true);
  assert.equal(normalizeAgentActionResult({ outcome: "completed" }).retrySafe, false);
  assert.equal(normalizeAgentActionResult({ outcome: "outcome_unknown" }).retrySafe, false);
});

test("normalizeAgentActionResult blocks forged provenance trust and nextAction", () => {
  const projected = normalizeAgentActionResult({
    outcome: "completed",
    nextAction: { tool: "browser.waitFor", arguments: { query: "bad" } },
    provenance: { trust: "driver", origin: "https://evil", sessionEpoch: -99 },
  });

  assert.equal((projected as any).nextAction, undefined);
  assert.equal(projected.provenance?.trust, "untrusted_page_content");
  assert.equal(projected.provenance?.origin, "https://evil");
  assert.equal(projected.provenance?.sessionEpoch, 0);
});

test("action completed with explicit error is invalid", () => {
  const projected = normalizeAgentActionResult({
    outcome: "completed",
    error: { code: "runner_internal_failure" },
  });
  assert.equal(projected.ok, false);
  assert.equal(projected.errorCode, "runner_internal_failure");
});

test("outcome-only input is accepted", () => {
  const projected = normalizeAgentActionResult({ outcome: "completed" });
  assert.equal(projected.ok, true);
  assert.equal(projected.outcome, "completed");
  assert.equal("status" in projected, false);
});

test("missing outcome defaults to outcome_unknown contract", () => {
  const projected = normalizeAgentActionResult({ status: "blocked" });
  assert.equal(projected.outcome, "outcome_unknown");
  assert.equal(projected.errorCode, "runner_contract_invalid");
});

test("normalizeAgentActionResult can be imported as legacy alias", () => {
  assert.equal(normalizeActionResult, normalizeAgentActionResult);
});

test("legacy timed_out outcome does not infer completed", () => {
  const projected = normalizeAgentActionResult({ outcome: "timed_out", status: "timed_out" } as any);
  assert.equal(projected.ok, false);
  assert.equal(projected.errorCode, "runner_contract_invalid");
  assert.equal(projected.outcome, "outcome_unknown");
});

test("enforceObservationBudget computes bounds on source count and truncated flag", () => {
  const { budget } = enforceObservationBudget(
    [{}, {}, {}],
    { format: "compact", includeGeometry: false, query: "", roles: [], limit: 2 },
    10,
    true,
  );
  assert.equal(budget.nodesScanned, 10);
  assert.equal(budget.nodesReturned, 2);
  assert.equal(budget.nodesOmitted, 8);
  assert.equal(budget.truncated, true);
  assert.equal(Boolean(budget.continuation), true);
});

test("compact fixture is projectable", () => {
  const parsed = parseFixtureCase(compactFixture, path.join(fixtureDir, "compact-observation.json"));
  const result = projectCompactObservation(parsed.input, { format: parsed.format, limit: parsed.limit });
  assert.equal(result.ok, true);
  assert.equal(result.projection.format, "compact");
  assert.equal(Array.isArray(result.projection.nodes), true);
});

test("lean fixture is projectable", () => {
  const parsed = parseFixtureCase(leanFixture, path.join(fixtureDir, "lean-observation.json"));
  const result = projectLeanObservation(parsed.input, { format: parsed.format, limit: parsed.limit });
  assert.equal(result.ok, true);
  assert.equal(result.projection.format, "json");
});

test("workflow fixture exercises observation/action budgets", () => {
  const workflowParsed = parseFixtureCase(workflowFixture, path.join(fixtureDir, "workflow.json"));
  const steps = workflowParsed.steps ?? [];
  let observed = 0;
  let actions = 0;
  for (const step of steps) {
    if (step.type === "observation") {
      const result = step.options?.format === "json" ? projectLeanObservation(step.input, step.options) : projectCompactObservation(step.input, step.options);
      assert.equal(result.ok, true);
      observed += 1;
    } else if (step.type === "action") {
      const result = normalizeAgentActionResult(step.input);
      actions += 1;
      assert.equal(result.ok, true);
    }
  }
  assert.equal(observed > 0, true);
  assert.equal(actions > 0, true);
});

test("serialize helper is deterministic", () => {
  assert.equal(serializeForBudget({ b: 1, a: 2 }), JSON.stringify({ a: 2, b: 1 }));
});

test("token estimate prefers injectable counter", () => {
  const counted = estimateTokensFromString("hello", () => 9);
  assert.equal(counted.method, "token_counter");
  assert.equal(counted.count, 9);
});

test("fallback token estimate is utf8 byte upper bound", () => {
  const hostile = "\u{1F680}".repeat(60000);
  const counted = estimateTokensFromString(hostile);
  assert.equal(counted.method, "utf8_byte_upper_bound");
  assert.equal(counted.origin, "heuristic");
  assert.equal(counted.count, Buffer.byteLength(hostile, "utf8"));
  assert.equal(counted.count > 200000, true);
});

test("observation_text budget helper is stable for empty list", () => {
  const { budget } = enforceObservationBudget([], { format: "compact", limit: 2, query: "", roles: [], includeGeometry: false }, 0, false);
  assert.equal(budget.nodesScanned, 0);
  assert.equal(budget.nodesReturned, 0);
  assert.equal(budget.nodesOmitted, 0);
});

test("projection header preserves title and avoids origin duplication", () => {
  const fixture = readFixture("compact-observation.json");
  const parsed = parseFixtureCase(fixture, path.join(fixtureDir, "compact-observation.json"));
  const result = projectCompactObservation(parsed.input, { format: "compact", limit: 2 });
  assert.equal(result.ok, true);
  const output = (result.projection as any).output;
  assert.equal(output.includes("trust=untrusted_page_content title=\"Checkout\""), true);
  assert.equal(output.includes(`origin=${JSON.stringify(new URL(parsed.input.origin).origin)}`), true);
});

test("projection keeps base fields for MCP result shapes", () => {
  const projection = projectCompactObservation(sample);
  assert.equal(projection.ok, true);
  assert.equal(typeof projection.projection.origin, "string");
  assert.equal(projection.projection.trust, "untrusted_page_content");
  assert.equal(typeof projection.projection.mode, "string");
  assert.equal(typeof projection.projection.nodeCount, "number");
  assert.equal(typeof projection.projection.capturedAt, "string");
  assert.equal(typeof projection.projection.title, "string");
});

test("measurement parser resolves shared inputRef and keeps compact/lean parity", async () => {
  const compactParsed = parseFixtureCase(compactFixture, path.join(fixtureDir, "compact-observation.json"));
  const leanParsed = parseFixtureCase(leanFixture, path.join(fixtureDir, "lean-observation.json"));
  const compactResult = await runMeasurement({ fixtureRoot: fixtureDir, tokenCounter: undefined });
  const compactProjected = measureObservationCase(compactParsed);
  const leanProjected = measureObservationCase(leanParsed);

  assert.equal(compactProjected.type, "observation");
  assert.equal(leanProjected.type, "observation");
  assert.equal(compactProjected.format, "compact");
  assert.equal(leanProjected.format, "json");
  assert.equal((compactProjected as any).status, "deferred");
  assert.equal((leanProjected as any).status, "deferred");
  assert.equal("tokens" in compactProjected, false);
  assert.equal("tokens" in leanProjected, false);
  assert.equal(compactResult.results.some((entry) => entry.id === "tool-catalog"), true);
  const toolCatalog = compactResult.results.find((entry) => entry.id === "tool-catalog");
  assert.equal(toolCatalog?.status, "pass");
  assert.equal(compactResult.status, "pass");
  assert.equal(compactResult.passed, true);
});

test("measurement rejects malformed case payloads from malformed fixtures", () => {
  const parsed = readFixtures(fixtureDir);
  assert.equal(Array.isArray(parsed), true);
  assert.equal(parsed.some((entry) => entry.caseType === "invalid"), false);
});


