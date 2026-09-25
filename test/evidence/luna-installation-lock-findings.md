# Installation lock adversarial findings

## Focused verification

- Command: `node --test --test-concurrency=1 test/installation-lock-adversarial.test.mjs`
- Result: 5 passed, 0 failed, 0 cancelled, 0 skipped, 0 todo.
- Observed platform: Windows (`win32`).
- The tests use only owned temporary directories and the kernel IPC endpoint; they create no lock files, TCP listeners, daemons, application messages, or browsers.

## Covered contracts

- Independent directories can hold concurrent owners.
- Same-directory aliases resolve to one ownership key and remain exclusive.
- Missing, non-directory, and symlink roots fail before ownership is reserved.
- Repeated and concurrent release calls are idempotent and permit reuse.
- An unrelated client can connect and disconnect from the reserved Windows pipe without aborting or stealing the owner; a second owner remains rejected until release.

## Findings

- No production defects were reproduced on Windows.
- The Linux abstract-socket branch was not exercised by this Windows run. Existing exclusion and owner-process crash tests remain separate and were not duplicated here.
