# Audit improvement program evidence matrix

This matrix maps the comparative audit's acceptance requirements to implementation plans
and durable verification. `Pending live` means deterministic source and packed gates pass,
but a real connected Chrome/Edge extension is still required for the named browser proof.

| Acceptance requirement | Plan | Deterministic implementation/evidence | Status |
| --- | --- | --- | --- |
| Cross-session work remains concurrent | AIP-01 | Host/controller concurrency regressions; `scripts/smoke/stress.mjs`; packed `smoke:multi-client` | Pass |
| Same-session actions are FIFO, bounded, fenced, and non-overlapping | AIP-01 | Session pump, bridge queue, epoch/sequence tests, zero-overlap stress counters | Pass |
| Duplicate and timeout behavior cannot silently replay mutations | AIP-01 | Idempotency join/cache/conflict tests; `not_started` versus `outcome_unknown`; late-result tombstones | Pass |
| Start/finalize are atomic under injected failure | AIP-02 | Transaction rollback and controller failure matrices; bounded framing suite | Pending live worker-restart residue proof |
| Ungranted effects are prevented within the documented scope | AIP-04 | Pure containment decisions, controller preflight, host outcome preservation | Pending two-origin live request-counter proof |
| New controlled targets cannot run before containment | AIP-03/AIP-04 | Flattened target registry and held-target reconciliation tests | Pending live target-churn proof |
| Dialog-opening input settles and releases held state | AIP-05 | Input dispatcher and target-scoped dialog/liveness regressions | Pending Chrome/Edge live proof |
| OOPIF refs/actions route to the correct child session and origin | AIP-03 | Composite-ref registry and routed driver tests | Pending live OOPIF proof |
| Renderer failures have distinct machine outcomes | AIP-05 | `discarded`, `dialog_blocked`, `debugger_conflict`, `target_gone`, and `renderer_unresponsive` tests | Pending Chrome/Edge live proof |
| Observations are useful, compact, stable, and provenance-bearing | AIP-06/AIP-07 | Agent-output fixtures, hostile-text/redaction tests, packed compact/JSON parity | Pass |
| MCP schemas and annotations match runtime behavior | AIP-07 | Canonical action variants, annotation matrix, packed initialization/contract smoke | Pass |
| Critical driver logic is compiler checked without artifact bloat | AIP-08 | Strict TypeScript, exhaustive negative fixture, deterministic build parity, artifact allowlist | Pass |
| Tests avoid the real user profile | AIP-02/AIP-09 | Clean-user gate, validated temporary roots, packed install in an isolated spaced path | Pass |
| Regression tasks, budgets, and local diagnostics prevent maturity drift | AIP-09 | Provider-free replay/report corpus, exact token gates, bounded host command metrics and doctor framing facts | In progress |
| Exact packed artifacts pass the release gate three consecutive times | AIP-09 | `pnpm release:check` and recorded hashes/results | Pending final three-pass gate |

The authoritative execution state remains `docs/PROGRESS_LEDGER.md`; this file is the
requirement-to-evidence index, not a substitute for live run records.

