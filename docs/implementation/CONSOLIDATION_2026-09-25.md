# Consolidation checkpoint — 2026-09-25

For implementation continuation, start with [CONTINUATION_HANDOFF.md](CONTINUATION_HANDOFF.md). Creating this guide did not start or contact a worker.

## Scope

Consolidates the replacement implementation, tests, plans and reviewed evidence summaries from the authoritative `421a` worktree, based on `f2ae1ee71c66bea3488926df8332bec2d1ec7cfc`. The review branch is `codex/newton-browser-consolidation-2026-09-25`. The existing `origin` is the public Koala-Studios/newton-browser repository. Frank explicitly requested consolidation and push; no merge, tag, npm publication or store release is included.

The older dirty main checkout and other worktrees remain untouched. No worker tasks were contacted. Current progress is maintained in [PROGRESS_LEDGER.md](../PROGRESS_LEDGER.md); the historical execution/handoff documents now point there rather than claiming current completion.

## Fresh verification

| Check | Result |
| --- | --- |
| `pnpm build` | Passed; driver, core, MCP and adapter build completed |
| `pnpm typecheck` | Passed |
| `pnpm test` | 841 passed; zero failures, cancellations, skips or todos; 49.583 seconds |
| `pnpm lint` / boundary check | Failed; not waived or reported green |
| Packed three-pass acceptance | Not run; architecture/real-task/platform gaps still open |

Local command logs are retained in `test/evidence/runs/consolidation-2026-09-25/`. They are excluded from source identity and publication. The source suite includes live browser fixtures and a network-dependent MDN case; its success is not authenticated everyday workflow acceptance.

## Known gate failures

Boundary lint scans source, planning text, evidence and local residue with substring rules. It flags operator names/product references in `final push.md`, Spark packet/delivery notes and historical reports. It also traverses a local test-profile configuration directory instead of restricting itself to intended source. The scanner still requires old direct-runtime files, which conflicts with planned P13 retirement. Finish that harness migration with meaningful boundary tests; do not merely suppress the failing checks or call the release complete.

The local test-profile configuration and extracted v49 package directories are now explicitly ignored by Git. They were neither inspected as profile data nor removed in this consolidation. The current filesystem-walking lint does not honor those Git exclusions, so adding ignores does not fix its scanner gap.

## Publication contents and exclusions

Include production/core/driver/MCP/tab-adapter changes, regressions, root scripts, approved designs, implementation guides, current ledgers and reviewed Markdown evidence. Keep package version 0.6.4 unchanged and retain the MIT license.

Do not publish local browser identities/configuration, extracted package copies, generated dist/artifacts/dependencies, raw browser JSON/logs or screenshot captures. Preserve those local resources rather than deleting them. The pre-existing untracked `release-verification-win32.json` is also excluded: it is not a certificate for this checkpoint.

Historical reports may reference local raw evidence not included in Git. Their links and reported outcomes are provenance, not a promise that those logs exist in a fresh clone. The source tests and bounded summaries are preserved. A fresh clone must run its own acceptance, and cannot claim the historical artifact hashes for a newly built package.

## Next implementation work

1. Useful compact next-state feedback and closed-shadow/document reading.
2. Precise-edit/select adversarial, persisted rich-editor and backend/platform conformance.
3. Startup/stop/resource/visual cleanup stress and real shared-login/installation acceptance.
4. Legacy direct-host/parser/doctor/test retirement and repaired boundary/release groups.
5. Real authenticated tasks in both modes, model-loop measurements, then three frozen packed release gates.

This checkpoint preserves progress; it does not close the full implementation goal.
