# Newton Browser Roadmap

Newton Browser is local, agent-agnostic browser control for MCP clients. This roadmap is
directional, not a public commitment. Current execution state lives in
[`docs/PROGRESS_LEDGER.md`](docs/PROGRESS_LEDGER.md). Completed transition plans were
removed from the active tree and remain available in Git history.

## Implemented direct-runtime foundation

- Per-session owned Chrome/Edge process, private CDP pipe, exact blank root, and a separate
  guardian that owns crash cleanup; Windows Job Object and Unix process-group loss evidence passed.
- Ordinary Chromium networking inside each isolated owned browser. The retired
  deny-by-default proxy and origin-grant model are not compatibility options.
- Opaque Newton identities, exclusive leases, operator login, and fail-closed narrow opaque
  import from a closed stable profile.
- Strict TypeScript driver, composite refs, same-process and OOPIF routing, dialogs,
  renderer lifecycle classification, and trusted input dispatch.
- Same-session FIFO plus independent cross-session concurrency.
- Compact observations, exact schemas, provenance/redaction, token budgets, provider-free
  regression corpus, packed installation, and cross-platform live harnesses. Earlier
  Windows Chrome/Edge and pinned Linux Chrome receipts proved the direct-runtime
  foundation but predate the modern MCP/contract collapse and are historical only.
- Stateless MCP `2026-07-28` over newline-delimited stdio JSON as the sole control plane.

## Current release gate

The modern-only deterministic, packed, live Chrome/Edge, pinned Linux Chrome,
real-public-site, cleanup, and authorized opaque-import matrices passed on 2026-08-12.
Three local unchanged-tree release executions follow the documentation freeze. A public
release remains a separately approved clean-tag workflow with matching Windows/Linux
three-pass receipts; local implementation completion is not publication authorization.

## After the usable core is proven

- Measure startup and observation p50/p95 on real heavy sites and optimize only demonstrated
  bottlenecks.
- Improve accessible targeting and SPA recovery from real-site failure evidence without
  silent stale-ref healing.
- Consider element-target screenshots and session-start viewport convenience.
- Consider broader Chromium-family support only after exact browser/process/security QA.
- Consider multi-page workflows only with an explicit owned-session/tab model and exact
  lifecycle cleanup.

## Not planned without a new approved proposal

- Rust rewrite.
- Arbitrary JavaScript execution.
- Hosted browser providers, telemetry, analytics, or remote service.
- Cookie/storage/profile inspection or export.
- Automatic mutation retry or a global cross-session mutex.
- Recording, HAR, PDF, GIF, broad provider stacks, or dozens of narrow MCP tools without
  measured agent-task benefit.
- Firefox support under the current CDP architecture.
