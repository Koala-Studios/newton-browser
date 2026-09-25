# Adapter CLI update adversarial findings

## Focused verification

- Command: `node --test --test-concurrency=1 test/adapter-cli-update.test.mjs`
- Result: 4 passed, 0 failed, 0 cancelled, 0 skipped, 0 todo.
- Tests invoke `handleUtilityCommand()` directly with an isolated `NEWTON_BROWSER_CONFIG_DIR`, capture only its JSON stdout, and use owned temporary installation directories. No native registration, browser, packed rebuild, or live connection is used.

## Covered contracts

- Missing and semantically invalid update/recover flags fail as `adapter_invalid_arguments` before config mutation.
- Duplicate and unknown flags fail as parser-level `utility_invalid_arguments` before config mutation.
- `adapter status` reports `updating` while another owner holds the installation lock.
- `adapter status` reports `recovery_required` with the unfinished journal phase.
- `adapter status` reports `not_installed` without creating the installation directory.

## Findings and scope

- No production defects were reproduced by this focused CLI suite.
- These tests cover utility-command validation and status-state reporting only; they do not claim native connection, browser, packed artifact, or live update success.
