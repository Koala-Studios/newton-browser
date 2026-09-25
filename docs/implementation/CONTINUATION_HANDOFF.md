# Newton Browser continuation handoff

Prepared 2026-09-25. Read this before editing. This is an execution guide for the next implementer, not a claim that the replacement is complete, and not an instruction to start another worker automatically.

## 1. Exact starting point and authority

- Repository: `https://github.com/Koala-Studios/newton-browser` (public).
- Branch: `codex/newton-browser-consolidation-2026-09-25`.
- Implementation checkpoint: **`8e35a21d7859297271460e31528c922bfce33c4c`**. The handoff itself is a subsequent documentation commit on that branch. Start from the branch tip containing this file, not from `main`.
- Authoritative local checkout on the original machine: `C:\Users\<user>\.codex\worktrees\421a\newton-browser`.
- `C:\DEV\newton-browser` is an older dirty checkout at the original baseline. Do not copy its files over this branch, reset it, clean it, or use it just because the harness starts there.
- Other worktrees may contain unrelated or rejected worker output. They are not integration sources for this handoff.
- The full intended outcome is P00–P14 in the approved replacement architecture: a fast model feedback loop and reliable actual tasks, in both standalone and explicitly selected existing-browser mode. Finish the existing implementation; do not begin another speculative rewrite.
- Work alone. Do not start subagents, contact prior workers, poll tasks, or delegate QA. Earlier Spark/Luna instructions in packet files and `final push.md` are superseded. A request to use this handoff authorizes the receiving worker to perform its assigned continuation, not to delegate again.
- The consolidation push did not authorize merging, npm publication, tags, browser-store submission, license changes or deployment. Follow any newer explicit instruction from the operator.

On another machine, use a fresh checkout of this branch. Do not copy local identities, runner homes, private configs, sockets or raw browser state from the original machine. Use the installed Newton development contract and current Bubble memory if required by the active task; do not treat this handoff as worker authentication or a saved copy of that memory.

## 2. Read order and sources of truth

Read these in order, with source open alongside them:

1. Repository `AGENTS.md` and current operator instructions.
2. `docs/PROGRESS_LEDGER.md` — current implemented behavior, evidence and gaps.
3. `docs/implementation/CONSOLIDATION_2026-09-25.md` — what was pushed, fresh checks and exclusions.
4. `docs/SESSION_ENGINE_DESIGN.md` — approved target architecture.
5. This file and the relevant sections of `final push.md` — execution details.
6. `docs/IMPLEMENTATION_GUIDE.md`, `docs/implementation/SPARK_PACKETS.md` and `docs/implementation/LEGACY_MIGRATION_INVENTORY.md` only for the packet/dependency being changed.
7. Relevant deterministic tests and dated evidence for the behavior under investigation.

The initial final-push baseline is stale in several places. Apply these corrections before using it:

| Older statement | Current fact |
| --- | --- |
| Default runtime has not cut over / only fill exists | Default MCP uses `EngineHost` and the replacement engine with broad action/read support. |
| Precise range editing is missing | `edit` is implemented; adversarial, persisted-editor and backend/platform acceptance remains. |
| Linux native installation code is missing | Platform layout, immutable artifacts and Linux registration code exist; actual Linux acceptance remains. |
| Source refresh only collects old generations | CLI now routes refresh through maintenance/publication and exposes collection separately. Subprocess interruption QA remains. |
| Native select gathers unlimited options | Current discovery has a 4096-option bound and label/value limits. Platform/custom-control conformance remains. |
| Three passes certify the replacement | Earlier reports concern narrower historical candidates. No full replacement certificate exists for this tree. |
| Ask/wait for previous workers | Work solo. No worker orchestration is active. |

Treat every prior worker's test/report as a candidate oracle, not authority. A green test may prove the wrong thing. Historical logs often are not present in a fresh clone; missing raw evidence does not justify copying local profile directories.

## 3. Verified checkpoint and immediate gaps

Fresh checks on 2026-09-25:

| Command | Result |
| --- | --- |
| `pnpm build` | Passed |
| `pnpm typecheck` | Passed |
| `pnpm test` | 841 passed, zero failed/cancelled/skipped/todo; 49.583 seconds |
| `pnpm lint` | Failed; boundary scanner issues described below |
| `git diff --cached --check` before checkpoint | Passed after normalizing intended staged text |
| Packed / real authenticated / three-pass release | Not rerun or certified for this checkpoint |

