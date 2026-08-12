# Newton Browser Implementation Program

- Status: complete; implementation, cross-platform QA, optional authorized opaque import, public-site matrix, and release x3 recorded
- Created: 2026-08-08
Sources: the original comparative audit and
[`NO_EXTENSION_ARCHITECTURE_RESEARCH.md`](../NO_EXTENSION_ARCHITECTURE_RESEARCH.md).

This directory replaces the deleted monolithic `docs/IMPLEMENTATION_PLAN.md` as the
active implementation-planning source. Each plan is independently reviewable, but the
dependency order below is mandatory. A later plan may add failing fixtures or interfaces
early; it must not land production behavior before its prerequisites are complete.

## Program invariants

- Preserve concurrency across sessions; serialize only within one session.
- Preserve exact scheme/host/port origin grants.
- Preserve the structural safety floor, ambiguity rejection, stable targeting, and
  post-action verification.
- Preserve local-only operation and replace extension-owned tabs with isolated
  Newton-owned Chrome/Edge processes and persistent identities.
- Never add cookie, storage, credential/profile inspection, arbitrary JavaScript eval,
  a hosted dependency, model-provider runtime call, telemetry, or an installed daemon.
- Treat page content as untrusted data.
- Every defect begins with a deterministic repro and ends with a regression and evidence
  row. No wider timeout or sleep is accepted without proof that timing is the cause.
- `apps/mcp-server` stdout remains MCP-only.

## Explicit non-goals and bloat controls

The audit does not authorize a Rust rewrite, browser downloader/provider stack, installed
daemon, cookie/storage/profile inspection or export, arbitrary JavaScript evaluation, general
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
| [01](01-session-command-pump.md) | Per-session command pump, fencing, idempotency, outcome semantics | none | complete; direct queued/running deadline and live concurrency evidence passed |
| [02](02-transactional-lifecycle-and-framing.md) | Transactional session lifecycle, finalization, bounded MCP framing | 01 contract types | complete; guardian, process-loss, stale-lease, and cleanup evidence passed |
| [03](03-target-frame-session-registry.md) | Target/frame/session registry, composite refs, OOPIF routing | 01, 02 | complete; Windows/Linux nested-frame evidence passed |
| [04](04-preventive-origin-containment.md) | Preventive controlled-target and mutation-egress containment | 03 | complete; Windows/Linux containment matrices passed |
| [05](05-input-and-renderer-reliability.md) | Dialog-aware input, keyboard correctness, renderer lifecycle | 01, 03 | complete; Windows/Linux browser and real-site evidence passed |
| [06](06-agent-output-efficiency.md) | Compact observations/results, scoping, initial observation | 01 result contract | complete |
| [07](07-mcp-contract-provenance-and-privacy.md) | Strict schemas, annotations, provenance, opaque-body policy | 04, 06 | complete |
| [08](08-driver-typescript-hardening.md) | Checked/compiled TypeScript for critical driver code | 01-07 behavior stable | complete; direct adapters and full discovery compile strictly |
| [09](09-regression-evals-observability-and-release.md) | Regression corpus, task replay, budgets, doctor, live CI | incrementally consumes 01-08 | complete; final candidate release x3 recorded |
| [10](10-owned-browser-runtime-private-cdp.md) | MCP-owned Chrome/Edge processes and private CDP | 01, 02, 06 | implementation and Windows/Linux browser QA complete |
| [11](11-launch-time-policy-proxy.md) | Pre-launch deny-by-default per-session network boundary | 10 and 04 semantics | aggregate fail-closed boundary complete; action attribution is causal CDP-only; HTTPS CONNECT requires explicit origins |
| [12](12-newton-identities-and-opaque-import.md) | Persistent Newton identities and explicit opaque profile import | 10 | implementation and authorized live import/cleanup complete; optional and not an authentication-preservation release claim |
| [13](13-direct-driver-and-host-collapse.md) | Inject direct CDP and remove the former relay/control plane | 10-12 | implementation and integrated/packed QA complete |
| [14](14-compact-agent-interface-and-operations.md) | Compact 11-tool interface and zero-extension operations | 13 | implementation and production-site/token QA complete |
| [15](15-parity-extension-removal-and-release.md) | Cross-platform parity, extension deletion, final release | 10-14 | complete; final public-site and x3 gates recorded |

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
01-08 -> 09 retained deterministic foundation
10 process/CDP + 11 preventive proxy + 12 identities
  -> 13 direct driver/host collapse
      -> 14 compact product surface
          -> 15 parity, extension removal, final release
```

Plans 01-09 contain substantial transport-independent foundations, but their direct-mode
acceptance remains subject to the open rows above. QA-NOEXT-003/004 are historical fixture
and deterministic checkpoints, not final-tree or real-site closure. The former extension
is no longer present; current evidence must exercise the sole direct architecture.

## Shared-file ownership

These files are integration hotspots and must have one active owner at a time:

- `packages/core/src/protocol.ts`
- `packages/core/src/transport.ts`
- `packages/driver/src/driver.ts`
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
5. packed artifact checks pass when public MCP or browser-runtime behavior changes;
6. `docs/PROGRESS_LEDGER.md` records the exact commit and evidence identifiers;
7. no source-profile mutation, orphan process, proxy/CDP listener, identity lease, paused
   target, or temporary file remains.

Release completion still requires `pnpm release:check` three consecutive times with no
skipped critical tests.

Implementation status in this index is not release completion. Conversational approval
does not authorize publishing, public exposure, billing, credential entry, or live
third-party effects beyond the explicitly approved read-only QA matrix.
