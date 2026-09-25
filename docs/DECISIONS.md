# Architecture decisions

Reconciled 2026-09-25 against the consolidated replacement source. [PROGRESS_LEDGER.md](PROGRESS_LEDGER.md) owns current implementation/verification status; [SESSION_ENGINE_DESIGN.md](SESSION_ENGINE_DESIGN.md) remains the approved target. The old direct-only decision text was superseded rather than retained as a second active contract.

## Execution and control

The default MCP path uses `EngineHost`, `SessionEngine` and `PageExecutor`. One session queue owns mutations and reads; `PageDirectory` owns page/frame generations and public refs. Commands use monotonic IDs and distinct dispatch, postcondition and observation facts. Identical retries join/retrieve the original command rather than replay input. Sequences preserve partial effect truth; they are not transactions.

Public transport is stateless MCP 2026-07-28 over newline-delimited stdio JSON, with per-request metadata and no initialization-era fallback. Stdout contains only protocol frames. The legacy direct host was retired on 2026-09-25; there is one engine path.

## Browser connections

Standalone is the complete default: one headless Chrome/Edge process and writable Newton identity per worker, blank-first startup and inherited private CDP. Startup accepts a normalized complete HTTP(S) URL. Redirects, cross-origin navigation, frames, subresources, workers and popups use ordinary Chromium networking. No TCP debugging endpoint, local HTTP control proxy, installed daemon, hosted service, database or model-provider integration is added.

A newly implemented optional thin extension/native-messaging connection permits the operator's existing browser only on explicit request. Separate workers own separate tabs and may act concurrently. Browser logic stays in the shared engine; the extension routes native operations/events and ownership. Borrowed cleanup releases claims and detaches; it does not terminate the personal browser. The old extension/relay/pairing/continuity implementation remains retired.

## Identity and cleanup

Shared standalone login comes from a closed Newton-owned source generation, copied opaquely through a narrow allowlist into separate identities. Never run competing processes against one writable profile, inspect browser secrets, merge worker changes back, or silently select the operator's personal profile. Source refresh is an explicit maintenance/publication lifecycle.

Owned browsers launch under a separate guardian; cleanup targets only the exact proven browser tree and identity lease. Cancellation prevents further ordinary input. Held key/button releases are narrowly bounded cleanup; cleanup uncertainty remains visible. Pending-start/stop and disruption stress are still acceptance work.

## Input and observation

Native input and read-only isolated-world DOM/AX inspection preserve normal site behavior. No injected selection/value mutation, synthetic change event, focus emulation, animation freezing or request interception is an accepted substitute. Native select is bounded and single-selection only. Exact-match editing uses bounded native selection plus verified native insertion/deletion; unsupported ranges fail before text replacement, and no whole-field fallback is hidden.

Actions return bounded useful next state where available. Discovery cannot rewrite action dispatch truth. Controls preserve context and validation; records/deltas and document cursors report partial coverage honestly. Child-frame churn discards that child's stale observations without invalidating an unchanged root. Root generation changes still invalidate old references. Full compact-feedback and closed-shadow document acceptance remain open.

Screenshots use native sensitive-region discovery and trusted host-side masking, with bounded image output and coordinate provenance. Source support and historical packed tests do not establish every hidden-tab/full-page/backend edge case.

## Delivery truth

Distinguish source implementation, automated fixtures, live browser probes, packed artifacts and completed real tasks. The replacement requires everyday online acceptance in both modes, platform coverage and three unchanged packed release gates. A Git checkpoint is not a release certificate. Historical receipts remain bound to their exact tested candidate.