The test command rebuilds the driver. Some tests launch real Chrome; one MDN flow depends on the network. Do not silently skip these and compare the remaining count with 841. Counts will legitimately change as meaningful tests are added or legacy tests migrate.

Historical v53 packed hash is `038bb2482517f3bfcb6e543d08b217134a40c001eade78a772101164cacc18ad` (13 files, 329700 bytes). It predates later editing/feedback/platform changes. Never attach it to current source validation. The prior seven-call MDN model run and 27-call public scripted run are limited baselines, not ChatGPT parity or authenticated acceptance.

### Confirmed boundary gate problem

`scripts/verify-boundary.mjs` recursively walks the filesystem and applies broad forbidden substrings to planning docs, evidence and local residue. It flags names in handoff notes, and walks an ignored local configuration directory. It still requires legacy modules scheduled for deletion. Git ignore rules do not fix its filesystem walker.

Do not run this scanner against unknown runtime/profile directories as a way to inspect them. First fix its input inventory to intended source and test its boundary policy in a disposable fixture. Keep dependency/runtime prohibition checks; distinguish a planning mention from an actual product dependency. A broad allowlist of every failing path is not the repair.

### Inspection leads that are not yet independently closed defects

- `EngineHost.stopAll()` awaits `Promise.allSettled(this.starts)` without a separate bounded pending-start resolution. Build a held-start repro before choosing cancellation/cleanup behavior.
- `scripts/qa/session-engine.mjs` is still a worker candidate. Inspect explicit lists for old direct-host tests, ancestor symlink validation, and signal/null exit propagation (`process.exit(result.status)`). It is not wired as a finished release gate.
- `mcp-request-metadata.ts` exists as an extraction candidate; do not assume it is wired into the public handler. Preserve metadata enforcement when removing the old router.
- `scripts/measure-agent-cost.mjs` still measures legacy projections rather than the complete current model task.

## 4. Runtime map: change the existing owner

| Responsibility | Main code |
| --- | --- |
| Command/action contracts, strict parser, limits | `packages/core/src/command-contract.ts`, `command-json-schema.ts` |
| Escaped UTF-8 MCP result budgets | `packages/core/src/receipt-encoding.ts` |
| Queue, receipt lifecycle, deduplication, read lane | `packages/driver/src/session-engine.ts`, `command-store.ts`, `command-context.ts` |
| Page/frame generation, routes, public refs | `packages/driver/src/page-directory.ts` |
| Action orchestration, feedback, document/capture lifetime | `packages/driver/src/page-executor.ts` |
| Target discovery and native field facts | `packages/driver/src/target-resolver.ts`, `readonly-world.ts` |
| Native keyboard/pointer and bounded release cleanup | `packages/driver/src/native-input.ts`, `key-description.ts` |
| Exact-match range resolution and native selection | `packages/driver/src/text-edit-range.ts`, `native-edit-selection.ts` |
| Controls, document and typed record acquisition | `ax-snapshot.ts`, `control-reader.ts`, `document-reader.ts`, `structured-reader.ts`, `table-reader.ts`, `table-grid.ts` in driver source |
| Screenshot sensitivity/geometry/masking | `native-sensitive-regions.ts`, `frame-mask-geometry.ts`, `raster-mask.ts` in driver source |
| MCP catalog and dispatch | `apps/mcp-server/src/engine-mcp.ts`; outer boundary is `mcp-server.ts` |
| Session creation and default source | `apps/mcp-server/src/browser-runtime/engine-host.ts`, `default-engine-host.ts`, `login-source.ts` |
| Opaque clone, recovery, process ownership | `profile-copy-worker.ts`, `profile-transaction-recovery.ts`, `profile-store.ts`, `async-closure.ts`, `process-table.ts`, guardian/runtime modules |
| Existing-browser connection and routing | `existing-connection.ts`, `existing-page-family.ts`, `native-client.ts`, `native-broker.ts`, `native-wire.ts`, `native-reconnect.ts` in MCP source |
| Thin extension ownership/routing | `apps/tab-adapter/src/claims.ts`, `worker.ts`, `update-binding.ts` |
| Installation and platform mechanics | `native-platform.ts`, `native-artifacts.ts`, `native-file.ts`, `native-runtime-build.ts`, `native-launcher.cjs`, `native-install.ts`, `linux-native-registration.ts` |
| Update transaction/journal and lock | `adapter-installation.ts`, `adapter-directory.ts`, `adapter-update*.ts`, `installation-lock.ts` |
| Source/operator CLI | `apps/mcp-server/src/cli.ts`; old doctor consumers remain in `direct-setup-cli.ts` |
| Build, packing and gate | `scripts/build-driver.mjs`, `build-mcp.mjs`, `deterministic-pack.mjs`, `pack-check.mjs`, `release-candidate.mjs`, `release-complete-local.mjs` |

