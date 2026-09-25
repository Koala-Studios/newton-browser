# Action new-pages projection findings

## Focused verification

- Command: `node --test --test-concurrency=1 packages/driver/test/action-new-pages.test.mjs`
- Result: 4 passed, 0 failed, 0 cancelled, 0 skipped, 0 todo.
- Tests use a real `PageExecutor` with fake connection/wire state, seed the `actionPages` baseline, and stub only `observeLocalFeedback`. No browser, build, or native baseline capture is exercised.

## Covered contracts

- Unchanged pages are excluded and no second browser observation is requested.
- New pages are bounded to eight entries with bounded title/URL metadata, opener identities, and no automatic selection.
- Escaped receipt byte budgets are tested at an exact returned-size boundary with crowded local controls and long metadata.
- Control trimming marks the observation incomplete with `output_limit` without setting `newPagesIncomplete` when page candidates were not truncated.
- Cancellation while a known attachment is pending aborts the projection through the command context.

## Findings and scope

- No production defects were reproduced by this focused projection suite.
- Baseline capture, native attachment behavior, live popup discovery, and schema/live QA remain outside this isolated projection test.
