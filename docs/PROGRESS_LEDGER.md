# Newton Browser Audit Improvement Program — Progress Ledger

This is the durable implementation-status record for the recommendations in
[`AGENT_BROWSER_COMPARATIVE_AUDIT.md`](AGENT_BROWSER_COMPARATIVE_AUDIT.md). Detailed
execution specifications live in [`implementation-plans/`](implementation-plans/README.md),
contract decisions live in [`DECISIONS.md`](DECISIONS.md), and test-level proof lives
under [`../test/evidence/`](../test/evidence/).

## Current baseline

| Field | Value |
| --- | --- |
| Baseline release | `0.4.5` |
| Baseline commit | `a6ff306` (`v0.4.5`) |
| Program opened | 2026-08-08 |
| Runtime implementation | In progress under the owner-approved AIP-01 through AIP-09 program goal |
| Active planning source | `docs/implementation-plans/README.md` and Plans 01–09 |
| Superseded source | Deleted monolithic `docs/IMPLEMENTATION_PLAN.md` |

The audit’s measurements and findings describe this baseline. They are not claims about
future implementation until the corresponding plan, tests, and evidence have landed.

## Status legend

- `AUTHORED` — actionable plan exists and is awaiting approval.
- `APPROVED` — owner approved repository implementation; no work implied beyond that scope.
- `IN PROGRESS` — implementation has an active owner and exact file boundary.
- `BLOCKED` — a named dependency or owner decision prevents useful progress.
- `DONE` — contract, implementation, regression, evidence, and required gates are complete.

## Active program

| ID | Plan | Dependency | Plan | Implementation | Completion evidence |
| --- | --- | --- | --- | --- | --- |
| AIP-01 | [Session command pump](implementation-plans/01-session-command-pump.md) | none | APPROVED | IN PROGRESS — source contract, controller/host queues, fencing, idempotency, public outcomes, and stress overlap detection integrated; packed smoke evidence pending | `53f5090`; `98fa669`; `8deef3e`; `3ac4d54`; QA-AIP-001 |
| AIP-02 | [Transactional lifecycle and framing](implementation-plans/02-transactional-lifecycle-and-framing.md) | AIP-01 contract types | APPROVED | IN PROGRESS — transaction primitive and bounded MCP framing integrated; lifecycle failure matrix, restart smoke, and structural bridge extraction pending | `6be1ef3`; `7451008`–`98b3b2f`; lifecycle/live evidence pending |
| AIP-03 | [Target/frame/session registry](implementation-plans/03-target-frame-session-registry.md) | AIP-01, AIP-02 | APPROVED | IN PROGRESS — first three isolated registry drafts rejected for graph/lifecycle errors and size-limit evasion; orchestrator correction pending | quarantined worker drafts; no accepted commit |
| AIP-04 | [Preventive origin containment](implementation-plans/04-preventive-origin-containment.md) | AIP-03 | APPROVED | queued behind AIP-03 registry | pending |
| AIP-05 | [Input and renderer reliability](implementation-plans/05-input-and-renderer-reliability.md) | AIP-01, AIP-03 | APPROVED | queued behind AIP-01/AIP-03 execution contracts | pending |
| AIP-06 | [Agent output efficiency](implementation-plans/06-agent-output-efficiency.md) | AIP-01 result contract | APPROVED | IN PROGRESS — reviewed pure projection/budget foundation integrated; MCP/AX integration and exact tokenizer gates pending | `90b986a`; `cfcd235`; focused projection tests `41/41` |
| AIP-07 | [MCP contract, provenance, and privacy](implementation-plans/07-mcp-contract-provenance-and-privacy.md) | AIP-04, AIP-06 | APPROVED | queued behind AIP-04/AIP-06 contracts | pending |
| AIP-08 | [Driver TypeScript hardening](implementation-plans/08-driver-typescript-hardening.md) | AIP-01–AIP-07 stable | APPROVED | queued behind stable AIP-01 through AIP-07 behavior | pending |
| AIP-09 | [Regression evals, observability, and release](implementation-plans/09-regression-evals-observability-and-release.md) | incremental; closes after AIP-08 | APPROVED | IN PROGRESS — reviewed deterministic schema/replay/report foundation integrated; corpus, metrics, release wiring, and final closure pending | `78d7bb5`; focused eval evidence `30/30`; final gates pending |

