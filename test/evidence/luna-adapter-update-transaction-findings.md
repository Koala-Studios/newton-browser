# Adapter update transaction adversarial findings

## Focused verification

- Command: `node --test --test-concurrency=1 test/adapter-update-transaction-adversarial.test.mjs`
- Result: 7 passed, 0 failed, 0 cancelled, 0 skipped, 0 todo.
- Tests use real owned temporary installation/stage directories built through `prepareAdapterDirectory`; each staged manifest is copied byte-for-byte from the installed manifest. Bootstrap controls return inert protocol records and no browser is launched.

## Covered contracts

- Successful update preserves the extension installation identity, exact manifest bytes, and valid `readAdapterDirectory()` metadata.
- A wrong bootstrap digest rolls the worker back to the previous build.
- When both update and rollback bootstrap attempts fail, the journal remains recoverable and `recoverInstalledAdapter()` completes the rollback.
- An unfinished journal blocks a second update.
- A committed journal is treated as already committed and does not reload, replay bootstrap, or run smoke.
- Failure cleaning a prior committed marker preserves the exact prior journal ticket and prevents a replacement update ticket.
- Recovery rejects worker bytes outside the journal's recorded previous/next set.

## Findings and scope

- No production defects were reproduced by this transaction-composition suite.
- These tests validate the transaction and recovery primitives only. They do not establish live browser update acceptance, extension reload behavior, or end-to-end public update wiring.
