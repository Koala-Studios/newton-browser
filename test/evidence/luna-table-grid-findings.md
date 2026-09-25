# Table-grid adversarial findings

## Run

- Command: `node --test packages/driver/test/table-grid-adversarial.test.mjs`
- Result: 5 passed, 1 failed, 0 cancelled, 0 skipped, 0 todo
- Duration: 117.6427 ms
- Production changes: none

## Passing coverage

- Multiple row and column spans preserve one source-cell identity per occupied slot, positions, links, and literal rectangular slots.
- The 64-column bound is accepted and the 65-column case returns `unsupported/work_limit`.
- Explicit headers override scoped associations; missing and duplicate DOM-ID references remain unresolved.
- Row-group headers do not associate across groups.
- Empty text, blank text, and empty logical slots are preserved.
- Duplicate row and cell identities return explicit `unsupported/duplicate_identity` results.

## Genuine defect preserved as a failing regression

The test `explicit headers override scoped associations and preserve unresolved malformed references` fails at the self-reference assertion. A header cell with `domId: "self"` and `explicitHeaders: ["self"]` returns `headersUnresolved: false`; the expected result is `true` because the malformed self-reference cannot establish a header association and P07 requires unresolved structure to be reported rather than guessed.

The implementation currently recognizes the self ID as a unique header, then skips adding it because it is the same cell, but does not set the unresolved flag. The failing test remains in `packages/driver/test/table-grid-adversarial.test.mjs`; production source was not changed.
