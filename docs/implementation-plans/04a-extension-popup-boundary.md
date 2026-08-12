# Plan 04A — Extension-only popup boundary

> Rejected historical alternative. Newton removed the extension control plane and chose
> the isolated owned-browser containment architecture in Plan 04B. Nothing in this file
> describes a supported current mode.

- Status: rejected and superseded by Plan 04B
- Depends on: Plan 03 and the implemented non-popup portions of Plan 04
- Preserves: existing-profile control, extension-only deployment, local-only operation,
  unrelated-tab isolation, and concurrent sessions
- Gives up: a zero-first-request guarantee for arbitrary script-created top-level popups

## Contract

Newton continues to prevent ungranted navigation, mutation, connection, frame, OOPIF,
worker, and redirect effects inside the attached target tree. Before dispatching a click
or form activation, it additionally blocks directly identifiable declarative `_blank`
destinations outside the exact session grant.

An ungranted declarative destination returns:

```ts
{
  ok: false,
  errorCode: "ungranted_target",
  outcome: "prevented",
  status: "blocked",
  retrySafe: true,
}
```

No input is dispatched. A directly granted declarative `_blank` action may be dispatched
under an explicit `permitted_declarative` lease mode, but the guard is not armed to close
its popup and the new tab does not become part of the session. Its result is
`completed/dispatched_unverified/retrySafe:false`. Event handlers can substitute another
target after inspection, so this path is authorized input dispatch, not verified popup
completion or network containment.

Arbitrary script popups are not pre-network contained. If Chrome supplies an exact
`openerTabId` for a controlled tab, Newton closes the new tab with acknowledgement and
returns `unexpected_popup_closed/outcome_unknown/failed/retrySafe:false` when the event is
still attributable to the command. Close failure faults only that session. Missing-opener
and `noopener` script popups are outside the guarantee and must not be guessed or closed.

## Files

### Add

- `packages/driver/src/declarative-target.ts` — read-only extraction and normalization of
  anchor/area and form `_blank` activation facts.
- `packages/driver/test/declarative-target.test.js` — table-driven evidence and grant cases.

### Edit

- `packages/driver/src/driver.ts` — remove unsupported browser-target attachment; require
  root Fetch plus tab-root frame/worker autoattach; run declarative preflight immediately
  before input.
- `packages/driver/src/controller.ts` — own the prepared-activation transaction, serialize
  popup events, preserve exact preventive/uncertain envelopes, and fault only the owning
  session on close uncertainty.
- `packages/driver/src/chrome-tabs-port.ts` — central bounded `tabs.onCreated` demultiplexer,
  durable exact-opener leases, and acknowledged close/removal observation.
- `apps/extension/src/service-worker.js` — synchronously register the creation listener,
  hydrate capped owned-tab leases from `chrome.storage.session`, and gate readiness/input
  on hydration without storing URLs or content.
- `packages/core/src/protocol.ts`, MCP projection/tests, and agent-cost fixtures — expose
  one host-authored `topLevelPopupContainment:"declarative_only"` capability through
  startup/full status, never through page-authored data or every action result.
- Driver/controller/port tests — setup, preflight, concurrent opener attribution, stale
  generation, close failure, current-tab command leases, and cleanup.
- `test/fixtures/origin-containment/` and
  `scripts/smoke/origin-containment-live.mjs` — split declarative prevention from
  script-popup uncertainty and retain exact server counters.
- `README.md`, `docs/SECURITY.md`, the Newton Browser skill reference, decision/progress/QA
  ledgers — publish the narrowed boundary without implying network sandboxing.

### Delete

- Browser-control session state, `Target.attachToBrowserTarget`,
  `Target.autoAttachRelated`, related-launch tickets, browser-root popup authentication,
  browser-session popup fences, and their now-dead setup error codes/tests. Retain the
  generation-scoped root target-event queue, latched failure, root causal roundtrip, and
  stable drain required for OOPIF/worker setup.

## Implementation

### 1. Make ordinary startup representable again

Attach only to the owned/current tab. Install root Fetch and tab-root recursive controls
for OOPIFs/workers. `containmentReady` becomes true only after those acknowledgements and
their event fence. Never catch `browser_control_attach_failed` and continue through a
partially initialized browser-session state.

### 2. Extract direct declarative destinations

Resolve the fresh backend node and frame route in an isolated world with unpoisoned
platform methods. Support every committing activation path: pointer click, targeted
Enter/Space, implicit form submission, and internal trusted fill/press paths. Support:

- nearest activating `<a>` or `<area>`, effective target including `<base target>`, and
  the resolved direct `href`;
- submit button/input, exact form owner, `formtarget`/form-target precedence, and
  `formaction`/form-action precedence.

Return only structured facts to trusted driver code:

