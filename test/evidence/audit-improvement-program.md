# Audit improvement program evidence matrix

> Historical cumulative matrix. “Pass” records below identify implementation evidence at
> the time recorded, not current frozen-tree release evidence. The completion ledger and
> final direct evidence supersede these statuses for release decisions.

This matrix maps the comparative audit's acceptance requirements to implementation plans
and durable verification. Extension-specific live requirements are superseded where the
owned direct runtime proves the same invariant on Windows Chrome/Edge and Linux Chrome.

| Acceptance requirement | Plan | Deterministic implementation/evidence | Status |
| --- | --- | --- | --- |
| Cross-session work remains concurrent | AIP-01 | Host/controller concurrency regressions; `scripts/smoke/stress.mjs`; packed `smoke:multi-client`; direct two-process live harness | Pass on Windows Chrome/Edge and Linux Chrome |
| Same-session actions are FIFO, bounded, fenced, and non-overlapping | AIP-01 | Session pump, bridge queue, epoch/sequence tests, zero-overlap stress counters; direct live harness proves queued FIFO with concurrent progress | Pass |
| Duplicate and timeout behavior cannot silently replay mutations | AIP-01 | Idempotency join/cache/conflict tests; `not_started` versus `outcome_unknown`; late-result tombstones | Pass |
| Start/finalize are atomic under injected failure | AIP-02 | Transaction rollback and controller failure matrices; bounded framing suite | Pending live worker-restart residue proof |
| Ungranted effects are prevented within the documented scope | AIP-04 | Launch-time policy proxy, exact destination counters, authoritative outcome mapping, and full direct containment fixture | Pass on Windows Chrome/Edge and Linux Chrome |
| New controlled targets cannot run before containment | AIP-03/AIP-04 | Owned browser starts behind the ready proxy; CDP registry excludes popup/worker targets; denied popup documents reach the destination zero times | Pass |
| Dialog-opening input settles and releases held state | AIP-05 | Input dispatcher, target-scoped dialog/liveness regressions, and direct live fixture | Pass on Windows Chrome/Edge and Linux Chrome |
| OOPIF refs/actions route to the correct child session and origin | AIP-03 | Composite-ref registry, routed driver tests, and Linux site-isolated nested-frame receipt | Pass; Windows loopback remained in-process |
| Renderer failures have distinct machine outcomes | AIP-05 | `discarded`, `dialog_blocked`, `debugger_conflict`, `target_gone`, and `renderer_unresponsive` tests plus live dialog/lifecycle gate | Pass |
| Observations are useful, compact, stable, and provenance-bearing | AIP-06/AIP-07 | Agent-output fixtures, hostile-text/redaction tests, packed compact/JSON parity | Pass |
| MCP schemas and annotations match runtime behavior | AIP-07 | Canonical action variants, annotation matrix, packed initialization/contract smoke | Pass |
| Critical driver logic is compiler checked without artifact bloat | AIP-08 | Strict TypeScript, exhaustive negative fixture, deterministic build parity, artifact allowlist | Pass |
| Tests avoid the real user profile | AIP-02/AIP-09 | Clean-user gate, validated temporary roots, packed install in an isolated spaced path | Pass |
| Regression tasks, budgets, and local diagnostics prevent maturity drift | AIP-09 | Provider-free replay/report corpus, exact token gates, bounded host command metrics, doctor facts, and direct live replay | Pass |
| Exact packed artifacts pass the release gate three consecutive times | AIP-09 | Three 13-stage `pnpm release:check` passes on ancestor `4577a3f`; exact hashes/results in QA-AIP-009B | Historical pass only; three passes on the final integration tree pending |

The authoritative execution state remains `docs/PROGRESS_LEDGER.md`; this file is the
requirement-to-evidence index, not a substitute for live run records.
