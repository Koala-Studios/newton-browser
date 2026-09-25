# Screenshot mask consistency findings

## Focused verification

- Command: `node --experimental-strip-types --test --test-concurrency=1 packages/driver/test/screenshot-mask-consistency.test.mjs`
- Result: 4 passed, 0 failed, 0 cancelled, 0 skipped, 0 todo.
- Fixture: real `PageExecutor.screenshot`, region discovery, spatial re-read, PNG masking, and decoded pixels with only fake CDP transport and target geometry.
- No browser, build, network, or additional dependency was used.

## Covered contracts

- Main-document discovered sensitive regions are merged with explicit zones and mask their pixels in the returned PNG.
- Incomplete sensitive-region discovery fails before `Page.captureScreenshot` and stores no capture record.
- Changed discovered region geometry rejects the image after capture but before storing a capture record.
- Changed viewport geometry rejects the image after capture but before storing a capture record.
- Failed consistency checks make exactly one capture request; no successful capture record is published.

## Findings

No deterministic consistency defect was reproduced. The tests exercise the
current parent-owned discovery, capture, spatial re-read, and region re-read
path; this assignment changed only the assigned test and evidence files.