```ts
type DeclarativeActivation = Readonly<{
  kind: "link" | "form";
  target: "_blank";
  destination: string;
  targetId: string;
  sessionId: string | null;
  frameId: string;
  targetGeneration: number;
  sessionGeneration: number;
  documentEpoch: number;
  rendererEpoch: number;
  backendNodeId: number;
}>;
```

Accept only normalized HTTP(S) destinations and cap every returned field. Revalidate the
entire route, node, epochs, generations, and destination immediately before Input.
Delegated handlers and click-time mutation cannot be proven absent; denied declarative
evidence is therefore a conservative pre-dispatch policy block, while every permitted or
ambiguous activation remains unverified. Redirect destinations must never be reported as
preflight prevention.

### 3. Prepare, arm, and commit atomically

The controller must not separate preflight from lease arming with unrelated awaits:

```ts
const permit = await driver.prepareActivation(action);
await popupLeases.arm(permit, commandToken);
return driver.executePreparedActivation(permit);
```

`executePreparedActivation` revalidates the sealed permit before any pointer movement,
key dispatch, or other page-observable input. Every failure path disarms the exact permit.
Lease modes are explicit: `permitted_declarative` does not close the expected popup;
`unexpected_popup_guard` closes only an exactly attributed popup; a denied declarative
permit never dispatches Input. Ambiguous activation is rejected or dispatched unverified
only with the unexpected-popup guard armed.

### 4. Add a durable exact-opener guard

Maintain one capped internal registry:

```text
openerTabId -> sessionId + generation + optional commandToken + leaseMode + ownsTab + incognito
```

Register and persist before committing input. Attribute only an exact
`createdTab.openerTabId` match
with the current generation. Never use focus, active tab, window, URL, timing, or “the only
new tab.” Register `tabs.onCreated` synchronously at service-worker module initialization,
hydrate `chrome.storage.session` through one readiness promise, and reject committing input
if persistence/hydration is uncertain. Owned-tab guards may persist for delayed effects;
current-tab guards exist only during a Newton command. Remove persisted and memory state
with acknowledgement during stop, detach, removal, rollback, and restart reconciliation.

Use a central serialized popup-event queue. The listener synchronously captures the exact
lease/generation and increments its pending count before asynchronous work. Command
completion stops accepting command-attributed events, drains captured events, awaits close
acknowledgements, applies uncertainty precedence, removes the command lease, and only then
emits the result. Shutdown drains the same queue before lease or opener cleanup. A close is
acknowledged only after an event-before-response-safe removal observation or authoritative
post-remove absence; never retry an ID after ownership becomes uncertain.

### 5. Preserve honest outcomes

Closing a created tab is not prevention. A counter of zero is supporting fixture evidence,
not permission to upgrade an uncertain outcome. Late events are closed/faulted when exactly
attributable but cannot rewrite a command result already delivered.

Add `unexpected_popup_closed | popup_close_failed` as a closed uncertainty union. Both map
to `outcome_unknown/retrySafe:false`, never to containment prevention. The active command's
popup latch takes precedence over an otherwise completed driver delta. Close failure
degrades the session; later commands rejected before Input may be `not_started`, but the
uncertain original action is never replayed.

## Required tests and evidence

- Denied anchor, area, form, `formtarget`, `formaction`, `<base target>`, relative URL,
  port, and scheme cases block before any Input call.
- Cover disabled/non-submit controls, external `form=` owners, implicit/image submission,
  Enter/Space, target casing/named/empty targets, `<base href>`, shadow boundaries,
  download links, credentials in URLs, malformed URLs, and mutation between prepare/commit.
- Granted direct targets dispatch once as unverified; same-origin redirect-to-denied is not
  falsely preclassified.
- Two simultaneous sessions with distinct opener tabs never cross-close.
- Missing opener/noopener events do not mutate unrelated tabs.
- Reused tab IDs, stale generations, overflow, stop, restart, and rollback clear leases.
- Caps for leases, created-tab events, and pending closes reject before Input and never
  evict; two sessions cannot claim one opener. Worker restart hydrates owned leases before
  readiness, and persistence failure prevents committing input.
- Root target events emitted before `Target.setAutoAttach` response remain serialized; a
  later child setup rejection prevents readiness.
- `window.open`, programmatic `anchor.click`, and popup redirect cases return uncertainty
  when exactly attributed; they are never `prevented`.
- Windows Chrome/Edge and Linux CFT run the full non-popup matrix plus the narrowed popup
  matrix with bounded receipts and no raw URLs/tab IDs/page content.
- Full build, typecheck, test, pack, token, artifact, and three final release passes run on
  the unchanged final tree.
- Startup/full-status capability disclosure is host-authored, versioned, and included in
  catalog/token snapshot gates.

## Must not do

- No browser-root CDP fallback, root-browser `setAutoAttach`, broad DNR/webRequest rule,
  main-world `window.open` patch, prefetch/HEAD probe, timing attribution, global session
  mutex, unattributed-tab close, public topology diagnostic, sleep, or wider timeout.
