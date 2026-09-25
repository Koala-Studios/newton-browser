# Release process

Updated 2026-09-25. This tree is an unreleased replacement checkpoint. [PROGRESS_LEDGER.md](PROGRESS_LEDGER.md) records implementation and gaps; [the consolidation record](implementation/CONSOLIDATION_2026-09-25.md) records fresh verification. Package version 0.6.4 does not identify an accepted replacement artifact by itself.

The package build now includes the shared-engine candidate, guardian/profile worker, native host/installer/launcher and optional tab-adapter assets. The former five-file/direct-only descriptions are obsolete. A Git branch push is not npm publication, a browser-store submission or proof of release readiness.

## Required closure

1. Finish the approved architecture and audited repairs, including legacy retirement and current-engine release scripts. Do not interpret a passing old direct-host suite as shared-engine conformance.
2. Complete real everyday online tasks in standalone and explicit existing-browser modes: authenticated forms, persisted rich editing, visual/embedded interfaces, shared login and measured model feedback loops. Record effects, turns, output tokens, waits, recovery and elapsed time. Public read-only pages and fixtures do not satisfy this alone.
3. Verify Windows Chrome/Edge and Linux Chrome runtime/installation/cleanup behavior. Keep Windows and Linux evidence separate until the same packed artifact and relevant behavior are proven. Do not equate pure platform-path tests with an actual install or browser run.
4. Freeze one exact source candidate and packed artifact. `scripts/release-candidate.mjs` includes tracked and nonignored untracked source with explicit generated-output exclusions, streams bounded bytes and refuses unsafe/unstable paths. Record commit/tree/content digest, exact exclusions and artifact SHA-256.
5. Run build, typecheck, boundary lint, meaningful regression suites, pack/install/catalog checks and backend live acceptance. Fail critical skips. The grouped runner and full gate migration remain unfinished; do not certify solely from current script exit status.
6. Run `pnpm release:check` three consecutive times against the unchanged packed candidate, with required platform receipts. Source/test/config/doc changes reset the sequence. Record final receipts outside the source inventory; generated runs belong under `test/evidence/runs/`.
7. Only separately authorized release delivery may publish npm/store artifacts, tags or merge the checkpoint. Preserve the MIT license.

## Current evidence limits

The 2026-09-25 source build/typecheck and 841 tests pass. Boundary lint fails on planning/evidence text and a local residue path; the scanner also still requires legacy implementation files. These are open harness defects, not waived checks. See the consolidation record.

Historical `packed-release-three-pass.json` and old execution-log statements refer to earlier limited candidates and do not close the full replacement gate. Historical v53 (`038bb2482517f3bfcb6e543d08b217134a40c001eade78a772101164cacc18ad`) predates the final source editing/feedback/platform work. No replacement release certificate exists for the consolidated tree.
