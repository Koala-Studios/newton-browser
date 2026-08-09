# Upstream provenance ledger

## Scope

The comparative audit examined `vercel-labs/agent-browser` at commit
`acbc22bdc5d4f6c5a88d97d4a4745d3c5eb0591f` (`0.33.2`, Apache-2.0). Newton Browser's
AIP-01 through AIP-09 implementation is a specification-first, Newton-native
reimplementation. No agent-browser source file, test body, fixture, or generated artifact
has been copied or closely ported into this repository.

## Behavior references

| Newton area | Upstream behavior/defect references | Treatment |
| --- | --- | --- |
| Per-session command ordering | `cli/src/native/daemon.rs`; `16c4ef2` | Independently implemented around Newton's concurrent per-session bridge and extension controller. |
| Transactional attachment | `cli/src/native/cdp/client.rs`; `c4fc782` | Independently implemented with Newton rollback primitives and exact tab-ownership rules. |
| Target and frame routing | `cli/src/native/browser.rs`, `element.rs`; `f680354` | Independently implemented for MV3 `chrome.debugger` flattened sessions and composite Newton refs. |
| Preventive containment | `cli/src/native/network.rs`; `ce68e2c`, `74f8058`, `3cbaeee`, `6f827a4`, `302bdb0` | Defect classes converted into Newton decisions, fixtures, and tests; no source copied. |
| Input and dialogs | `cli/src/native/interaction.rs`; `4526722`, `688e285`, `83e4151` | Behavior used as a regression reference; descriptors, races, and cleanup are Newton-native. |
| Compact observations | `cli/src/native/snapshot.rs`, `output.rs` | Output principles adapted while retaining stable refs, structural provenance, and zero page-DOM mutation. |
| MCP contract | `cli/src/mcp.rs` | Annotations and schema-drift failure classes adapted to Newton's smaller semantic tool surface. |
| Evals and release maturity | `evals/`, `benchmarks/`, issue-linked history | Failure classes represented as provider-free Newton tasks and local metrics. |

## Distribution rule

If a future change copies or closely ports upstream material, this ledger must record the
exact commit and file, the modified-file notice, relevant attribution, Apache-2.0 license
delivery, NOTICE review, and legal-review disposition before public distribution. Behavior
references alone do not authorize source copying or imply Vercel endorsement.

