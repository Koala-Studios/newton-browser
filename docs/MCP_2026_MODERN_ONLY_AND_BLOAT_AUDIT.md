# MCP 2026 modern-only and bloat audit

> Historical audit. Its stateless MCP and compatibility-removal conclusions remain
> current. Policy-proxy and containment references were superseded by the normal Chromium
> networking decision on 2026-08-19; see `docs/DECISIONS.md`.

Date: 2026-08-12

This audit records the implemented target and the final verification questions. It is
based on the MCP `2026-07-28` schema and migration guidance, plus a repository-wide source,
test, package, documentation, and skill review.

Primary protocol references:

- [official 2026-07-28 TypeScript schema](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/schema/2026-07-28/schema.ts)
- [official discovery contract](https://modelcontextprotocol.io/specification/2026-07-28/server/discover)
- [official stdio transport contract](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports)
- [official 2026-07-28 release explanation](https://blog.modelcontextprotocol.io/posts/2026-07-28/)

## Modern MCP target

Newton implements one stdio protocol:

- newline-delimited JSON-RPC 2.0;
- protocol version and client capabilities in each request `_meta`;
- `server/discover`, `tools/list`, `tools/call`, and cancellation;
- `supportedVersions:["2026-07-28"]` and server information in discovery;
- `resultType:"complete"` on every successful result;
- bounded cache metadata for discovery and tool catalogs;
- concurrent request admission with bounded in-flight work, duplicate-ID rejection,
  cancellation, linear fragmented-line assembly, bounded ordered backpressure-safe output,
  terminal output-failure handling, and EOF cancellation.

It deliberately does not implement `initialize`, `initialized`, session headers, SSE,
HTTP, sockets, `Content-Length` framing, notifications other than cancellation, resources,
prompts, roots, sampling, elicitation, tasks, subscriptions, or compatibility negotiation.
The explicit `sessionId` returned by `browser.session.start` is application data, not a
protocol session: current MCP guidance explicitly recommends visible tool handles when a
workflow needs state across otherwise stateless requests.

## Removed compatibility and duplication

### Control plane

- legacy MCP frame parser and initialization state;
- Unix-socket persistent host/client mode;
- redundant `eval:live`, `release:complete-local`, and `config print` command aliases;
- the live-QA fallback from its dedicated browser selector to production browser config;
- extension, relay, pairing, browser-store, and current-tab paths;
- orphan marketing-site assets and automatic GitHub Pages deployment;
- obsolete add-on discovery planning and transition-program test filenames;
- public host-instance labels and connection epochs.
- precursor release receipts and extension-era audit/discovery/QA matrices that were not
  evidence for the modern frozen tree.

### Session lifecycle

- finalize/handoff/detach/deliverable variants;
- retained-tab semantics and synthetic numeric tab IDs;
- duplicate stop/finalize public tools.
- active-session-derived browser-family mirrors from idle public status.
- permissive cleanup wrappers that treated a lost acknowledgement as retained state
  without consulting the authoritative session inventory.

The sole public cleanup operation is `browser.session.stop`; `browser.stop_all` composes it
across sessions.

### Driver

- owned versus unowned browser/tab branches;
- Chrome-global fallback debugger transport;
- page-effects/overlay adapter and page-controlled overlay filtering;
- duplicate extension-oriented attach arguments.

The root TypeScript contract treats unused locals and parameters as errors; removed
surfaces cannot leave silently compiled implementation debris behind.

The direct driver always receives one private debugger port for one exact root target.

### Public actions and results

- nested target compatibility objects;
- result aliases such as `actionStatus` and a duplicate `verified` boolean;
- unused permission/approval classes and feature flags from the former controller plane;
- redundant device metadata;
- screenshot `inline`/`file` delivery and caller-selected output paths;
- public process, proxy, target-session, profile-path, and lease identities.
- an active-session-derived identity count that could not prove post-session cleanup;
- fixed-success config and fixed-zero buffer placeholders in operator doctor output;
- unkeyed full-status diagnostics that could not identify the relevant concurrent session;
- unused host-policy labels, route classes, permissive-default switches, deny lists, and
  wildcard origin matching.
- duplicate floor fields (`blocked`, reason arrays, and evidence arrays) that restated the
  authoritative class, boundary, and one bounded reason;
- routine `origin_granted` reasons on successful operations; reasons now explain only a
  meaningful block or commit classification;
- console-buffer mutation: `browser.console` is a read-only evidence tool and no longer
  exposes a clear flag;
- duplicate session descriptors in `browser.session.start`; start now returns one session
  ID and canonical origin, with full state available only from the list/status tools;
- duplicate session attachment/live-origin fields that could contradict the authoritative
  lifecycle state and page observation provenance;
- private frame-routing flags and count summaries routed through the production host for
  tests; live frame acceptance now uses public observations and verified effects;
- nested-result diagnostic fallbacks from earlier MCP response shapes;
- cancellation results that did not distinguish queued work from possibly dispatched work.
- unconstrained sensitive-zone reference strings; zones use the same composite-ref grammar
  as every other element-targeted action.
- empty-line stdio compatibility behavior; every input line is exactly one JSON value.

Actions use flat target fields. Screenshots return MCP image content only. Action results
have one canonical outer status/outcome/decision shape. Page-derived observations, screenshots,
console entries, and network records additionally carry bounded untrusted-content
provenance; ordinary control acknowledgements do not fabricate page provenance.

Screenshots cross the host boundary only when the runtime supplies a closed mask
disposition and canonical PNG/JPEG bytes with a matching signature. Metadata is redacted
before publication, malformed image data fails closed, and the public result never
contains a filesystem path or duplicate inline-data field.

Cancellation is phase truthful: a queued command reports `not_started` and is retry-safe;
a running command remains in the session FIFO until its executor settles and reports
`outcome_unknown`, which is not retry-safe.

Resolved element facts are evaluated inside the direct session FIFO immediately before
dispatch. This preserves password/payment/PII blocking and structural commit metadata
without a controller compatibility layer or a race-prone pre-queue lookup.

The source live suite and exact-packed live suite are separate release stages. The packed
browser workflow is not redundantly rerun inside the source suite; each reproducibility
pass executes each once per browser family and verifies one artifact hash. Public
third-party real-site evidence runs once per required browser/platform outside the three
reproducibility repetitions, so an upstream consent/challenge/availability change cannot
rewrite the artifact verdict.

The recursive source test discovery already includes the eval fixtures and quick-smoke
tests. Release and CI therefore do not execute those exact files a second time. The root
build also relies on the driver build's required core compilation instead of compiling
core twice. Focused `eval` and `smoke:quick` commands remain available for diagnosis.

## Retained complexity that is not bloat

- application session IDs: they identify concurrently owned browser processes, not MCP
  transport state;
- FIFO queues and idempotency: they prevent overlapping input and duplicate effects;
- target/frame generations and dead refs: they fence stale actions across navigation and
  OOPIF churn;
- policy proxy plus browser interception: the proxy prevents network egress while CDP
  provides causal outcomes and popup/target control;
- guardian and identity leases: they make host-loss cleanup ownership-exact;
- outcome uncertainty: it prevents unsafe retries after a possible commit boundary;
- trusted raster masking: page DOM overlays cannot be a security boundary;
- opaque profile import: optional operator-authorized authentication convenience with no
  parsing, export, or merge-back.
- one strict config/profile-store resolver shared by MCP and identity utilities; explicit
  path overrides must be absolute, bounded, non-root paths, and first use creates only the
  exact owned config directory.
- one exact origin-limit model: one primary plus at most 31 additional grants, at most 32
  canonical origins total, no repetition of the primary in the additional-grant input,
  and no canonical origin longer than 512 characters;
- one immutable per-host policy snapshot loaded from the selected config directory;
  command evaluation never reloads policy from process-global state;
- operator-authored host manifests only: there is no compiled-in vendor-default merge,
  and one exact origin cannot appear in multiple manifests;
- an offline exact-tarball install gate with audit/funding disabled and no unused native
  image dependency.
- one pinned exact tokenizer for the agent-cost gate; no environment-injected tokenizer
  or heuristic byte-count fallback can weaken release budgets.
- production browser ownership always uses the compiled guardian; raw TypeScript is never
  an alternate launch path.

## Final audit gates

The implementation freeze reached every product-level gate below on 2026-08-12. The
unchanged-tree release repetitions run after the documentation freeze, and the clean-tag
cross-platform publication verifier remains a separate release operation.

1. no production/package/active-doc/skill reference to deleted architectures or aliases;
2. exact modern request metadata, discovery, cache, response, cancellation, line and
   concurrency limits, malformed input, duplicate IDs, omitted unknown error IDs, and EOF behavior;
3. the ten-tool catalog rejects retired arguments and nested targets;
4. the driver has no global Chrome dependency or alternate ownership path;
5. packed artifacts contain only the allowlisted runtime files and behave identically in
   Windows Chrome/Edge and Linux Chrome;
6. Chrome and Edge pass live direct runtime, concurrency, containment, input/frame,
   screenshot, crash, cleanup, and real-public-site workflows;
7. three unchanged-tree `pnpm release:check` passes produce the required evidence; each
   pass must report the same candidate digest and `sourceUnchanged:true`. Intentional
   tracked deletions are explicit digest records rather than missing-path failures.

## Primary MCP sources

- <https://blog.modelcontextprotocol.io/posts/2026-07-28/>
- <https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/schema/2026-07-28/schema.ts>
- <https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/support-2026-07-28.md>
- <https://modelcontextprotocol.io/specification/2026-07-28/server/discover>
- <https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio>
