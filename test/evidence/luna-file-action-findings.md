# File action adversarial findings

## Focused verification

- Command: `node --test packages/driver/test/file-action-adversarial.test.mjs`
- Result: 6 passed, 0 failed, 0 cancelled, 0 skipped, 0 todo
- Scope: direct `PageExecutor.act` with real temporary synthetic files, a live `PageDirectory` binding, and deterministic fake transport/resolver behavior.
- Production changes: none.

## Covered contracts

- Replacement during asynchronous target inspection is rejected with `file_changed` before `DOM.setFileInputFiles`.
- Cancellation during synchronous file preparation and asynchronous target inspection prevents dispatch and produces no late follow-up mutation.
- Disabled, non-file, and single-file-input/multiple-file requests are rejected with `target_not_editable` before dispatch.
- A uniquely targeted hidden native file input is accepted without focus or click synthesis; an acknowledged renderer name mismatch returns `not_met`.
- Renderer evidence failure after acknowledged file selection returns `evidence_unavailable`, preserves `dispatch: acknowledged`, and releases the remote object without a second file mutation.

## Findings

No production defects were reproduced in this deterministic integrated scope. Browser-renderer event timing and real DOM file chooser behavior remain outside this transport-controlled test.
