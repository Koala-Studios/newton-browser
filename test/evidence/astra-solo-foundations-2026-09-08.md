# Solo implementation evidence — 2026-09-08

Authoritative checkout: `C:\Users\Frank\.codex\worktrees\421a\newton-browser`. This is source evidence, not a packed release or completed P00–P14 claim. Frank's latest instruction makes implementation and all QA solely Astra's responsibility. No worker messages, assignments, polling or subagents were used for this batch.

## Implemented

- Added the strict `edit` command to the shared schema/parser, executor and capability report. It requires an exact match, with optional immediate prefix/suffix or one-based occurrence. It preserves surrounding text and verifies the resulting value.
- Native selection uses one bounded CDP editing event plus its key release, then one text insertion (or native deletion). It starts from the nearer field edge; at most 4096 selection commands and 65536 UTF-16 value units. Grapheme-boundary mismatches and unverified selections stop before text input. No DOM selection mutation, temporary composition text, whole-field replacement fallback, sleeps or extra model turns.
- Read-only isolated-world verification checks current field text, focus, sensitivity and actual selected offsets. Contenteditable uses ranges only for measurement; ranges are never installed as the document selection.
- Fixed root observations failing when a child frame commits during AX acquisition. Stale child results are omitted with incomplete coverage; root-generation changes still fail. Published refs are checked against current frame identities.
- Added a streaming source-candidate digest and wired the existing local release script to it. Application/package source and non-run evidence remain inputs; exact build/run directories are excluded. Symlink ancestors, hard links, oversized files and file replacement while reading are rejected. This does not make the remaining release harness complete.
- Updated native-launcher VM fixtures to supply the newly required platform identity, and updated schema/output expectations for the new action/module.

## Reproductions and root causes

The first independent full suite had 835 tests: 827 passed, eight failed, zero skipped (`runs/astra-solo-suite.log`). Three failures were outdated schema/build expectations introduced by the new edit variant. Three launcher tests omitted `process.platform`, so execution stopped before their intended tamper checks. Two startup tests propagated a child's `stale_target` through an otherwise-current root observation.

The child-frame regression now has deterministic before-acquisition and after-acquisition commit cases, plus a root-commit case which must still reject. This tests the actual generation transition rather than retrying until a live fixture passes.

The earlier IME feasibility probe's focus-movement case commits its temporary text; it is not evidence of safe cancellation. The production edit path therefore uses native selection with no temporary text. Its live test cancels the command immediately after selection acknowledgement and proves unchanged field text and no input event.

## Verification

- `node --test test/release-candidate.test.mjs`: five passed, zero skipped. Includes source changes, timestamps, exact exclusions, tracked deletion, hard links, oversized files and junction traversal.
- Native selection live probe: actual owned headless Chrome; input, textarea/newlines, emoji/combining graphemes and an inline rich field. Selection leaves text/events unchanged; insertion emits trusted input. Integrated `SessionEngine` replacement, deletion and cancellation cases pass. This is not yet a persisted real-editor or existing-browser acceptance result.
- `pnpm typecheck`: passed during implementation.
- Final `pnpm test`: **841 passed, zero failed, zero skipped**, 45.995 seconds. Exact log: `runs/astra-solo-suite-02.log`. This command rebuilt the driver first.

Protocol reference: [CDP Input.dispatchKeyEvent editing commands](https://chromedevtools.github.io/devtools-protocol/tot/Input/#method-dispatchKeyEvent). Runtime behavior was verified in the browser; protocol documentation alone is not the acceptance oracle.

## Still open

Full real rich-editor normalization/persistence, selection/focus/sensitivity transition matrix, Edge/Linux and extension parity, compact feedback/closed-shadow reading, lifecycle bounds, legacy retirement and all packed real-world/three-pass gates remain in `final push.md`. The grouped test runner is still an implementation candidate pending independent validation. No public publishing occurred.
