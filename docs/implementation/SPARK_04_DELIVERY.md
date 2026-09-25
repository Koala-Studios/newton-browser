# SPARK 04 Delivery Notes

- Repository: `C:\Users\<user>\.codex\worktrees\421a\newton-browser`
- Working branch/checkout for this delivery: authoritative SPARK-04 context (`421a`).
- Previous `7704` work was rejected; changes are now applied only in this checkout.

## What was implemented

- Added/updated `scripts/qa/session-engine.mjs` with a deterministic, import-safe grouped test runner.
- Exported `engineTestFiles(root, group)` as a reusable helper.
- CLI entry is gated to module execution (`process.argv[1]` matches this file).
- Root detection uses module location (`new URL("../..", import.meta.url)`) instead of `process.cwd`.
- CLI accepts exactly one argument: one of `engine`, `reader`, or `connections`.
- Enforced hard failures for:
  - unknown/missing group
  - missing or invalid listed test path
  - any symlink encountered (direct path or traversal)
  - non-directory entries in directory declarations
  - empty result set
- Group file discovery:
  - Uses `.test.js`, `.test.mjs`, `.test.ts` suffix matching
  - Expands test directories recursively and sorts deterministically
  - Returns absolute paths only
- Runner executes with `node --test --test-isolation=none` via `spawnSync` and inherits stdio.

## Scope included

- `engine` group:
  - `packages/core/test/command-foundation.test.mjs`
  - `packages/driver/test/engine-foundation.test.mjs`
  - `packages/driver/test/native-input.test.mjs`
  - `packages/driver/test/target-inspection.test.mjs`
  - `packages/driver/test/navigation-probe.test.mjs`
  - `packages/driver/test/navigation-feedback.test.mjs`
  - `packages/driver/test/press-feedback.test.mjs`
  - `packages/driver/test/hidden-input.test.mjs`
  - `packages/driver/test/action-new-pages.test.mjs`
  - `test/engine-regressions` (directory discovery)
- `reader` group:
  - `packages/driver/test/ax-snapshot.test.mjs`
  - `packages/driver/test/control-reader.test.mjs`
  - `packages/driver/test/control-budget.test.mjs`
  - `packages/driver/test/document-chunk.test.mjs`
  - `packages/driver/test/record-delta.test.mjs`
  - `packages/driver/test/record-delta-adversarial.test.mjs`
  - `packages/driver/test/table-grid.test.mjs`
  - `packages/driver/test/table-grid-adversarial.test.mjs`
  - `packages/driver/test/scoped-document-frames.test.mjs`
  - `packages/driver/test/scoped-document-frame-limits.test.mjs`
  - `packages/driver/test/scoped-control-frames.test.mjs`
  - `packages/driver/test/frame-scope-predicate.test.mjs`
  - `packages/driver/test/raster-mask.test.ts`
  - `packages/driver/test/screenshot-mask-consistency.test.mjs`
  - `packages/driver/test/native-sensitive-regions.test.mjs`
  - `test/engine-regressions/document-reader.test.mjs`
  - `test/engine-regressions/structured-records.test.mjs`
  - `test/engine-regressions/oversized-observation.test.mjs`
  - `test/engine-regressions/control-context.test.mjs`
  - `test/engine-regressions/sensitive-shadow-discovery.test.mjs`
- `connections` group:
  - `test/existing-discovery.test.mjs`
  - `test/existing-new-tab-host.test.mjs`
  - `test/existing-page-family.test.mjs`
  - `test/existing-page-family-route-capacity.test.mjs`
  - `test/tab-foundation.test.mjs`
  - `test/tab-route-retirement.test.mjs`
  - `test/tab-popup-claims.test.mjs`
  - `test/tab-popup-claims-adversarial.test.mjs`
  - `test/tab-detach-pending.test.mjs`
  - `test/tab-detach-pending-adversarial.test.mjs`
  - `test/tab-create-cleanup.test.mjs`
  - `test/tab-create-claims.test.mjs`
  - `test/tab-adapter-response.test.mjs`
  - `test/profile-transaction-recovery.test.mjs`
  - `test/process-table-foundation.test.mjs`
  - `test/adapter-cli-update.test.mjs`
  - `test/adapter-directory-adversarial.test.mjs`
  - `test/adapter-update-journal.test.mjs`
  - `test/adapter-update-journal-adversarial.test.mjs`
  - `test/adapter-update-transaction-adversarial.test.mjs`
  - `test/native-broker-startup.test.mjs`
  - `test/native-client-adversarial.test.mjs`
  - `test/native-launcher-validation.test.mjs`
  - `test/native-publication.test.mjs`
  - `test/native-reconnect.test.mjs`
  - `test/native-registration-path.test.mjs`
  - `test/native-runtime-build-adversarial.test.mjs`
  - `apps/mcp-server/test/modern-mcp-stdio.test.ts`
  - `apps/mcp-server/test/mcp-contract.test.ts`
  - `apps/mcp-server/test/identity-binding-cli.test.ts`
  - `apps/mcp-server/test/browser-runtime/profile-store.test.ts`
  - `apps/mcp-server/test/browser-runtime/profile-closure.test.ts`
  - `apps/mcp-server/test/browser-runtime/process-supervisor.test.ts`
  - `apps/mcp-server/test/browser-runtime/identity-cli.test.ts`

## Notes / remaining work

- `scripts/release-candidate.mjs` was intentionally not changed here because SPARK-04 scoped this runner work only.
- No tests were executed in this delivery pass.
- Release completeness and orchestration wiring to upstream command flows remains outside this task.