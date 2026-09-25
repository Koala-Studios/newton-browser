# Native sensitive-region lifecycle evidence

## Scope

Added adversarial tests for `nativeSensitiveRegions` without changing the production module, screenshot integration, package files, builds, or unrelated tests. The tests use actual `PageDirectory`, `ReadonlyWorlds`, and `CommandContext` instances with a narrow fake CDP wire.

## Coverage

- Aggregate search counts above 32 reject with `work_limit` before `DOM.getSearchResults`, and the allocated search is discarded.
- Aggregate search counts are enforced across two distinct CDP route roots; the second route's `getSearchResults` is not called and both searches are discarded.
- Successful and failed node reads release the resolved remote object and discard the search allocation.
- Search responses and resolved remote objects that arrive after command cancellation are still cleaned up.
- Empty or non-integer search metadata, invalid node IDs, invalid execution contexts, missing remote object IDs, and missing geometry reject with `evidence_unavailable`.
- Frame removal, root navigation, and new frame membership during the read reject with `stale_target`.
- Nested cross-process frame owners project geometry through real directory route relationships.
- Invalid owner quads and child viewport sizes reject cross-process transforms, and parent or child retirement during a transform rejects with `stale_target`.
- Partial and fully outside child viewport cases assert clipping behavior.

## Verification

Focused command:

```text
node --experimental-strip-types --test --test-concurrency=1 packages/driver/test/native-sensitive-regions.test.mjs
```

Result: 10 passed, 0 failed, 0 skipped.

The expanded suite passed without reproducing an actionable production defect.

No actionable production defect was reproduced. No production files were changed.
