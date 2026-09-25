# Record-delta adversarial findings

## Run

- Command: `node --test packages/driver/test/record-delta-adversarial.test.mjs`
- Final result: 6 tests passed, 0 failed, 0 cancelled, 0 skipped, 0 todo
- Final duration: 144.3197 ms
- Production changes: none

The first invocation exposed only a test-side reconstruction mistake: the helper looked up nested form field IDs as top-level records. The helper was corrected to locate nested fields by `recordId`, then the same permitted test file was rerun successfully.

## Covered contracts

- Added, changed, removed, and unchanged records reconstruct in explicit `delta.order` order.
- Unchanged controls and nested form fields receive fresh actionable refs through `delta.refs`.
- Scope and record-shape changes reset with `incompatible_scope` rather than applying a delta.
- Page and document-generation changes reset with `document_changed`.
- Incomplete baselines reset with `incomplete_view`.
- A baseline remains usable through the cache window and then resets with `baseline_unavailable` after eviction.
- A 2,048-byte output budget returns `unavailable/output_budget` instead of a partial compact delta.

## Findings

No compact record-delta production defects were reproduced in this deterministic unit scope. Browser/renderer integration and record extraction correctness remain outside these tests.
