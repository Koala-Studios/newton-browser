# Final push batch 01 QA findings

## Status

QA complete. Only the two named new test files and this findings file were
changed. No production, existing-test, packaging, or dependency files were
changed.

## Required oracles

The focused tests cover the batch handoff areas with disposable owned Chrome and local HTTP fixtures: streamed long/adjacent/Unicode text, total work-cap refusal, hidden and nested frames, outside-main content and heading-marker exclusion, loading/cancellation, AX failure metadata, expanded native combobox relationships and bounded output, stale refs and local fill, oversized/native select behavior, navigation readiness and generation changes, same-URL reload, non-replayed input, and direct public MDN search navigation. These are direct `PageExecutor` driver-level tests; they do not exercise `handleEngineMcp`.

The native feasibility probe exercises `Input.imeSetComposition` replacement
ranges followed by `Input.insertText` on an input, textarea, and
contenteditable, checks exact surrounding text and trusted native events, and
checks cancellation before any composition or insert effect. It introduces no
production support or page mutation shortcut.

## Verification record

Focused command:

```text
node --experimental-strip-types --test --test-concurrency=1 test/engine-regressions/final-push-batch-01.test.mjs test/engine-regressions/precise-edit-native-probe.test.mjs
```

Result: `7` passed, `0` failed, `0` skipped. The local Chrome oracle passed
long and adjacent-node text matching beyond 8192 characters, Unicode, hidden
and nested frames, outside-main dialog text, heading-marker exclusion, total
work-cap refusal, cancellation, AX-failure metadata, expanded combobox options
with unique refs and bounded output, ordinary ref fill without a new full AX
tree, stale refs, oversized-select refusal before focus/input, normal select
effects, loading navigation readiness, same-URL reload generation changes,
non-replayed click input, plus direct public MDN search navigation. The native
probe passed exact replacement/commit behavior and trusted event checks for
input, textarea, and contenteditable, plus cancellation before any
composition or insert.

Coverage gaps: the MDN case does not exercise a public-tool click-to-destination
feedback loop; it navigates directly to the MDN search URL and observes it.
The native probe does not test deletion semantics or cancellation after a
composition has already started.

Sequential validation:

- `pnpm build`: passed; core, driver, and MCP builds completed.
- `pnpm typecheck`: passed.
- `pnpm test`: `820` passed, `3` failed, `0` cancelled, `0` skipped out of
  `823` tests.

Preserved full-suite failures:

1. `packages/driver/test/build-parity.test.js:97`: the frozen driver build
   emits `text-edit-range.d.ts` and `text-edit-range.js`, while the existing
   expected output list omits them. This is an obsolete expected-output shape
   relative to the batch's frozen production tree, not a failure in either new
   test. No existing test was changed.
2. `test/engine-regressions/control-context.test.mjs:10` (call assertion at
   line 28): the live session-start observation returned `stale_target` before
   scoped-view assertions. This was not reproduced by the focused batch tests;
   it remains an unproven live-browser/concurrency regression.
3. `test/engine-regressions/pointer-actions.test.mjs:97`: the live
   `PageExecutor.start` initial observation returned `stale_target`. This was
   not reproduced by the focused batch tests and matches the same startup race
   pattern as failure 2; it remains unproven.

No production changes were made to investigate or mask these failures. No
pack/release or extension-registration command was run.
