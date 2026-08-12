# Plan 04B — Isolated browser strict containment

- Status: implemented and live-proven across Windows Chrome/Edge and Linux Chrome; see
  QA-NOEXT-003
- Depends on: Plans 01–04 contracts and reuse of the strict driver/registry modules
- Preserves: no hosted Newton service, exact per-session grants, concurrency,
  no user-profile inspection, and the strict zero-first-request popup requirement; the
  Phase 0 browser-egress proof passed and became Plan 11's launch-time policy proxy
- Changes: existing-profile/current-tab mode cannot offer the same strict popup guarantee

## Architecture

Launch one Newton-owned Chromium process with an inherited `--remote-debugging-pipe` and a
new permission-restricted temporary user-data directory. Create one ephemeral browser
context and one deny-by-default loopback policy proxy per Newton session. Browser CDP
supplies target identity, resource type, and command causality; the context-specific proxy
supplies the zero-first-destination-request boundary because CDP autoattach alone does not
prove that attachment precedes browser-process network startup.

```text
MCP client -> Newton MCP host/supervisor -> private CDP pipe -> Newton Chromium
                    |                              |-> context A -> proxy A / grant A
                    |                              |-> context B -> proxy B / grant B
                    +-> process/job ownership
```

The supervisor is a normal child of the MCP host, not an installed daemon. Do not open a
remote-debugging TCP port. Unknown/bootstrap targets close fail-closed and never inherit
the union of active grants.

## Files

### Add

- `packages/browser-controller/package.json` and `tsconfig.json`.
- `packages/browser-controller/src/cdp-pipe.ts` — bounded CDP framing over inherited pipe.
- `browser-supervisor.ts` — executable qualification, process lifecycle, browser-level
  autoattach, crash handling, and ephemeral profile ownership.
- `process-supervision.ts` — Windows Job Object kill-on-close and POSIX parent-death/process
  group ownership for the complete Chromium tree.
- `policy-proxy.ts` — one capped listener per context; exact grant evaluation before any
  destination socket or HTTPS/WSS CONNECT; no direct, QUIC, or loopback bypass.
- `context-registry.ts` — exact context/session/epoch/grant state and capped target graph.
- `target-interceptor.ts` — paused-target authentication, Fetch-before-resume, close/fail
  acknowledgements, and command-scoped popup tickets.
- `session-driver.ts` — transport adapter reusing observation, input, renderer, containment,
  and target-registry logic.
- Deterministic fake-CDP, process, pipe-break, context-isolation, and live CFT suites.

### Edit

- `apps/mcp-server/src/bridge.ts` — own the supervisor and route lifecycle/actions directly.
- `apps/mcp-server/src/mcp-server.ts` — select backend without changing public tool schemas.
- MCP config/CLI/doctor — executable discovery, exact supported-version checks, bounded
  backend readiness, and explicit legacy/current-tab status.
- `packages/driver` — extract reusable target/containment/input/observation logic behind a
  transport interface; do not duplicate policy.
- Root workspace/build/pack/release scripts and live runners — compile/package/qualify the
  controller and inspect artifacts for paths, profiles, ports, credentials, and bloat.
- Extension — retain only existing-profile legacy control and optional UI during migration.
- Security/privacy/decision/progress/QA docs — state backend guarantees separately.

### Delete

- Nothing during migration. Extension deletion, manifest changes, or removal of the legacy
  backend requires separate approval after complete cutover evidence.

## Implementation

### 1. Supervisor and pipe

Resolve an explicitly configured or packaged supported Chromium/CFT executable. Launch it
with an owned temporary profile, no imported profile, first-run, or default-browser state,
and a private debugging pipe. Refuse TCP fallback. Publish readiness only after browser
autoattach acknowledgement, serialized event drain, and bootstrap-target cleanup.

Create contexts with `disposeOnDetach:true`. A pipe/supervisor failure must dispose the
context or kill the complete browser process tree; it must never reconnect and resume an
old paused target. The per-context proxy exits/fails closed with its owner and closes active
forwarding sockets. Define signal, MCP EOF, continuity-host shutdown, pipe EOF, and forced
termination paths explicitly.

### 2. Per-session contexts

Before target creation:

```ts
contextRegistry.reserve(browserContextId, {
  sessionId,
  epoch,
  grant: compileOriginGrant(origin, allowedOrigins),
  proxy: exactOwnedProxyEndpoint,
});
```

Create the context with its exact proxy configuration and no bypass list. Reserve one
bounded provisioning ticket before `Target.createTarget({url:"about:blank"})`; reconcile
event-before-response and response-before-event by exact context plus that single ticket.
Consume it once and dispose the context on ambiguity/overflow. Require the exact paused
attach, install Fetch/domains and recursive controls, then navigate to the granted initial
URL. Never authorize by opener, URL similarity, adjacency, focus, or another session.

### 3. Browser-level target interception

Use a catch-all browser autoattach filter excluding only the browser endpoint. Require
every new target to have a known context, exact session identity, and
`waitingForDebugger:true`. Explicitly handle supported types and close every unknown or
unsupported type while paused. Cover page, iframe, dedicated/shared/service workers,
worklets, prerender, portal, and downloads; deny downloads per context. Install Fetch
before resume. Close blank/opaque top-level popups unless a separately proved launch-ticket
state machine can settle them safely. Close denied concrete popups with acknowledgement
before reporting prevention. Resume allowed targets only after controls acknowledge and
the proxy policy is already active.

