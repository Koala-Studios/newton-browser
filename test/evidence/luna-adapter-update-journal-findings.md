# Adapter update journal adversarial findings

## Focused verification

- Command: `node --test --test-concurrency=1 test/adapter-update-journal-adversarial.test.mjs`
- Result: 5 passed, 0 failed, 0 cancelled, 0 skipped, 0 todo.
- Tests use only owned temporary directories and inert byte buffers. The child-exit case uses an inline `node -e` module script and adds no fixture file.

## Covered contracts

- Returned journal records are immutable snapshots rather than mutable internal state.
- Malformed, oversized, and symlink `update.json` records fail closed and release the installation lock.
- A forced journal write/rename failure retains the prior recovery record in the live journal object, poisons later writes, and leaves no staging file.
- Replacing the journal root is detected before a transition writes.
- An actual child exit leaves a pending `prepared` journal snapshot available to a new opener.

## Findings and scope

- No production defects were reproduced by this focused persistence suite.
- This validates the journal primitive's bounded record and recovery-state behavior only. It does not prove the complete browser update or rollback wiring, nor does it claim recovery of an externally replaced journal path beyond the tested live-object behavior.
