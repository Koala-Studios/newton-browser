# Tab create claims adversarial findings

## Focused verification

- Command: `node --test --test-concurrency=1 test/tab-create-claims.test.mjs`
- Result: 5 passed, 0 failed, 0 cancelled, 0 skipped, 0 todo.
- Tests use only fake tabs and debugger APIs with event-gated promises; no browsers, builds, sleeps, or production changes are used.

## Covered contracts

- Creation requests a blank inactive tab and claims it before navigation.
- Failed debugger attachment removes only the newly created tab and preserves existing claims.
- Disconnect and quiescence wait for pending creation cleanup and never grant late ownership.
- Concurrent creation reserves capacity before tab creation completes and rejects the 33rd claim.
- A foreign claim that intervenes before ownership cannot be removed by the failed creator.

## Findings and scope

- No production defects were reproduced by this focused `TabClaims.createTab` suite.
- These tests validate the claims primitive only; host, MCP, native, and browser integration remain outside scope.
