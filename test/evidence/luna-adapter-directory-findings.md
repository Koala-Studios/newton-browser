# Adapter-directory adversarial findings

## Focused verification

- Command: `node --test --test-concurrency=1 test/adapter-directory-adversarial.test.mjs`
- Result: 7 passed, 0 failed, 0 cancelled, 0 skipped, 0 todo.
- Tests use only per-test `mkdtemp` roots and remove those roots with recursive cleanup.

## Covered contracts

- Concurrent first setup materializes one stable identity and preserves packaged worker bytes.
- Repeated setup of an existing identity does not silently replace the installed worker or key.
- Malformed, partial, foreign, and byte-tampered roots fail closed.
- Symlinked roots and symlinked artifact members are rejected.
- Altered source permissions and unexpected `host_permissions`, `content_scripts`, and `web_accessible_resources` are rejected.
- Malformed and `null` source or installed metadata is rejected.
- Invalid source artifacts leave no destination or staging directory behind.

## Findings

- No production defects were reproduced by this focused suite. Filesystem permission semantics remain platform-specific and are not treated as part of the installation byte-integrity contract.
