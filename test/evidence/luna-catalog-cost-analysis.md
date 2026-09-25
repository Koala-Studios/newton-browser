# Catalog cost analysis

## Baseline and evidence completeness

The current packed catalog baseline is **9,293 `o200k_base` tokens**. The matching
`tools/list` response is **37,410 bytes**, contains **13 tools**, and has
`protocolOk: true`. `test/evidence/astra-packed-probes-v38-cost.json` records
these values in `outputCost.catalogTokens`, `catalog.responseBytes`, and the
first `calls[]` entry for `method: "tools/list"`; the two response-byte values
match.

The evidence artifact's stored `catalog.tools` entries are normalized summaries
containing tool names and descriptions rather than the full emitted schemas.
Therefore the repeated-subtree measurements below use the current source
exports, not the normalized catalog snapshot.

## Measured source structure

Measurements are canonical JSON byte lengths from the current exports:

| Source | Measurement | Bytes |
| --- | ---: | ---: |
| `ENGINE_COMMAND_SCHEMA` | Full serialized schema | 29,731 |
| `BROWSER_ACT_JSON_SCHEMA` | Full serialized schema | 2,837 |
| `ENGINE_COMMAND_SCHEMA` | 16 primitive action variants repeated in `sequence.steps.items.oneOf` | 14,530 duplicated second copies |
| `ENGINE_COMMAND_SCHEMA` | `target` subtree, 18 emitted copies | 633 per copy |
| `ENGINE_COMMAND_SCHEMA` | `waitFor` subtree, 8 emitted copies | 1,370 per copy |

The 16 primitive variants are exact JSON duplicates between the top-level
`action.oneOf` and the sequence item union. The source reuses the `primitives`
array, but ordinary JSON serialization expands both uses.

The shared `target` and `waitFor` constants are also expanded into each action
variant. These duplicate classes overlap, so their savings must not be added
independently.

There were no exact repeated subtrees at or above 120 bytes inside
`BROWSER_ACT_JSON_SCHEMA`. Its public `compactFieldSchemas` construction has
already removed the larger field-schema expansions from the wire form; reusing
objects in source alone does not reduce catalog bytes.

## Factoring model

Using the current `ENGINE_COMMAND_SCHEMA` as input, the following mechanical
JSON Schema factoring measurements were computed without changing repository
files:

| Transformation | Result bytes | Byte reduction |
| --- | ---: | ---: |
| Expanded baseline | 29,731 | - |
| Factor `target` only | 19,440 | 10,291 |
| Factor `waitFor` only | 20,370 | 9,361 |
| Factor both `target` and `waitFor` | 10,069 | 19,662 |
| Factor both plus all 16 repeated action variants | 7,413 | 22,318 |

The compact form uses `$defs` entries for `target`, `waitFor`, and the 16
primitive action variants, replacing expanded copies with local `$ref` values.
The action definitions retain their existing `const`, `required`,
`additionalProperties`, descriptions, and nested validation structure, so a
JSON Schema implementation that resolves `$ref` sees the same constraints and
model affordances.

## Recommendation

1. Keep the expanded catalog as the default until the MCP client matrix proves
   support for `$defs`/`$ref` during both model tool discovery and argument
   validation. The current source constants are useful maintenance factoring,
   but do not reduce the emitted catalog cost.
2. Generate a second compact schema form from the same schema source. Put the
   16 action variants, `target`, and `waitFor` under `$defs`; use references in
   both the top-level action union and sequence item union. Validate the
   expanded and compact forms against the same positive and negative command
   cases before enabling the compact form.
3. Select the compact form only for clients with verified reference support, or
   retain the expanded form for unknown clients. Without that compatibility
   gate, `$ref` support and model discoverability are unresolved rather than
   guaranteed by the MCP transport.

No production, test, or package files were changed for this analysis.
