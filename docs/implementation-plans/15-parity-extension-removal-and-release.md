# Plan 15 — Parity, Extension Removal, and Release

Status: complete; direct-only cross-platform parity, public-site QA, and release x3 recorded

Depends on: Plans 10–14

## Outcome

The direct-owned-browser runtime is the only production architecture. Extension/store/
relay code, packaging, and dead compatibility contracts have been removed in one reviewed
change; no half-supported second control plane remains.

## Deleted architecture paths

- `apps/extension/**`
- extension build/artifact/store scripts and extension-only fixtures
- extension local transport, pairing, ownership, worker-restart, tab-group, and current-tab
  code/tests/docs
- extension-only dependencies and generated artifacts

## Retain or migrate

- strict TypeScript driver and controller logic that remains transport-independent;
- MCP stdio and optional Unix continuity mode;
- per-session pump, compact contract, eval corpus, provenance/redaction, lifecycle receipts;
- live fixture servers generalized to owned browsers.

## Mandatory parity matrix

1. Windows Chrome: startup, identity lifecycle, concurrency, frame/OOPIF, containment including
   first popup request, input/dialog/renderer, screenshot masking, finalize/residue.
2. Windows Edge: the same product claims, not a reduced smoke subset.
3. Linux Chrome: process/CDP/proxy, OOPIF, containment, input/dialog, cleanup.
4. Packed install from a spaced path and symlinked entrypoint with isolated configuration.
5. Crash matrix: host/process/proxy/CDP loss at each startup/action/finalization phase.

The direct gate is `pnpm eval:direct-live` with
`NEWTON_BROWSER_QA_OWNER=chrome|edge`. It composes source runtime, stable setup/login/
doctor, two-process concurrency, same-process and OOPIF frame churn, the complete
containment fixture, input/dialog/renderer fixtures, and exact packed-artifact operation.
The Linux CFT runner selects the same gate with
`NEWTON_LINUX_RUNTIME_MODE=direct`. Current Windows Chrome and Edge receipts pass all nine
stages, including forced host termination. Final Linux run
`linux-cft-3468e9531b2a05d215e1` passes the same direct gate, agent-cost gate, final
four-site public matrix, and cleanup contract.

For every run record commit/tree digest, dirty manifest, OS/browser/runtime versions,
artifact hashes, bounded stage results, token budgets, residue, and explicit unsupported
features. Raw browser/page/profile/network data is forbidden in evidence.

## Removal sequence

1. Freeze and hash the exact direct-runtime candidate.
2. Complete the matrix with no skipped critical test.
3. Switch default and run a clean packed migration rehearsal.
4. Delete extension/relay/store paths and repair docs/build/package boundaries.
5. Rerun the complete deterministic, packed, and live matrix on the deletion tree.
6. Run `pnpm release:check` three consecutive times on the unchanged final tree and record
   artifact hashes. Any source change resets the count.

## Explicit compatibility losses

Ordinary existing-window/current-tab control is removed. Newton controls its own visible
browser windows and persistent identities. Attaching to a user-launched debug-enabled
browser may be considered later as an expert diagnostic mode, never the default and never
as a substitute for containment.

## Exit gate

No production/package/document reference requires an extension, store listing, relay port,
pairing secret, developer-mode refresh, or MV3 worker. The packed MCP is the complete usable
product and the final unchanged tree has three consecutive release receipts.
