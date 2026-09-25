# Catalog factoring candidate (2026-09-08)

Authoritative checkout: `C:\Users\<user>\.codex\worktrees\421a\newton-browser`.

The old command schema serialized the same target subtree 18 times and waitFor
subtree eight times. This is wire duplication despite shared source constants.
The candidate validates both properties at each enclosing action union and leaves
empty declarations in the branches to preserve strict per-kind field allowlists.
No references, permissive catch-all, parser changes or dependencies were added.

| Measurement | Previous | Candidate |
| --- | ---: | ---: |
| Command schema UTF-8 bytes | 29,731 | 11,539 |
| Tools/list response UTF-8 bytes | 37,410 | 19,218 |
| Serialized tools array o200k_base tokens | 9,293 | 4,633 |
| Tool count | 13 | 13 |

Previous measurements: `luna-catalog-cost-analysis.md` and packed v38 cost evidence.
Candidate measurements use actual source `handleEngineMcp({},
{id:1,method:'tools/list',params:{}}, {})`, `Buffer.byteLength(JSON.stringify(response))`
and `getEncoding('o200k_base').encode(JSON.stringify(response.result.tools)).length`.
Command schema measured directly from the source export (2,940 tokens).

`pnpm build:driver` passed. `node --test packages/core/test/command-foundation.test.mjs`
passed 7/7, zero skipped, 146.8572ms. These parser checks do not prove JSON Schema
equivalence. Independent validator QA is assigned to Luna; review remains pending.
Expanded independent AJV validation subsequently covered 503 cases (55 valid,
448 invalid), with zero mismatches between factored and reconstructed expanded
schemas. Five permanent tests independently rerun and pass; see
`luna-command-schema-factoring.md`. v47 pack:check now passes with all 13 tools.
Actual model discovery/task usability remains unproven.

This does not resolve the separate open full-page screenshot spatial transition.
The current full source suite is not claimed green.
