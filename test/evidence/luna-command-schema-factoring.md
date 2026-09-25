# Command schema factoring findings

## Permanent focused verification

- Command: `node --experimental-strip-types --test --test-concurrency=1 packages/core/test/command-schema-factoring.test.mjs`
- Result: 5 passed, 0 failed, 0 cancelled, 0 skipped, 0 todo.
- Permanent tests use existing runtime dependencies only.

The tests verify that:

- `target` and `waitFor` are declared at the enclosing action object and at
  `sequence.steps.items`.
- Every primitive branch retains `additionalProperties: false` and `{}`
  placeholders for hoisted fields, preserving per-kind allowlists.
- All 16 primitive branches plus the sequence branch remain present.
- Reconstructing the expanded schema from the parent definitions and branch
  placeholders yields 18 target occurrences and 8 `waitFor` occurrences with
  no empty placeholders.
- Every primitive kind and enum alias is exercised standalone and inside a
  sequence. Valid and adversarial commands also cover malformed hoisted fields,
  target semantic requirements and length limits, wait dependency combinations,
  forbidden sequence-level fields, nested sequences, and per-kind boundaries.

## Independent real-validator QA

Temporary `ajv-cli` draft-07 validation was run with `--strict=false` against a
generated corpus of 55 valid and 448 invalid command files for both:

- The current factored `ENGINE_COMMAND_SCHEMA`.
- A reconstructed expanded schema produced from the factored parent properties
  and branch placeholders.

The valid corpus includes all 19 primitive kinds and aliases standalone and in
one-step sequences, semantic target forms, target and selector length edges,
wait strategies, primitive field limits, root field limits, and a 32-step
sequence. The invalid corpus removes required fields, injects every
cross-kind property, replaces hoisted fields with null/string/array values,
violates target semantics and lengths, breaks wait dependencies, places fields
at forbidden sequence levels, nests sequences, and crosses per-kind limits.

All four validator runs exited successfully:

| Schema | Valid corpus | Invalid corpus |
| --- | ---: | ---: |
| Factored | 55/55 passed | 448/448 passed |
| Reconstructed expanded | 55/55 passed | 448/448 passed |

The two schemas had 0 mismatches across all 503 cases. The temporary validator
package and generated files were outside the workspace and were removed after
QA.

## Findings

No schema-factoring regression was reproduced. Production and package files
were not changed; this assignment changed only the assigned permanent test and
evidence files.
