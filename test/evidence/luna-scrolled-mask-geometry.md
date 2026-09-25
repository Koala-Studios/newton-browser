# Scrolled screenshot mask geometry findings

## Focused verification

- Command: `node --experimental-strip-types --test --test-concurrency=1 packages/driver/test/scrolled-mask-geometry.test.mjs`
- Result: 3 passed, 0 failed, 0 cancelled, 0 skipped, 0 todo.
- Fixture: real `PageExecutor.screenshot`, spatial metrics, resolver geometry, PNG masking, and decoded output pixels; only CDP transport and target resolution are faked.
- No browser, build, network, or additional test dependency was used.

## Covered contracts

- With nonzero `pageX/pageY` and visual viewport offsets, the default screenshot clip uses the document origin and masks the expected 2x2 pixel rectangle.
- An explicit document clip still converts a viewport-relative target bbox into the correct clip-relative mask rectangle.
- A target whose converted region is fully outside the clip leaves the returned PNG byte-for-byte unchanged.
- Capture requests and returned provenance retain the expected clip coordinates and scale.

## Findings

No remaining deterministic mask-geometry defect was reproduced. The tests
exercise the parent-owned spatial-coordinate fix through the real
`PageExecutor.screenshot` path; this assignment changed only the assigned test
and evidence files.