## Program acceptance gates

The program is complete only when all of the following are evidenced:

- Commands are FIFO within a session, concurrent across sessions, epoch-fenced, and
  idempotent with honest `not_started`, `completed`, `prevented`, or `outcome_unknown`
  results.
- Session start/rebind/finalize is transactional and MCP framing is bounded.
- OOPIFs, nested frames, popups, and workers use an explicit target/session registry and
  composite refs.
- Controlled targets and unsafe cross-origin effects are prevented before execution,
  with the documented read-only-subresource and WebRTC exclusions.
- Input has complete key/pointer semantics and dialogs/renderer lifecycle produce typed
  results without delay-based recovery.
- The representative agent workflow is at or below the Plan 06 token budgets while
  retaining full internal evidence.
- MCP schemas are strict and versioned; page content has structural untrusted provenance;
  opaque/base64 bodies are not returned.
- Critical driver code is compiled and checked by TypeScript with behavior parity.
- The regression/eval corpus covers concurrency, lifecycle, targets, containment, input,
  privacy, packaging, and measured successful-task cost.
- The exact packed artifacts pass `pnpm release:check` three consecutive times with no
  skipped critical tests.

## Baseline gate record

This section records only checks executed against the planning worktree. Runtime and
release claims remain those of the `v0.4.5` release evidence until implementation begins.

| Check | Result | Date | Evidence |
| --- | --- | --- | --- |
| `git diff --check` | pass | 2026-08-08 | no whitespace errors in tracked diff; new planning files separately checked for trailing whitespace |
| `pnpm lint` | pass | 2026-08-08 | standalone boundary check passed |
| `pnpm test` | pass | 2026-08-08 | 144 tests: 142 passed, 2 platform-specific persistent-socket tests skipped, 0 failed |
| `pnpm release:check` | not run | — | not required for documentation-only planning |

## Implementation checkpoint record

These checks cover only code already accepted into the integration branch. They do not
include quarantined worker commits or satisfy the final packed-artifact release gates.

| Check | Result | Date | Evidence |
| --- | --- | --- | --- |
| `pnpm test` | pass | 2026-08-08 | 203 tests: 201 passed, the same 2 platform-specific persistent-socket tests skipped, 0 failed after command-pump, transaction, and bounded-framing integration |
| `node --test test/evals/replay.test.mjs` | pass | 2026-08-08 | 30 tests passed, 0 failed; strict schema, replay lifecycle, forbidden effects, privacy projection, forged-report integrity, and hard report caps |
| `pnpm lint && pnpm typecheck && pnpm test` | pass | 2026-08-09 | standalone boundary and typecheck passed; 281 tests: 279 passed, 2 known platform-specific persistent-socket tests skipped, 0 failed after reviewed AIP-01 host/controller/public integration |
| bounded `scripts/smoke/stress.mjs` | pass | 2026-08-09 | 658 warmup and 1,674 measured operations across two sessions; 0 same-session overlaps, 0 cross-session result leaks, 0 deadlocks; source-level evidence only |

## Historical product work

The former WS0–WS12 ledger tracked the 0.4 release program. That program produced the
Newton rename, packaging/install path, extension UI and onboarding, version-skew checks,
browser capabilities, observer continuity, global executable fixes, focus behavior, and
the public 0.4.x releases through `v0.4.5`. Its granular proof remains available in Git
history, release tags, `CHANGELOG.md`, `docs/DECISIONS.md`, and `test/evidence/`.

Outstanding distribution/store/discovery operations from that historical program do not
authorize public actions and are not silently folded into this engineering audit program.

## Update rules

