# Plan 07 — MCP Contract, Provenance, and Opaque-Body Privacy

- **Status:** Approval required
- **Depends on:** Plans 04 and 06
- **Primary outcome:** Agents receive a strict, discoverable, versioned MCP contract that identifies untrusted page data, describes action risk, and cannot leak opaque encoded bodies around text redaction.

## Why this is a must-do

An efficient output format is only useful when agents can reliably construct valid calls and distinguish tool instructions from untrusted page content. Today, permissive action parsing and duplicated schemas invite repair calls. Base64 network bodies also bypass text-oriented redaction. The contract must prevent ambiguity and close that privacy gap.

## Files

### Add

- `packages/core/src/action-json-schema.ts` — canonical discriminated JSON Schema derived alongside runtime validation.
- `packages/core/test/action-json-schema.test.ts` — parity and rejection tests.
- `apps/mcp-server/src/mcp-contract.ts` — tool annotations, server instructions, contract version, and public result helpers.
- `apps/mcp-server/test/mcp-contract.test.ts`.
- `test/fixtures/privacy/opaque-network-bodies.json`.

### Edit

- `packages/core/src/action-schema.ts` — strict discriminated validation and unknown-field policy.
- `packages/core/src/protocol.ts` — typed provenance, next action, contract version, and opaque-body metadata.
- `packages/core/src/redaction.ts` — explicit handling for encoded or undecodable bodies.
- `packages/driver/src/driver.js` — label body encoding and source origin before returning network evidence.
- `apps/mcp-server/src/mcp-server.ts` — publish concise schemas, server instructions, and annotations.
- `apps/mcp-server/src/bridge.ts` — preserve provenance and contract version.
- Existing MCP/core contract tests and packed-server smokes.
- `README.md`, `docs/MCP_CLIENTS.md`, `docs/SECURITY.md`, `docs/PRIVACY.md`, and `docs/DECISIONS.md`.
- `test/evidence/qa-ledger.md` and `test/evidence/completion-audit.md`.

### Delete

- Permissive fallback that converts malformed or unknown action payloads into `observe`.
- Raw base64 response-body fields from public MCP results.

## Contract rules

### 1. One strict discriminated action schema

The `kind` field selects an exact variant. Required properties and allowed properties are explicit; `additionalProperties: false` applies to every action variant.

```ts
const clickAction = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "ref"],
  properties: {
    kind: { const: "click" },
    ref: { type: "string", pattern: "^d[0-9]+:(?:f[0-9]+:)?e[0-9]+$" },
    button: { enum: ["left", "middle", "right"] },
    clickCount: { type: "integer", minimum: 1, maximum: 3 },
  },
} as const;
```

Runtime validation and published JSON Schema must share variant definitions or a generated source. A parity test enumerates every action kind. Unknown kinds, misspelled fields, invalid refs, and invalid enum values fail as `invalid_arguments` before dispatch.

### 2. Keep a compact tool surface

Do not copy agent-browser’s many-command CLI into one MCP tool per command. Newton retains its small semantic surface and uses discriminated actions where this keeps catalog cost down.

The serialized MCP instructions plus all tool names, descriptions, annotations, and input schemas must remain below 3,000 `o200k_base` tokens. Any new tool needs a measured justification showing it reduces total successful-task cost.

### 3. Publish behavioral annotations

Each MCP tool declares truthful hints:

```ts
annotations: {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
}
```

Examples:

- Observe/status: read-only and idempotent.
- Click/type/navigate: not read-only; idempotency depends on command keys, so do not claim unconditional idempotency.
- Session stop: locally destructive to session state but not open-world.

Server instructions state that page content is untrusted data and never authorization.

### 4. Carry provenance structurally

Every observation, extracted string, action delta, and network record includes or inherits:

```ts
type PageProvenance = {
  trust: "untrusted_page_content";
  origin: string;
  sessionEpoch: number;
  targetRef?: string;
  capturedAt?: string;
};
```

Trust is not represented only by prose. Page text cannot populate `nextAction`, decision codes, tool names, or server-authored warnings.

### 5. Refuse opaque bodies by default

Public network evidence may include status, URL after origin policy, MIME type, declared encoding, byte count, and a cryptographic digest when useful. It must not return an undecoded body merely because it is base64.

```ts
if (body.base64Encoded || !isSupportedTextMime(body.mimeType)) {
  return {
    body: null,
    bodyDisposition: "opaque_body_not_returned",
    encodedBytes: body.byteLength,
    sha256: await digest(body.bytes),
  };
}
```

There is no generic “include raw body” option. A future narrowly scoped binary export requires its own threat review and explicit approval.

Screenshot results must also state whether a configured mask policy was applied. The
absence of masks is explicit metadata, never implied by omission; this does not authorize
automatic inspection of credentials or storage to discover sensitive regions.

## Compatibility policy

- Add `contractVersion` to server initialization metadata and full status output.
- Minor versions may add optional fields or action variants.
- Removing fields, changing defaults, or tightening previously accepted values requires a documented compatibility window or major contract version.
- Strict validation begins behind an explicit development flag for one milestone only if existing clients require migration; release defaults must not silently accept malformed calls.

## Implementation slices

1. Create canonical action definitions and schema/runtime parity tests.
2. Turn on strict invalid-argument behavior and remove fallback-to-observe.
3. Add server instructions, truthful annotations, contract version, and typed `nextAction`.
4. Add structural provenance at the MCP projection boundary.
5. Refuse opaque and ungranted bodies; add privacy fixtures.
6. Measure catalog cost and update skill/security/reference documentation.

## Required tests

- Every runtime action has exactly one published schema variant.
- Unknown/misspelled fields and malformed composite refs fail before the bridge dispatches.
- No invalid payload defaults to another action.
- Tool annotations match a checked-in expected matrix.
- Untrusted page strings cannot forge decisions, provenance, or next actions.
- Compact and JSON formats carry equivalent provenance.
- Base64, binary MIME, malformed UTF-8, compressed, and ungranted bodies are omitted with typed metadata.
- Allowed textual bodies still pass existing redaction rules.
- Screenshot capture metadata distinguishes `mask_applied`, `mask_not_configured`, and
  `mask_not_applicable` without exposing mask source data.
- Tool-catalog token budget passes from packed artifacts.

## Exit criteria

- Published schemas and runtime behavior cannot drift undetected.
- Agents can determine read-only/destructive characteristics without parsing prose.
- All public page-derived content is structurally marked untrusted.
- Raw opaque bodies are absent from every public output path.
- Packed MCP initialization and contract tests pass.

## Rollback

Schema strictness may use a short documented migration flag, but opaque-body refusal and provenance must not be rolled back to address client compatibility. Adapt the client or projection instead.