Do not add another outcome mapper, observer cache, scheduler, ref store, profile authority, model service or public control listener. Adapt narrow platform/transport mechanics around the shared owners.

## 5. First session: establish the exact branch without wasting a day

In PowerShell on the original machine:

```powershell
Set-Location 'C:\Users\<user>\.codex\worktrees\421a\newton-browser'
git status --short --branch
git log -3 --oneline
git merge-base --is-ancestor 8e35a21d7859297271460e31528c922bfce33c4c HEAD
# Nonzero means stop and identify the wrong branch before editing.
node --version
pnpm --version
```

On a fresh clone, install with `pnpm install --frozen-lockfile`. Runtime package declares Node >=24; new SEA launcher compilation currently requires Node >=25.5. Inspect `native-artifacts.ts` before interpreting an unsupported SEA build as a product failure or skipping installation acceptance. Use pnpm 10.8.0 as declared by the workspace.

Inventory available actual Chrome/Edge/Linux environments and authorized disposable real-app data early. Missing Linux or an authenticated QA account blocks only that acceptance row, not independent code work. Do not guess credentials or use someone else's browser profile automatically.

On the original unchanged checkout, use the fresh consolidation baseline rather than rerunning every historical script immediately. On a fresh environment, perform a build/typecheck and the relevant first-batch checks. After substantive integrated changes, run the broad suite. Keep dist builds and packs sequential; never test an artifact while another command is rewriting it.

## 6. Recommended implementation batches

The order below groups dependent work. Fix a deterministic regression as it is introduced; do not defer all correctness checks until the end. Avoid full rebuild/pack/live matrices after each tiny edit.

### Batch A: trustworthy gate inventory and model-facing completion

**A1 — Boundary/QA inventory.** Repair scanner scope first so verification no longer reads local runtime residue. Prefer a bounded Git tracked/nonignored source inventory with explicit generated exclusions and safe path validation, following the existing candidate-digest approach. Keep structural architecture checks against actual source/package dependencies. Test an allowed explanatory document, a forbidden production dependency, an ignored runtime directory, a source file under a misleading directory name, and a symlink ancestor. Migrate legacy-required-file assertions only with the legacy work, not by declaring those files optional to make lint green.

Review the grouped runner separately: import must not run tests; unknown/missing/extra group arguments fail; required files cannot be omitted; directory/ancestor symlinks reject; signalled children are failures. Do not wire it as release completeness until its membership and critical-skip behavior are correct.

**A2 — Useful next state.** In `observeAfterAction`/`observe`/local feedback:

1. Reproduce empty destination or missing dialog/options at the actual MCP boundary.
2. Trace commit, document generation, route/context readiness and AX evidence within the existing deadline. Do not infer readiness from a fixed delay.
3. Preserve action provenance, exact dispatch and postcondition even when discovery fails.
4. Return current metadata and actionable current refs when evidence permits. A refresh is a read, never a repeated click/input.
5. Ordinary field edits should remain local; expanded controls can include bounded native related options. Menus/dialogs need their actual semantic container, not a whole-page scan every time.
6. Make work/output/rendered-subset/evidence-unavailable omissions explicit. A complete empty scope and an unavailable scope are different.

Keep `observation-frame-churn.test.mjs` green: a committing child loses only its stale results; a committing root invalidates root refs. Add forced context/AX delays, SPA/hash/reload, pending child and repeated navigation cases with no deadline extension.

