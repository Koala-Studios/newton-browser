# Newton Browser progress ledger

## Active program — modern-only direct runtime

Newton is being collapsed to one local architecture: stateless MCP `2026-07-28` on stdio,
one isolated owned Chrome or Edge process per session, private CDP pipes, exact-origin
containment, and ten compact tools.

The implementation and documentation batch is frozen. The integrated deterministic,
packed, live-browser, real-site, profile-import, and Linux CFT matrices passed on
2026-08-12. The only remaining release action after this ledger freeze is three
consecutive `pnpm release:check` executions on the unchanged candidate; publication still
requires the separately approved clean-tag Windows/Linux workflow.

## Definition of complete

| Gate | Required evidence | State |
| --- | --- | --- |
| Single architecture | no extension, relay, daemon, socket continuity, current-tab, legacy MCP, finalize, page-effects, synthetic-tab, or ownership compatibility paths | passed source, boundary, package, docs, and skill scans |
| Modern MCP | exact 2026-07-28 metadata/discovery/result/cancellation; old handshake/framing rejected | passed contract, stdio, packed-catalog, and agent-cost gates |
| Direct runtime | source and exact-packed start/observe/act/screenshot/stop in Chrome and Edge | passed Windows Chrome and Edge plus Linux CFT |
| Concurrency | same-session FIFO, cross-session progress, distinct processes/identities, zero residue | passed Chrome, Edge, and Linux direct-live suites |
| Containment | denied navigation/mutation/connection/popup/frame/worker/redirect with honest outcomes and zero denied application requests | passed deterministic and connected-browser counters |
| Frames/input/lifecycle | same-process and nested OOPIF actions, dialogs, renderer/process loss, guardian cleanup, stale-ref fencing | passed Chrome, Edge, and Linux direct-live suites |
| Compact output | token budgets, flat actions, one canonical result shape, image-only screenshots | passed deterministic token and packed-contract gates |
| Real-site usability | read-only public YouTube, Reddit, Mercato di Bellina, Meta public surfaces where accessible, and stable reference sites | seven-site suite passed Chrome, Edge, and Linux |
| Packaging | exact tarball install/run, source-free artifacts, Windows Chrome/Edge and Linux Chrome, bounded receipts, zero residue | exact 0.5.0 tarball passed all three browser/platform lanes |
| Authorized opaque import | closed Chrome Default copied through the narrow opaque allowlist, public read-only QA, no authentication-preservation claim, source untouched, identity removed | passed Windows Chrome |
| Release stability | three unchanged-tree local passes after this ledger freeze; clean-tag Windows/Linux publication receipt remains a separately approved release operation | final immutable execution boundary |

## Current implementation inventory

- Deleted: MV3 application/store assets, relay/pairing, socket continuity, legacy MCP
  parser/initialization, finalize aliases, synthetic tab IDs, page-effects adapter,
  owned/unowned driver branches, and screenshot file/inline controls.
- Retained intentionally: application session IDs, FIFO/idempotency, exact-origin proxy,
  popup containment, target/frame topology generations, identity leases, guardian cleanup,
  trusted raster masking, bounded console/network evidence, and authorized opaque import.
- Public MCP: ten tools; no resources, prompts, tasks, subscriptions, sampling, daemon,
  or connection-scoped state.
- Public session state: one canonical origin, exact allowed origins, and one lifecycle
  state; no duplicate attachment flag or stale live-origin mirror.
- Public `allowedOrigins` means only zero to 31 additional exact grants; the primary is
  inserted privately after strict duplicate/repetition validation.
- Host policy is loaded once from the selected config directory and deep-frozen for the
  host lifetime together with the browser preference in one validated config snapshot;
  action evaluation has no process-global config dependency.
- Core, driver, and MCP builds replace their owned output directories; boundary checks
  reject stale compiled modules. Publication's three-pass verifier binds all passes to one
  clean tagged candidate and one per-platform artifact digest.
- Private test-only topology fields and nested response-shape fallbacks are removed. Frame
  acceptance proves actual nested observations, actions, effects, provenance, and stale-ref
  rejection through the same public contract used by agents.

## Evidence policy

Final receipts under `test/evidence/` identify the exact source digest, platform,
browser/runtime versions, bounded results, package hash/entries, residue facts, and
release-pass ordinal. They may contain fixed codes, counts, categories, and hashes only;
never page content, credentials, profile paths/contents, private origins, or raw CDP logs.

The retained `bugs.md` and `upstream-provenance.md` files are engineering history only and
do not close the modern-only gate. Misleading precursor release receipts and obsolete
extension-era program matrices were removed. Final bounded receipts are created only for
the frozen modern tree.

The bounded pre-freeze matrix receipt is `test/evidence/qa-modern-direct-preflight.json`.
The final unchanged-tree pass digest and artifact hash are emitted by
`scripts/release-complete-local.mjs`; they are reported without editing this candidate
afterward.
