# Scoped control frame findings

## Focused verification

- Command: `node --experimental-strip-types --test --test-concurrency=1 packages/driver/test/scoped-control-frames.test.mjs`
- Result: 2 passed, 0 failed, 0 cancelled, 0 skipped, 0 todo.
- Fixture: real `PageExecutor.observe`, `PageDirectory.publish/resolve`, `readAXSnapshot`, and `readAXControls` with only fake CDP transport and frame-membership decisions.
- No browser, build, network, or copied production traversal implementation was used.

## Covered contracts

- A scoped root control reference resolves to the root frame and its backend node ID.
- A control discovered in an included child frame resolves to that child frame and backend node ID; a nested child control retains the nested frame identity.
- An outside sibling frame is not read or published into the scoped observation.
- The root scope backend node ID is sent only to the root partial AX read; child frames use full AX reads without the root scope ID.
- Scoped observation does not issue broad `Accessibility.queryAXTree` role probes; the focused transport assertion prevents the timeout path seen in live QA.
- Included child frames are bounded at 16; the 17th eligible child is not read and the observation is incomplete.

## Findings

The focused tests pass after the parent-owned scoped AX change that removes the
unanswered broad role-query optimization from scoped reads. This assignment
changed only the assigned test and evidence files.