**A3 — Reading and compactness.** Finish closed-shadow rendered reading without querying unbounded DOM or returning hidden/password content. Reuse frame inclusion and current reader budgets. Preserve PRE/code, links, slots and meaningful line structure; do not flatten tables by whitespace. Audit repeated false booleans and generic role ranking in control output; if omission defaults change, update canonical type/schema, instructions and consumer tests together. Measure resulting model output, not only raw string length.

**Exit:** focused failures have real repros and regressions; start/navigation/search/dialog actions expose the next usable state; reader completeness is honest; applicable source groups/typecheck pass. Record still-unavailable real environments explicitly.

### Batch B: precise editing, lifecycle and platform completion

**B1 — Extend the existing edit implementation, do not replace it with IME placeholders.** Current flow is:

```text
resolve exact target -> inspect non-sensitive current value
-> resolve unique text match -> compute bounded native selection commands
-> focus/recheck value -> native selection + key release
-> verify value/focus/sensitivity/actual selected offsets
-> native insertText or native delete -> verify full expected value
```

`resolveTextEditRange` uses UTF-16 offsets, bounded input/context and explicit ambiguity handling. `nativeSelectionCommands` uses grapheme boundaries, the nearer document edge, a 65536-unit value cap and at most 4096 native editing commands. The editor's actual selection, not the computed offset alone, determines permission to insert. Contenteditable range objects are read-only measurement; they must never be installed as the page selection.

The earlier IME probe puts `Ω` into the field and commits it on focus movement; its “cancellation” assertion does not establish safe production cancellation. The selected implementation introduces no temporary text. Retain `native-selection-probe.test.mjs` cancellation immediately after selection acknowledgement.

Add actual cases for repeated text/context/occurrence, selection drift after key handlers, focus migration, type/autocomplete turning sensitive, readonly/disabled changes, DOM replacement, grapheme/ZWJ and bidirectional text, multiline/rich block offsets, controlled editor normalization, and preserving surrounding formatting. Test the actual app-accepted input and reopen a disposable persisted document. Unsupported structures must refuse without whole-field fallback. Add matching Edge/Linux/extension evidence; simple Chrome inline contenteditable is not universal rich-editor proof.

Example public action (fill in a returned session/ref/next command ID):

```json
{
  "sessionId": "<returned-session>",
  "command": {
    "commandId": 1,
    "action": {
      "kind": "edit",
      "target": {"kind": "ref", "ref": "<returned-ref>"},
      "match": "original phrase",
      "replacement": "revised phrase",
      "prefix": "immediate preceding text "
    }
  }
}
```

Use exactly the returned `nextCommandId`; the example's 1 is not a recovery instruction. Query `browser.command` after uncertainty, rather than issuing the edit again under a new ID.

**B2 — Lifecycle/resource bounds.** Start with a held connection/start promise and call host stop. Inspect `EngineHost.stopAll` and connection startup ownership. A timeout on the caller alone does not clean a late browser. Require no late session admission, exact cleanup when a connection arrives after shutdown, and bounded visible uncertainty if cleanup cannot be proven. Do not swallow cleanup errors or kill by executable name.

Create a resource table for retained command results, pages/frames, refs/snapshots, cursors, pending CDP/native chunks, image buffers, claims, listeners and read objects. Stress the actual caps and assert a plateau and correct failure. Add no permanent telemetry service.

For borrowed screenshots test hidden stream start/stop late replies, never-acknowledged stop, route loss and cancellation. Do not return usable capture provenance after uncertain cleanup. Verify actual bottom pixels/masks, clipping/transformed frames, zoom/scroll and stale-coordinate refusal.

**B3 — Platform/source acceptance.** Current Linux code is not a Windows-only stub anymore. Inspect it before rewriting. Test actual executable permissions, user-local Chrome registration, existing registration ownership, symlink/hardlink/partial publication, unregister preservation and launch from an extracted installed package. Exercise Edge independently.

Source CLI refresh now uses maintenance/publication and collect is separate. Add subprocess tests for EOF, signals, browser-close, failed publication and listener/process cleanup. Prove concurrent clones use immutable generations and worker changes never merge back. Real provider authentication is verified only by page-visible account behavior, never reading cookie/storage/profile values.

