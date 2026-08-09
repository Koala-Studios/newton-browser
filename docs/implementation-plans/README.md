# Newton Browser Audit Implementation Program

- Status: approved implementation program in progress
- Created: 2026-08-08
Source: [`AGENT_BROWSER_COMPARATIVE_AUDIT.md`](../AGENT_BROWSER_COMPARATIVE_AUDIT.md)

This directory replaces the deleted monolithic `docs/IMPLEMENTATION_PLAN.md` as the
active implementation-planning source. Each plan is independently reviewable, but the
dependency order below is mandatory. A later plan may add failing fixtures or interfaces
early; it must not land production behavior before its prerequisites are complete.

## Program invariants

- Preserve concurrency across sessions; serialize only within one session.
- Preserve exact scheme/host/port origin grants.
- Preserve the structural safety floor, ambiguity rejection, stable targeting, and
  post-action verification.
- Preserve local-only operation, existing-profile control, owned-tab default behavior,
  and explicit current-tab control.
- Never add cookies, storage, credential/profile inspection, arbitrary JavaScript eval,
  a hosted dependency, model-provider runtime call, telemetry, or an installed daemon.
- Treat page content as untrusted data.
- Every defect begins with a deterministic repro and ends with a regression and evidence
  row. No wider timeout or sleep is accepted without proof that timing is the cause.
- `apps/mcp-server` stdout remains MCP-only.

## Explicit non-goals and bloat controls

The audit does not authorize a Rust rewrite, browser downloader/provider stack, installed
daemon, cookies/storage/auth-profile access, arbitrary JavaScript evaluation, general
plugin execution, hostname-only grants, silent stale-ref healing, main-DOM mutation for
element discovery, whole-command mutation retry, global cross-session mutex, or automatic
activation/reload of current user tabs.

Streaming, recording, HAR, PDF, broad browser-provider support, tool-profile pagination,
and dozens of command-specific MCP tools are deferred until measured task evidence shows
they improve successful agent work after Plans 01–09. They must not displace correctness,
containment, input, observation, or regression work.

## Ordered plans

| Plan | Capability | Depends on | Implementation status |
| --- | --- | --- | --- |
| [01](01-session-command-pump.md) | Per-session command pump, fencing, idempotency, outcome semantics | none | deterministic/packed complete; live pending |
| [02](02-transactional-lifecycle-and-framing.md) | Transactional session lifecycle, finalization, bounded MCP framing | 01 contract types | deterministic complete; live restart pending |
| [03](03-target-frame-session-registry.md) | Target/frame/session registry, composite refs, OOPIF routing | 01, 02 | deterministic complete; live pending |
| [04](04-preventive-origin-containment.md) | Preventive controlled-target and mutation-egress containment | 03 | deterministic complete; live pending |
| [05](05-input-and-renderer-reliability.md) | Dialog-aware input, keyboard correctness, renderer lifecycle | 01, 03 | deterministic complete; live pending |
| [06](06-agent-output-efficiency.md) | Compact observations/results, scoping, initial observation | 01 result contract | complete |
| [07](07-mcp-contract-provenance-and-privacy.md) | Strict schemas, annotations, provenance, opaque-body policy | 04, 06 | complete |
| [08](08-driver-typescript-hardening.md) | Checked/compiled TypeScript for critical extension driver code | 01-07 behavior stable | source/packed complete; live pending |
| [09](09-regression-evals-observability-and-release.md) | Regression corpus, task replay, budgets, doctor, live CI | incrementally consumes 01-08 | deterministic and three-pass release complete; live matrix pending |

## Dependency and integration order

```text
01 command semantics
  -> 02 atomic lifecycle and framing
      -> 03 target registry
          -> 04 preventive containment
          -> 05 input/renderer reliability
  -> 06 compact agent output
04 + 06 -> 07 strict public MCP contract
01-07 -> 08 behavior-preserving TypeScript conversion
01-08 -> 09 final regression/evaluation/release closure
```

Plan 09 starts in parallel as a test-only lane after each earlier plan defines its
acceptance fixtures, but its release-gate changes land last. Plan 08 deliberately lands
after the behavior refactors so a source-file rename does not create conflicts across
every active implementation lane.

## Shared-file ownership

These files are integration hotspots and must have one active owner at a time:

- `packages/core/src/protocol.ts`
- `packages/core/src/transport.ts`
- `packages/driver/src/controller.ts`
- `packages/driver/src/driver.ts`
- `apps/mcp-server/src/bridge.ts`
- `apps/mcp-server/src/mcp-server.ts`
- `scripts/release-check.mjs`
- `docs/DECISIONS.md`
- `docs/PROGRESS_LEDGER.md`
- `test/evidence/bugs.md`
- `test/evidence/qa-ledger.md`

Parallel workers may prepare tests or isolated new modules, but the integrator owns
shared-file edits, lockfiles, decisions, evidence, and ledger updates.

## Completion rule

A plan is complete only when:

1. every listed contract decision is recorded in `docs/DECISIONS.md`;
2. deterministic repros and regression tests pass;
3. focused tests, `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `git diff --check`
   pass;
4. required live-browser evidence is recorded under `test/evidence/`;
5. packed artifact checks pass when public MCP/extension behavior changes;
6. `docs/PROGRESS_LEDGER.md` records the exact commit and evidence identifiers;
7. no user-profile state, orphan tab, debugger attachment, relay port, paused target,
   or temporary file remains.

Release completion still requires `pnpm release:check` three consecutive times with no
skipped critical tests.

Implementation is intentionally not started by these documents. Conversational approval
of a plan authorizes repository implementation only; it does not authorize publishing,
browser-store submission, public exposure, billing, credential entry, destructive work,
or live third-party effects.
