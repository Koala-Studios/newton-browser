# Newton Browser progress ledger

## Active program — normal-browser direct runtime

Newton has one local architecture: stateless MCP `2026-07-28` on stdio, one isolated
owned Chrome or Edge process per session, private CDP pipes, ordinary Chromium networking,
and ten compact tools.

The 0.5.1/0.5.2 exact-origin proxy architecture was retired after real login and public
site evidence showed a systemic incompatibility pattern: valid regional redirects were
blocked, required CSS/font/image/API resources were denied, controls could become inert,
and browser-generated `ERR_BLOCKED_BY_CLIENT` pages replaced the real site. The current
implementation removes that network boundary instead of accumulating provider-specific
allowlists.

## Definition of complete

| Gate | Required evidence | State |
| --- | --- | --- |
| Single architecture | no extension, relay, daemon, socket continuity, current-tab, legacy MCP, proxy, origin grants, or Fetch containment | pass: boundary scan |
| Modern MCP | exact 2026-07-28 metadata/discovery/result/cancellation; old handshake/framing rejected | pass: deterministic and packed discovery |
| Normal browser behavior | redirects/resources/frames/workers/popups/background dependencies are not denied or rewritten by Newton | pass: Chrome/Edge cross-origin navigation and nested-frame live proof |
| Rendering integrity | no network-altering launch flags, injected UI, focus emulation, persistent observers, or script/animation freeze | pass in source; representative live surfaces render without Newton block/error signatures |
| Direct runtime | source and exact-packed start/observe/act/screenshot/stop in Chrome and Edge | pass: seven-stage source suites and packed artifact |
| Concurrency | same-session FIFO, cross-session progress, distinct processes/identities, zero residue | pass: Chrome and Edge live |
| Frames/input/lifecycle | same-process and nested OOPIF actions, owned popup/new-tab activation and opener restoration, dialogs, renderer/process loss, guardian cleanup, stale-ref fencing, bounded same-document ref recycling | pass: deterministic plus current-tree Chrome/Edge secondary-page live proof |
| Compact output | token budgets, flat actions, one canonical result shape, image-only screenshots | pass: 2,816-token catalog and 658-token workflow |
| Real-site usability | usable video, community, commerce, advertising, reference, and standards pages; no blocked/error pages or raw icon ligatures | six surfaces pass in Chrome; Reddit's clean-profile public surface remains externally unavailable and is not rewritten or allowlisted |
| Packaging | exact tarball install/run, source-free artifacts, bounded receipts, zero residue | pass: Chrome and Edge, identical SHA-256 |
| Authorized opaque import | closed local profile copied through the narrow opaque allowlist, source untouched, owned identity cleanup | final QA pending |
| Release stability | three consecutive unchanged-tree release checks after all live QA and documentation freeze | final gate: recorded by consecutive release command receipts without post-run source edits |

## Current implementation inventory

- Deleted: MV3 extension/store assets, relay/pairing, socket continuity, legacy MCP,
  finalize aliases, policy proxy, origin-grant configuration/CLI, CDP Fetch interception,
  request denial, popup containment tickets, and blocked-origin result metadata.
- Retained: isolated process/profile ownership, guardian cleanup, private CDP pipe,
  application session IDs, FIFO/idempotency, target/frame topology generations, identity
  leases, trusted input, post-action verification, raster masking, bounded console/network
  evidence, and authorized opaque profile import.
- Removed page interference: persistent main-world observers, focus emulation, script
  disabling, animation freezing, and browser flags that disable normal services.
- Corrected dynamic-page targeting: attached waits no longer require visibility, hidden
  responsive selector duplicates are ignored when exactly one visible match exists, and
  selector/semantic fill may refresh a target only before any input is dispatched.
- Session-owned secondary pages are bounded and isolated as page contexts. Newton discovers
  but does not attach to or activate a provisional blank target. After the page commits to
  HTTP(S), it is attached, configured, activated, and given a fresh registry. Closing it
  restores a freshly rebuilt opener context; browser chrome is never clicked.
- Public MCP: ten tools; no resources, prompts, daemon, subscriptions, or
  connection-scoped state. Session start accepts one initial `origin`, plus optional
  browser-family and identity selection.
- Network response bodies remain a read-output privacy boundary: Newton returns text only
  for the current visible origin. This does not block the browser request.
- Post-dispatch integrity: background POST/GraphQL/telemetry is not an action gate;
  `prevented` is pre-dispatch only, and uncertain dispatched input is never retry-safe.

## Evidence policy

Final receipts under `test/evidence/` identify the exact source digest, platform,
browser/runtime versions, bounded results, package hash/entries, residue facts, and release
pass ordinal. They may contain fixed codes, counts, categories, and hashes only; never
credentials, profile contents, private page content, or raw CDP logs.

`bugs.md`, comparative audits, and earlier receipts are historical engineering records.
They do not describe the current network contract unless explicitly marked current.

## Current Windows evidence

- Build and strict typecheck: pass.
- Deterministic tests: 480 passed, 0 failed, 0 skipped.
- Evaluations: 41 passed; agent-cost catalog 2,845/3,000 tokens and workflow
  658/2,100 tokens.
- Chrome and Edge source live suites: seven of seven stages pass for each family. The
  direct-runtime stage replaces 260 controls through four same-document generations,
  observes 250 nodes each cycle, opens and controls a secondary page, restores its opener,
  then continues navigation and exact cleanup. Windows Edge uses its family-specific
  compatibility-layer bypass so inherited private CDP pipe handles survive startup.
- Exact 0.6.3 packed artifact: Chrome and Edge pass start/observe/click/cross-origin
  navigation/stop/cleanup from the identical 120,511-byte artifact with SHA-256
  `a0108eccfd96a9934426eb41315556e7c12dd3feabe3f1490cabfb64a7059b3f`.
- Release stability is the last external gate. Its three consecutive command receipts are
  authoritative because writing their result back into this file would change the tested
  source digest after the fact.
- Real public sites: video, commerce search/fill, advertising, reference, accessibility,
  and standards surfaces pass without Newton block pages or raw icon ligatures. Reddit's
  clean-profile public surface returns insufficient content; it is retained as a bounded
  negative external-site receipt rather than weakened into a false pass.