**Exit:** negative behavior/effects and cleanup are proven across available environments; any unavailable required platform/account remains an explicit incomplete row. No fake Linux pass from a path-layout mock.

### Batch C: retire the old execution path and finish release tools

This is architecture integration work. Do not ask a weaker helper to perform blind bulk deletion.

1. Use `rg` to refresh actual imports/exports/callers. The legacy inventory is a starting map, not current line-level truth.
2. Port doctor and other live CLI consumers to the new lifecycle while preserving browser discovery/config/profile utilities that are actually shared.
3. Replace direct-host MCP routing, old catalog/parser/normalizers and transport-side form loops with the canonical engine path. Wire the extracted request metadata helper only after preserving public protocol rejection tests.
4. Port behavioral oracles before deleting old tests/modules. Explicitly map focus-sensitive/replacement races, partial exclusive sequences, readonly refusal, navigation failure, hidden waits, useful returned refs, private-ref preservation, exact output/cursor budgets, late semantic matches, deadline/stop independence, process discovery, native select and full initial URL.
5. Remove obsolete direct runtime/queue/ref/output authority and package exports. Do not move them to `legacy/`, add an environment fallback, or keep two catalogs to preserve old test fixtures.
6. Reconcile build parity, package exports and boundary rules in the same batch. Inspect the actual bundle/extracted package as well as source imports.
7. Audit whether `engine-candidate` remains necessary for tests/packaging; do not delete a live entrypoint based on its name.
8. Migrate agent-cost and release scripts to current commands and actual task traces. Add missing root scripts only once implemented; planned `test:engine`, `test:reader`, `test:connections`, `qa:tasks`, `qa:model-cost` are not all currently present.

Existing `mcp-request-metadata.ts` illustrates the exact per-request keys to preserve:

```json
{
  "_meta": {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientCapabilities": {}
  }
}
```

Behavioral boundary tests must call `handleMcpMessage`; `handleEngineMcp` bypasses some outer boundary checks. Separately exercise packed stdio. Direct `PageExecutor` tests remain valid narrow evidence, but cannot certify the public protocol.

**Exit:** only the shared engine is a production command/ref/result authority, behavior coverage survives, current instructions/catalog match code, grouped gate failures are honest and the extracted package runs without its source checkout.

### Batch D: one packed real-task candidate, then final freeze

After integrated source checks, pack once and use that exact package for the acceptance batch. Keep source and artifacts stable while QA imports/runs them. Group new findings by root cause and fix them in a meaningful batch; do not repack after every observation.

Required task families include Wikipedia navigation, MDN/W3C search/read/code, GitHub issue filters without posting, storefront product/variant without purchase, disposable authenticated form persistence, exact rich-document persistence, real virtualized data, owned popup/tab isolation, hidden/weak-AX visual tasks and shared-login independence. Cover both owned and existing-browser modes and promised platforms. Choose exact authorized targets/data before running mutation cases.

For every case record:

```text
candidate commit/content digest + packed SHA-256
OS/browser version + mode + exact task + allowed test data
completion oracle + observed persisted effect
model tool turns + output text/image bytes or tokens
waits + retries/recovery + wall time (cold/warm separately)
cleanup result + pass/fail/unavailable reason
```

Five retained repeated samples per selected task permit raw results/medians, not a stable p95 claim. A scripted call sequence is not a model-run sample. Do not claim ChatGPT parity without an actual matched comparison.

The gate must reject absent, skipped, failed, wrong-mode or wrong-candidate critical rows. Validate receipts against the run/artifact and independent effect oracle, not merely `{ "ok": true }` in arbitrary JSON.

Then freeze source and package and complete three consecutive `pnpm release:check` passes with required platform evidence and no critical skips. A source/test/config/doc edit resets the sequence. Store generated receipts outside candidate source inventory. Final docs must distinguish verified delivery from implementation and remaining external gates. No publishing or merge without separate authority.

## 7. Efficient verification commands

Use root scripts for integration. Focused tests are useful after a concrete change; do not rerun every historical live script.

```powershell
pnpm build
pnpm typecheck
# pnpm test rebuilds the driver; do not run it concurrently with pack/build.
pnpm test
pnpm lint
```

After building, a focused selection for editing/observation/candidate integrity is:

