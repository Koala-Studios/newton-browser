# Native client adversarial findings

## Focused verification

- Command: `node --test test/native-client-adversarial.test.mjs`
- Result: 6 passed, 0 failed, 0 cancelled, 0 skipped, 0 todo
- Scope: `connectNative` over real local TCP/Windows named-pipe private IPC with a deterministic fake framed native peer. No browser or production native host was launched.
- Production changes: none.

## Covered contracts

- Advertisement endpoint validation rejects arbitrary pipe/socket redirection before dialing.
- Peer hello rejects malformed epoch, digest, capability, and expected-instance values.
- Concurrent responses are correlated by request ID despite out-of-order replies.
- Native disconnect rejects all pending calls; `close()` is idempotent.
- Read-only request timeout preserves the connection; mutation timeout closes it. Timeout advancement uses Node mock timers, not sleeps.
- Malformed peer error text is normalized to `connection_failed` and is not returned to callers.

## Findings

No production defects were reproduced in this deterministic native-client scope. The tests do not replace packed adapter/native-host acceptance, browser claim behavior, or public EngineHost inventory wiring.
