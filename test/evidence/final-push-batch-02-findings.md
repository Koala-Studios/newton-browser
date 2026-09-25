# Final push batch 02 findings

## Scope

This batch covers the authorized platform-neutral native artifact checks, platform layout checks, immutable range resolution, login-source clone/collect foundation, the MCP-boundary MDN oracle, and the native precise-edit feasibility cases. Production code was frozen for this batch.

## Focused evidence

- `test/engine-regressions/final-push-batch-02.test.mjs` exercises unique/contextual/occurrence/Unicode/limit range cases, Chrome/Edge Windows layout independence, Linux user-local path derivation, concurrent native runtime publication, corrupt-manifest refusal, Node SEA launcher immutability, and explicit login-source clone/collect semantics.
- `test/engine-regressions/precise-edit-native-probe.test.mjs` covers replacement, empty replacement/deletion, emoji ranges, textarea line endings, repeated contenteditable text, focus movement, trusted composition/input events, cancellation before dispatch, and composition cancellation by focus movement.
- `test/engine-regressions/final-push-batch-01.test.mjs` now starts MDN at the home page through `handleEngineMcp`, fills the returned search ref, observes returned link records, clicks the returned `Input.imeSetComposition` result ref, and asserts the click receipt destination and next observation. It no longer directly navigates to the search endpoint or masks the flow with a direct driver observation.

## Gaps and risks

- Actual Linux executable launch, chmod, native-host publication, symlink/hardlink refusal, failure during registration publication, and owned unregister preservation require a Linux browser environment and are recorded as gaps rather than passing skips on this Windows host.
- Actual Windows registry publication and cleanup require disposable HKCU registration names; pure layout key independence is covered here, but live registry mutation is not performed.
- Source CLI interactive EOF/browser-close/signal cancellation and exact closed-maintenance publication need a subprocess harness with a disposable browser; the source foundation test verifies clone isolation and explicit collect semantics only.
- The MDN oracle is network-dependent; any failure must retain the full bounded MCP receipt in the test output and must not be relabeled as a title/URL-only success.

## Required command evidence

The command, platform/browser version, pass/fail/gap result, artifact bytes, tool calls, waits, recovery entries, cleanup, and any remaining source-suite failures are appended after the required focused, build, typecheck, and full source-suite runs.

## Run record

- Environment: Windows `win32`, Node `v25.9.0`, Chrome executable discovered at `C:\Program Files\Google\Chrome\Application\chrome.exe`; live browser tests used isolated owned headless Chrome identities and private CDP. The direct Chrome version command returned no text, so the exact browser version is a recording gap.
- Focused command: `node --test --test-isolation=none test/engine-regressions/final-push-batch-01.test.mjs test/engine-regressions/final-push-batch-02.test.mjs test/engine-regressions/precise-edit-native-probe.test.mjs packages/driver/test/build-parity.test.js`.
- Focused result: 14 tests passed, 0 failed, 0 skipped, 16.9 seconds. The MDN MCP flow made 6 tool calls after session start/stop orchestration, with no recovery entries; each owned browser and temporary identity was closed and removed.
- Artifact result: runtime publication used a 20-byte entry and current Node runtime, three concurrent identical calls converged on one digest directory, and corrupt manifest reuse was refused. SEA launcher publication used a 51-byte source and current Node 25.9 runtime; the second call reused identical bytes. Exact generated binary byte count was not retained by the test output.
- `pnpm build`: passed; driver and MCP artifacts built successfully.
- `pnpm typecheck`: passed; both workspace and driver TypeScript checks passed.
- `pnpm test`: 825 passed, 4 failed, 0 skipped, 829 total, 53.0 seconds. It rebuilt the driver once before executing the source suite.

## Full-suite failures and reproduction

1. `test/engine-regressions/control-context.test.mjs:10` fails during `browser.session.start` with `{errorCode:"stale_target"}` while the live fixture performs initial observation. The same failure is timing/environment-sensitive: the batch02 focused run passed this fixture, so this remains an unproven startup-observation regression rather than a production fix in this frozen batch.
2. `test/native-launcher-validation.test.mjs:23` fails with `native_installation_invalid` in the launcher validation VM before the expected successful pinned-runtime execution.
3. `test/native-launcher-validation.test.mjs:29` fails because the tampered/oversized metadata case returns `native_installation_invalid` instead of the expected `native_installation_changed`.
4. `test/native-launcher-validation.test.mjs:35` fails because the symlinked-build case returns `native_installation_invalid` instead of the expected `native_installation_changed`.

The launcher failures share the same root symptom: the fixture's embedded launcher validation receives no valid runtime metadata and exits at its initial installation check, so the later tamper/symlink branches are not reached. No production launcher code was changed under the batch02 freeze.