### 4. One causal command channel

Move action dispatch to the same external controller that receives target and Fetch events.
Each command carries session/context/epoch/sequence/token and a bounded dispatch phase.
After Input acknowledgement, perform browser-endpoint fence/drain cycles until the
serialized event queue and that command's popup tickets are stable. Failures after
committing input remain `outcome_unknown`, never retryable stale-target results.

Apply exact per-context target, paused-request, command-ticket, byte, and event caps with
fair scheduling. Use a bounded monotonic fence iteration count. Dispose only an offending
context when identity remains certain; global identity/queue corruption kills the browser
and returns uncertain outcomes to every affected command.

### 5. Fail-closed lifecycle

Session stop fences commands, closes every paused/unsettled target with acknowledgement,
disposes the exact browser context, proves its disappearance, then clears grants and
metadata. Last-session stop closes the browser, waits for exact child exit, validates the
temporary profile path, and removes it. Cleanup uncertainty retains ownership for retry;
it must not detach in a way that resumes paused targets.

Create the profile root with POSIX `0700` or a Windows user-only ACL, canonical path, owner
marker, nonce, and exact prefix validation. Never enumerate or inspect profile contents.
Place/disable crash dumps inside the owned root, wait on process/job handles instead of
polling, and recover abandoned roots only after marker plus PID/start-identity validation.
The guarantee is no user-profile access; ephemeral browser state can exist during a run.

### 6. Phase 0 feasibility evidence

The completed Phase 0 spike proved on pinned Windows and Linux browser builds:

- autoattach/filter coverage for every target mechanism;
- per-context proxy enforcement and bypass resistance for HTTP, HTTPS CONNECT, WebSocket,
  redirects, popup/noopener, worker/service-worker, and first navigation;
- zero denied destination requests during teardown and supervisor death after attach but
  before Fetch installation;
- background-browser egress is either disabled/audited or explicitly outside a narrowly
  worded local-only claim.

That evidence authorized the implemented direct backend and rejected Plan 04A. Current
receipts are indexed by `docs/PROGRESS_LEDGER.md`; this section retains the original proof
scope rather than an open implementation prerequisite.

## Migration

1. Add an explicit isolated backend while the extension backend remains unchanged.
2. Run fixture-only A/B sessions; never dual-control a target or migrate an active session.
3. Pin and qualify exact browser versions/platforms because browser autoattach is
   experimental CDP behavior.
4. Make isolated mode default only after repeated packed/live acceptance.
5. Keep `browser_control_attach_failed` for legacy strict-popup attempts; never fall back
   mid-session or mid-command.
6. Treat current-tab/existing-profile control as explicitly legacy/degraded for mutations
   that require strict popup containment.
7. Select the backend only through process configuration. Publish the guarantee once via
   bounded host-authored status/doctor output; reject strict sessions on the legacy backend
   before creation and never expose process/context IDs.

## Required tests and evidence

- All noopener anchor/window/form/programmatic and redirect popup mechanisms have zero
  denied destination requests; allowed concrete popups occur exactly once.
- Blank popup closes without resume; Fetch/domain installation always precedes resume.
- At least two concurrent contexts with disjoint grants cannot authorize across contexts.
- Unknown/default/bootstrap, malformed, portal, prerender, and ambiguous targets close.
- Popup OOPIF, dedicated/shared/service-worker, and worklet descendants retain exact
  context policy; downloads and unknown/version-introduced types fail closed.
- Controller/browser crash, pipe break, popup during teardown, delayed events, close/dispose
  retry, and command-token isolation are deterministic regressions.
- No default profile path, profile import, cookie/storage/password API, TCP debugging
  listener, unrelated browser process, page content, or raw CDP identity enters evidence.
- Network-namespace/OS-level qualification records no unapproved CFT background egress;
  launch policy disables first-run, sync, updates, speculative networking/prerender, crash
  upload, and QUIC/direct proxy fallback.
- Measure memory/start latency for context-per-session versus process-per-session before
  changing the existing session cap.
- Windows and Linux pinned-CFT live matrices, artifact inspection, installed-tarball parity,
  and three unchanged-tree release passes succeed.

## Token and bloat controls

Keep action schemas unchanged; process/context/target details remain internal. Assert the
public catalog is byte/token identical to its approved baseline rather than hard-coding a
historical count, while status/doctor exposes one bounded backend/guarantee field. Native
messaging is not the primary
transport: it adds an installed manifest and IPC layer but no browser CDP authority. A
process per session is a later hard-isolation option only after measured need; the initial
backend uses one process and one context per session.

Choose explicitly among bundled pinned CFT, installer-managed CFT, or an owner-configured
binary. Runtime downloads are forbidden. Bundled/installer assets require platform hashes,
redistribution/license approval, byte/dependency budgets, and update policy. Configured
binaries must be canonical executable files rather than wrappers and pass exact product,
protocol, and version qualification. Browser contexts are storage/authority partitioning,
not process isolation; a browser compromise or process crash crosses the availability
boundary. Require site-per-process and define a measured escalation threshold for one
process per session.

## Must not do

- No debugging TCP port, default user profile, browser-wide union grant, context inference,
  dual backend control, mid-command fallback, cookie/storage/profile access, installed
  daemon, public CDP topology, runtime browser download, proxy bypass/direct fallback,
  sleeps, or silent unsupported-version downgrade.
