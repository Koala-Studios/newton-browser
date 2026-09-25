# Readonly-world adversarial findings

## Run

- Command: `node --test packages/driver/test/readonly-world-adversarial.test.mjs`
- Final result: 8 tests passed, 0 failed, 0 cancelled, 0 skipped, 0 todo
- Final duration: 136.2968 ms
- Production changes: none

The first test invocation exposed only an off-by-one expectation in the new fake wire responder. The fixture was corrected and the same permitted test file was rerun; no implementation behavior was implicated.

## Covered contracts

- Same frame/document generation/route reuses one context promise.
- Different frames have isolated cache entries and routes.
- Navigation document-generation changes invalidate cached contexts.
- Route rebinding invalidates cached contexts and sends through the new route.
- Failed creation promises are evicted so the next request retries.
- Malformed `executionContextId` values fail as `evidence_unavailable` and can retry.
- Late responses from an old navigation reject as `stale_target` without evicting the newer context.
- `clear()` removes cached contexts without corrupting directory route bindings.

## Findings

No `ReadonlyWorlds` production defects were reproduced in this deterministic unit scope. Browser integration, renderer event ordering, and cross-process wire behavior remain outside this test file.