1. The integrator is the only concurrent worker allowed to edit this ledger.
2. Set a plan to `APPROVED` only from explicit owner approval.
3. `IN PROGRESS` requires an owner, exact path boundary, and working branch/worktree.
4. `DONE` requires the implementing commit, deterministic regression, relevant live or
   packed evidence, decision record, and all plan-specific exit criteria.
5. Record blockers precisely; “flaky” is not a root cause and a wider timeout is not proof.
6. Do not rewrite historical evidence. Add a superseding entry and link both records.
7. Publishing, public remotes, registries, stores, licenses, credentials, billing, and
   live third-party effects always require separate approval.

## Activity log

| Date | Change | Evidence |
| --- | --- | --- |
| 2026-08-08 | Completed the code-level comparative audit and authored AIP-01 through AIP-09. Replaced the stale WS0–WS12 execution ledger with this approval-gated program ledger. No runtime code was changed. | `docs/AGENT_BROWSER_COMPARATIVE_AUDIT.md`; `docs/implementation-plans/` |
| 2026-08-08 | Owner approved the complete implementation program. Started four isolated GPT-5.3 Codex Spark worktrees: W1 command-pump primitive (`019fe444-277a-7322-b1a4-3ef54d170ff7`), W2 transaction primitive (`019fe444-278b-73c0-9d42-a32ad8a640d3`), W3 bounded framing (`019fe444-32c8-74b0-9ff8-19c6448c2d9e`), and W4 eval foundation (`019fe444-32f3-7783-92a7-8d643ade56f6`). Shared integration files remain orchestrator-owned. | `orchestrator_guide.md`; Codex thread worktrees |
| 2026-08-08 | Independently reviewed and integrated the session transaction and command pump primitives after returning failing first drafts for correction. Focused regressions pass (`16/16` transaction, `11/11` pump); root lint and typecheck pass. Reused the same W1/W2 tasks for controller and host-contract integration. | `6be1ef3`; `53f5090`; focused Node tests |
| 2026-08-08 | Integrated the bounded MCP parser and replaced the unbounded inline server parser after four adversarial review passes. Root framing integration passes `32/32` including exact caps, fragmented backlog efficiency, async callback ordering, typed EOF errors, mixed framing, and end/close races; root typecheck passes. Reused W3 for the non-overlapping AIP-03 registry primitive. | `7451008`–`98b3b2f`; `apps/mcp-server/test/framing.test.ts` |
| 2026-08-08 | Re-ran the complete accepted integration suite after framing landed: 201 passed, 2 existing platform-specific persistent-socket tests skipped, and 0 failed. W1 controller, W2 host dispatch, W3 registry, and W4 eval drafts remain isolated pending independent correction and review. | `pnpm test`; 203 total tests |
| 2026-08-08 | Integrated the provider-independent eval foundation after repeated adversarial review of malformed tasks, async fixture lifecycle, semantic ref resolution, forbidden-effect matching, report privacy/integrity, fixture path safety, and bounded task/step output. Focused evals pass `30/30`; root lint, typecheck, and the existing 203-test suite pass. The new eval suite is not yet wired into the root test/release scripts, so AIP-09 remains in progress. Reused W4 for the next non-overlapping output-efficiency slice. | `78d7bb5`; `test/evals/replay.test.mjs` |
| 2026-08-09 | Independently corrected and integrated controller and host session queues after finding finalize-order hangs, contradictory epoch tests, pre-envelope byte accounting, phantom queue keys, late-generation overwrite, timeout-state, owner-transfer, and forged-outcome defects. Exposed idempotency and host-owned outcomes at the public MCP boundary, hardened the stress probe for same-session overlap, and corrected cross-package source escapes caught by the boundary gate. | `98fa669`; `8deef3e`; `3ac4d54`; BB-049–BB-052; QA-AIP-001 |
| 2026-08-09 | All four durable Spark tasks were retained for reuse as required. Their exact model allocation reached the service usage limit until 2026-08-15 22:05 EDT; no replacement tasks or model substitutions were created. Orchestrator implementation and review continue locally in the meantime. | durable task IDs in `orchestrator_guide.md`; task transcripts |
