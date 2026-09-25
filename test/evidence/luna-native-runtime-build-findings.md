# Native runtime build adversarial findings

## Focused verification

- Command: `node --test --test-concurrency=1 test/native-runtime-build-adversarial.test.mjs`
- Result: 7 passed, 0 failed, 0 cancelled, 0 skipped, 0 todo.
- Fixtures are tiny inert files written under per-test temporary directories; no runtime file is executed, copied from a real Node installation, registered natively, or used to launch a browser.

## Covered contracts

- Repeated setup returns the same verified build without changing file inode or timestamps.
- Changing the source runtime does not mutate an existing verified build.
- Changing the entry content creates a separate digest-keyed build.
- Concurrent first installation converges on one build and removes all losing `.stage-*` directories.
- Missing metadata/runtime, tampered entry, and tampered metadata fail closed.
- Symlinked build directories and build members are rejected.
- Direct hash caps reject oversized input, and rejected/complete setup leaves no staging directory.

## Findings

- No production defects were reproduced by this focused suite.
- The tests do not assert automatic migration of pre-existing unsealed legacy directories; the helper contract is limited to sealing new builds and reusing verified ones.
