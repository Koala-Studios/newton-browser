# Newton Browser Roadmap

Newton Browser is local, agent-agnostic browser control for MCP clients. This roadmap is
directional, not a public commitment. Current execution state lives in
[`docs/PROGRESS_LEDGER.md`](docs/PROGRESS_LEDGER.md) and detailed plans in
[`docs/implementation-plans/`](docs/implementation-plans/README.md).

## Implemented direct-runtime foundation

- Per-session owned Chrome/Edge process, private CDP pipe, exact blank root, and a separate
  guardian that owns crash cleanup; Windows Job Object and Unix process-group loss evidence passed.
- Per-session deny-by-default launch-time policy proxy with exact-origin grants and honest
  prevented/unknown outcome semantics.
- Opaque Newton identities, exclusive leases, operator login, and fail-closed narrow opaque
  import from a closed stable profile.
- Strict TypeScript driver, composite refs, same-process and OOPIF routing, dialogs,
  renderer lifecycle classification, and trusted input dispatch.
- Same-session FIFO plus independent cross-session concurrency.
- Compact observations, exact schemas, provenance/redaction, token budgets, provider-free
  regression corpus, packed installation, and cross-platform live harnesses. Windows
  Chrome/Edge and pinned Linux Chrome receipts passed.
- Direct stdio as the ordinary path and optional private Unix-socket continuity for
  orchestrators that intentionally need sequential-client persistence.

## Completed release gates

1. Final-tree unauthenticated read-only production-site evidence is recorded on RFC Editor, Wikipedia,
   the Mercato di Bellina commerce storefront, and the public W3C Web Accessibility
   Initiative site. No third-party account is a release dependency.
2. The exact tree passed `pnpm release:check` three consecutive times with one
   byte-identical package; the evidence-bearing confirmation follows receipt materialization.

## After the usable core is proven

- Measure startup and observation p50/p95 on real heavy sites and optimize only demonstrated
  bottlenecks.
- Improve accessible targeting and SPA recovery from real-site failure evidence without
  silent stale-ref healing.
- Consider element-target screenshots and session-start viewport convenience.
- Consider broader Chromium-family support only after exact browser/process/security QA.
- Consider multi-page workflows only with an explicit session/tab model and unchanged
  containment guarantees.

## Not planned without a new approved proposal

- Rust rewrite.
- Arbitrary JavaScript execution.
- Hosted browser providers, telemetry, analytics, or remote service.
- Cookie/storage/profile inspection or export.
- Automatic mutation retry, global cross-session mutex, or hostname-only grants.
- Recording, HAR, PDF, GIF, broad provider stacks, or dozens of narrow MCP tools without
  measured agent-task benefit.
- Firefox support under the current CDP architecture.
