# Tab popup claims adversarial findings

## Focused verification

- Command: `node --test --test-concurrency=1 test/tab-popup-claims-adversarial.test.mjs`
- Result: 4 passed, 0 failed, 0 cancelled, 0 skipped, 0 todo.
- Tests use only a fake debugger API with controlled promises; no browsers, sleeps, builds, or production changes.

## Covered contracts

- Failed child attachment removes only the failed child reservation and leaves the opener claim usable.
- Owner disconnect waits for a pending child attachment, then revokes both opener and child claims.
- An already-owned child rejects popup inheritance without disturbing either existing owner.
- Claim capacity rejects a new popup while preserving the opener, and quiescence rejects new claims after revocation.

## Findings and scope

- No production defects were reproduced by this focused `TabClaims.claimPopup` suite.
- Existing owner inheritance, recursive popup inheritance, synchronous reservation exclusion, and opener-release races remain covered by the baseline popup-claims tests. These tests do not claim full browser popup support or worker/client integration.
