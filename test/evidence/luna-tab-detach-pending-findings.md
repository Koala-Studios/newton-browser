# Tab detach pending adversarial findings

## Focused verification

- Command: `node --test --test-concurrency=1 test/tab-detach-pending-adversarial.test.mjs`
- Result: 4 passed, 1 failed, 0 cancelled, 0 skipped, 0 todo.
- The failing test is retained as a deterministic regression repro. Fake debugger promises and callbacks are event-driven; no sleeps, browsers, builds, or production changes are used.

## Covered contracts

- Synchronous debugger command throws reject cleanly without an unhandled command promise.
- Owned release remains pending while debugger detach is pending and does not report false success.
- Asynchronous detach failure quarantines the claim and rejects pending commands with cleanup uncertainty.
- Synchronous detach failure is expected to normalize identically and preserve quarantine.
- A detach failure on one tab does not affect an unrelated usable tab.

## Finding

- `TabClaims.revoke()` does not normalize a synchronous `api.detach()` throw. The first `bounded(this.api.detach(...))` expression invokes `detach` before `bounded()` receives a promise; the catch path then invokes it again, and the second synchronous throw escapes as the raw `detach_sync_throw` instead of `detach_failed`. The claim remains quarantined and pending commands are not silently successful, but callers receive the wrong error contract.
- The four non-synchronous cases passed without unhandled rejection warnings.
