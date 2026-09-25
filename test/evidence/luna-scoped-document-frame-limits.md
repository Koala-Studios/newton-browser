# Scoped document frame-limit findings

## Focused verification

- Command: `node --experimental-strip-types --test --test-concurrency=1 packages/driver/test/scoped-document-frame-limits.test.mjs`
- Result: 6 passed, 0 failed, 0 cancelled, 0 skipped, 0 todo.
- Fixture: deterministic `PageExecutor` and `PageDirectory` state with stubbed document bindings; no browser, build, network, or copied traversal implementation.

## Covered contracts

- The root and participating child frames share the 262,144-character work budget. A child receives only the remaining character allowance, and later children are not read after the shared allowance is exhausted.
- The root and participating child frames share the 50,000-node work budget. A child receives only the remaining node allowance, and later children are not read after the shared allowance is exhausted.
- At most 16 child frames participate in one scoped document read; a 17th eligible child is excluded and the result is marked incomplete.
- Sixteen nested descendants are discovered even when frame records are registered deepest-first, exercising the bounded multi-pass traversal without relying on parent-first insertion order.
- A continuation expires after a participating child is removed with `detachFrame`.
- A continuation expires after a participating child navigates and receives a new document generation.

## Findings

No deterministic defect was exposed in the tested character budget, node budget,
16-child cap, nested traversal, or continuation invalidation paths. Production
files were not changed.
