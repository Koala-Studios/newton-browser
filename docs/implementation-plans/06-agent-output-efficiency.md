# Plan 06 — Agent Output and Token Efficiency

- **Status:** Complete
- **Depends on:** Plan 01 result contract
- **Primary outcome:** The default agent workflow carries the minimum tokens needed to select and verify actions, without weakening Newton’s internal observation model or safety evidence.

## Why this is a must-do

The audit found Newton’s tool catalog already much smaller than agent-browser’s core catalog, but Newton loses that advantage in repeated observation and verbose action envelopes. The measured prototype reduced a representative observation from about 2,462 tokens to 682 and the estimated workflow from about 3,800 to about 1,900. This plan turns that finding into a stable, tested contract.

## Files

### Add

- `apps/mcp-server/src/agent-output.ts` — compact observation renderer, lean JSON projection, action result projection, and truncation policy.
- `apps/mcp-server/test/agent-output.test.ts`.
- `scripts/measure-agent-cost.mjs` — deterministic fixture and tool-catalog measurement.
- `test/evals/agent-output-fixtures/` — versioned semantic/token snapshots.

### Edit

- `packages/core/src/protocol.ts` — observation/output options and compact result types.
- `packages/core/src/redaction.ts` — run before every public renderer and preserve redaction markers.
- `packages/driver/src/driver.ts` and `packages/driver/test/driver.test.js` — enrich the internal AX model without changing its safety boundary.
- `apps/mcp-server/src/mcp-server.ts` — expose output controls and remove duplicated envelope fields.
- `apps/mcp-server/test/host.test.ts` and existing fixture tests.
- `README.md`, `docs/MCP_CLIENTS.md`, `docs/DECISIONS.md`, and `test/evidence/qa-ledger.md`.

### Delete

- Duplicated action summary fields once compatibility tests prove the compact envelope contains the same decision and outcome.
- No internal driver observation fields are deleted; projection happens only at the MCP boundary.

## Public contract

### `browser.observe`

Add optional arguments:

```ts
type ObserveOptions = {
  format?: "compact" | "json";       // default: "compact"
  includeGeometry?: boolean;          // default: false
  query?: string;                     // existing driver filter, now public
  roles?: string[];
  limit?: number;
};
```

`compact` is the default for the next minor contract version. `json` remains an explicit compatibility and diagnostics format. Geometry, timestamps, target metadata, and repeated session identifiers appear only when requested or required to disambiguate a target.

Before projection, enrich the internal observation with the state agents currently need
repair calls to recover:

- checked, selected, expanded, disabled, required, heading level, and value state;
- sanitized same-origin `href` destination and element type;
- frame/document provenance and reference epoch;
- optional structural landmarks/headings;
- an optional interactive heuristic for elements missing from AX.

Interactive discovery must use CDP DOM traversal or isolated-world computation without
writing attributes into the application DOM. It must not copy the page-mutating cursor
discovery pattern from agent-browser.

Example compact observation:

```text
page "Checkout" https://shop.example/checkout
- heading "Checkout" [ref=d3:e4]
- textbox "Email" [ref=d3:e9] value=""
- button "Pay now" [ref=d3:e12] disabled=false
```

Values are JSON-escaped; redacted values keep explicit markers. A line renderer must never interpolate unescaped page text into control syntax.

### Action results

Return one normalized envelope:

```ts
type AgentActionResult = {
  ok: boolean;
  status: string;
  outcome: "not_started" | "completed" | "prevented" | "outcome_unknown";
  decision?: { code: string; reason?: string };
  changed?: boolean;
  delta?: string[];
  nextAction?: { tool: string; arguments: Record<string, unknown> };
  provenance?: { trust: "untrusted_page_content"; origin: string; sessionEpoch: number };
};
```

Do not repeat `status`, origin, changed-state, or decision text in nested `data`, `summary`, and `details` objects.

### Fewer mandatory round trips

- `browser.session.start` gains `observe?: ObserveOptions | false`, returning an initial observation in the same result when requested.
- `browser.status` gains `detail?: "compact" | "full"`, defaulting to compact.
- Successful actions return a scoped delta when it can be computed cheaply; full observation remains explicit when the page changed substantially or target identity is uncertain.

## Rendering pipeline

```ts
const safe = redactObservation(fullDriverObservation, sessionPolicy);
const filtered = applyObservationQuery(safe, request);
const projected = request.format === "json"
  ? toLeanJson(filtered, request)
  : toCompactLines(filtered, request);
return enforceOutputBudget(projected, request.limit);
```

Redaction precedes filtering and formatting. Truncation must be deterministic and include counts plus a typed continuation hint; silently dropping nodes is forbidden.

Full diagnostic output records `nodesScanned`, `nodesReturned`, serialized bytes,
capture duration, and truncation reason. Compact agent output omits these metrics unless
requested.

## Token budgets

Measurements use a checked-in fixture serialized exactly as MCP returns it, with one pinned tokenizer version used only in development/tests. Runtime has no tokenizer, model-provider request, telemetry, or adaptive model call.

- Tool catalog: at most 3,000 `o200k_base` tokens.
- Initial compact observation: at most 800 tokens for the representative fixture.
- Lean JSON observation: at most 1,050 tokens for the same fixture.
- Fill result: at most 100 tokens.
- Click result: at most 125 tokens.
- Start → inspect → fill → click → verify workflow: at most 2,100 tokens.

The fixture and tokenizer version are part of the assertion so budget movement is intentional and reviewable.

## Implementation slices

1. Enrich the internal AX model and add safe-interactive-discovery tests.
2. Add pure renderers and semantic-equivalence tests.
3. Publish query, role, geometry, and format options.
4. Replace duplicated action envelopes with the shared projector.
5. Add start-with-observe and compact status.
6. Add deterministic measurements and budget gates.
7. Update README/MCP examples to teach the least-token successful flow.

## Required tests

- Compact and lean JSON preserve actionable role, name, value/state, ref, origin, and trust metadata.
- Geometry is absent by default and present only when requested.
- Rich AX states, sanitized same-origin href, element type, and frame/document provenance
  survive both renderers when applicable.
- Interactive discovery causes zero main-DOM mutations and zero MutationObserver records.
- Repeated nodes and target metadata are deduplicated without losing frame disambiguation.
- Redaction occurs identically in compact and JSON outputs.
- Newlines, brackets, quotes, and control text from the page cannot forge compact records.
- Truncation is deterministic and exposes omitted counts/continuation guidance.
- Session start can include the initial observation without a second command.
- Action deltas do not claim completion when the Plan 01 outcome is uncertain.
- Every checked-in budget passes on Windows and Linux without network access.

## Exit criteria

- The representative end-to-end workflow is at or below 2,100 measured tokens.
- No internal driver evidence was removed to achieve the reduction.
- Compact is the documented default and JSON remains available.
- Agents can query/refine observations without receiving the full tree.
- The root suite, packed artifacts, and budget script pass.

## Rollback

The MCP renderer can temporarily default back to `json`, but the measurement fixtures and explicit `format` option must remain. Never roll back by removing tests or silently increasing budgets.
