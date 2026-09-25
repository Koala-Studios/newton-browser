# Control reader adversarial findings

## Run

- Command: `node --experimental-strip-types --test packages/driver/test/control-reader.test.mjs`
- Result: 3 passed, 1 failed, 0 skipped, 0 cancelled.
- Duration: 115.9194 ms.
- Scope: direct `readAXControls` helper tests with deterministic raw CDP AX graphs; no browser, profile, storage, build, or unrelated source changes.

## Passing coverage

- Duplicate buttons retain distinct row ancestor context.
- Existing container scope includes descendants and excludes outside controls.
- Empty scope differs from a missing scope.
- Cyclic ancestry terminates and marks the result incomplete.
- Long labels and more-than-three context ancestors mark the result incomplete and remain bounded.
- Description and `errormessage` relationships are deduplicated and surfaced as validation.
- A sensitive top-level AX `value` getter is never accessed.

## Genuine failure

- `packages/driver/test/control-reader.test.mjs:91` failed the checked-state contract for CDP string tristates. Expected `[true, false, "mixed"]`; actual `[undefined, undefined, "mixed"]`. The helper preserves the literal string `"mixed"` but drops string `"true"` and `"false"` instead of normalizing them to booleans.

No fixture mistake was identified for this failure: the test uses the AX property shape `{ name: "checked", value: { value: "true" | "false" | "mixed" } }` and the helper returns the mixed state while losing the boolean string states.