```powershell
node --test --test-isolation=none packages/driver/test/native-edit-selection.test.mjs packages/driver/test/observation-frame-churn.test.mjs test/engine-regressions/native-selection-probe.test.mjs test/release-candidate.test.mjs
```

Discover actual regression names with `rg --files packages/driver/test test/engine-regressions apps/mcp-server/test`. If a build-output parity test fails after adding a real production module, update its explicit expected outputs; do not remove the parity assertion. If a VM fixture models `process`, include the platform used by the code under test rather than weakening production validation.

For new evidence use `test/evidence/runs/<run-id>/` for raw output, with a small reviewed Markdown summary in `test/evidence/`. Preserve command exit codes when redirecting PowerShell output:

```powershell
pnpm test *> test/evidence/runs/<run-id>/test.log
$testExit = $LASTEXITCODE
Get-Content test/evidence/runs/<run-id>/test.log -Tail 30
exit $testExit
```

Create the run directory first. Avoid hidden successful shell exits caused by a final `Get-Content` after a failed test command.

## 8. Product invariants: do not bargain these away

- Standalone uses a shared Newton login source and a separate headless browser/writable identity per worker. It never depends on extension discovery to start.
- “My browser/current profile” means explicitly selected existing-browser mode; never choose it automatically for convenience.
- Existing mode owns separate tabs per worker, permits concurrent distinct tabs, and adds no Newton permission prompts.
- Owned cleanup terminates only exact guardian-proven resources. Borrowed stop never kills the personal browser or unrelated tabs.
- No CDP TCP listener, local HTTP proxy, installed daemon, hosted service, database, telemetry or provider-model dependency.
- Never inspect profile/cookie/storage/password/history/autofill/download data. Approved copying is opaque, narrow, stable, closed-source and one-way.
- No sleeps or inflated timeouts to conceal flakes. Wait for the actual transition under the original command budget.
- No page mutation to improve observation, fake focus, synthetic selection/change events, frozen animations or request interception. Read-only isolated-world helpers and typed native input are permitted.
- Never replay uncertain input. Preserve dispatch truth and partial sequence effects.
- Every defect closure needs a deterministic reproduction, root cause, regression and evidence entry. Code presence or a worker's confidence is not closure.

## 9. Local residue, Git and reporting

The checkpoint intentionally excludes raw browser logs/JSON/captures, generated packages, local configuration and profiles. Original machine residue includes ignored `test/evidence/astra-model-v49-config/` and `astra-model-v49-package/`, plus an untracked historical `release-verification-win32.json`. These are not missing source files to add. Some earlier cleanup was denied by automatic review; do not retry the same deletion through a different tool/shell. Clean only newly owned disposable resources with verified paths and ownership.

Use Git's normal line-ending normalization when staging this Windows checkout. Disabling it caused CRLF noise and massive misleading diffs during consolidation. Inspect `git diff --check` and intended staged scope before committing. Preserve unrelated dirty worktrees. Never force-push or reset the operator's main checkout.

Keep one current status index: update `docs/PROGRESS_LEDGER.md` and consequential current architecture/roadmap facts. Keep dated run evidence separate. Do not rewrite old failures into historical passes or create another competing “everything done” report.

At the end of a meaningful batch report: what changed, exact verification, remaining failures/unknowns, candidate/artifact identity where relevant, cleanup outcome and the next concrete batch. If the assigned scope is the full implementation, keep working through the checklist instead of ending on routine progress. Missing account/platform access is a bounded external gate, not permission to relabel the unfinished matrix as complete.

## 10. Suggested continuation instruction

> Continue Newton Browser from `codex/newton-browser-consolidation-2026-09-25`, starting with `docs/implementation/CONTINUATION_HANDOFF.md` and the current progress ledger. Work alone: no subagents or other worker/task messages. Preserve the implemented shared engine and finish the remaining approved P00–P14 work in substantial coherent batches. First repair and verify source-only boundary/QA inventory, then complete model feedback/reading and edit/lifecycle/platform conformance, migrate and retire the legacy runtime, and execute packed everyday-task acceptance. Verify actual effects and exact candidate identity. Do not claim completion from 841 tests or historical three-pass receipts. Do not inspect browser secrets, merge, force-push, publish packages or change the license. Keep current ledgers accurate and state any external acceptance gates precisely.
