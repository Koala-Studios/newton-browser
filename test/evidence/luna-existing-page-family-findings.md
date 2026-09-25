# Existing page-family adversarial findings

## Focused verification

- Command: `node --test --test-concurrency=1 test/existing-page-family.test.mjs`
- Result: 4 passed, 0 failed, 0 cancelled, 0 skipped, 0 todo.
- Tests inject a fake `NativeClient` with controlled events and recorded calls; no browsers, native sockets, builds, or production changes are used.

## Covered contracts

- Browser-attributed owned popups are accepted while foreign and stale opener tokens are ignored.
- Child CDP commands carry the child claim token.
- OOPIF routes remain bound to their owning claim, and a cross-claim route collision closes the client.
- Closed children lose their routes and late events cannot resurrect them.
- Popup events buffered before the first engine listener are delivered once that listener subscribes.
- Connection close releases only owned claims and issues no browser-wide target discovery commands.

## Findings and scope

- No production defects were reproduced by this focused page-family suite.
- This validates the injected existing-page-family composition only; it does not claim browser, native-client, worker, or full popup support.
