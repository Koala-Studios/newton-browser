# Foundations to implement before dependent Spark work

F0–F4 are now implemented as a candidate. Read [the execution certificate](EXECUTION_LOG.md)
and [the execution index](../IMPLEMENTATION_GUIDE.md) first. The snippets below are the
original design specification, not authoritative API declarations. Use the actual source
types and certificate when extending the candidate. Do not paste a sketch over working
foundation code or recreate an existing owner in an integration adapter.

## F0 — Freeze contracts and independent oracles

Owner recommendation: implement here. Write paths: new core contract files, existing
`protocol.ts`, `action-schema.ts`, `action-json-schema.ts`, `index.ts`, contract tests,
and the new regression harness described in VERIFICATION.md. Coordinate the eventual
catalog cutover with P09; do not advertise unfinished tools during this packet.

### F0.1 Public surface

Keep the current tool entry points where their purpose remains valid. Change their payload
contract once in the replacement candidate; do not retain aliases for all old budgets and
status vocabularies. Add only the missing page and command-recovery operations.

| Tool | Replacement behavior |
| --- | --- |
| `browser.session.start` | Full URL for a new page; explicit existing-tab claim without navigation; return initial useful state and mode/capabilities |
| `browser.act` | One action or bounded typed sequence; canonical receipt plus requested/default state |
| `browser.observe` | Controls, records or document reads with one byte budget and truthful scope |
| `browser.screenshot` | Trusted masked raster with page/document/viewport provenance |
| `browser.pages` (new) | Bounded inventory or explicit selection of session-controlled pages; return selection state |
| `browser.command` (new) | Read a retained command or request cancellation; status/cancel is outside the action queue |
| `browser.status`, `browser.sessions.list` | Cheap host/session diagnostics; no implicit browser-wide scan |
| `browser.session.stop`, `browser.stop_all` | Independent ownership-specific stop; stop_all means this host's sessions |
| `browser.console`, `browser.network` | Preserve bounded, redacted diagnostic functionality through the engine; no hidden action authority |

Inventory every currently accepted action and argument before changing the catalog.
The coverage table in P04/P05 is mandatory. Do not drop upload, history navigation,
dialogs, resize or diagnostics merely because the new happy-path demo does not use them.
If a capability cannot be supported on one backend, return an explicit capability error;
never silently substitute a different browser or fake success.

Use this discriminated start shape as the implementation target:

```ts
type StartRequest =
  | { mode?: "owned"; url: string; sourceId?: string }
  | { mode: "existing"; connectionId?: string;
      target: { kind: "new_tab"; url: string }
            | { kind: "tab"; tabId: number; instanceId: string } };
```

`mode` omission means owned. The server does not infer mode from the URL, source login,
available extension or an English phrase. The skill/client translates the operator's
explicit current-browser request into `mode: "existing"`. If several existing connections
match, return their bounded live labels/IDs and a selection conflict; do not guess a profile.
Existing-tab selection observes in place and verifies the browser instance and fresh tab
metadata. The new-page HTTP(S) requirement is not a reason to reload an existing tab.

Normalize a new-page URL once, preserving path, query and fragment. Reject unsupported
schemes, embedded username/password and invalid/over-limit input before browser launch.
Store `url` and its derived origin separately. Origin is not a network grant and must not
truncate the initial destination. The shared source is selected by explicit/default
source configuration, not by reviving the old exact-origin identity-binding requirement.

### F0.2 Receipt facts

Replace `verified + outcome + retrySafe + changed:boolean` inference chains with distinct
facts. The session engine is the only constructor of terminal receipts. The executor
reports facts to it; the MCP layer only encodes them.

```ts
type Dispatch = "not_started" | "attempted" | "acknowledged";
type FinishReason = "completed" | "rejected" | "failed" | "cancelled" | "timed_out";
type Postcondition =
  | { state: "not_requested" }
  | { state: "met" | "not_met" | "unknown"; kind: string };
type PageStamp = Readonly<{
  pageId: string;
  frameId: string;
  documentGeneration: number;
}>;
type StepReceipt = Readonly<{
  index: number;
  dispatch: Dispatch;
  postcondition: Postcondition;
  errorCode?: string;
}>;
type CommandReceipt = Readonly<{
  sessionId: string;
  commandId: number;
  state: "finished";
  reason: FinishReason;
  dispatch: Dispatch;
  postcondition: Postcondition;
  nextCommandId: number;
  page?: PageStamp;
  steps?: readonly StepReceipt[];
  stoppedAt?: number;
  errorCode?: string;
  observation: { state: "none" | "available" | "incomplete" | "unavailable" };
}>;
```

The final core types must replace open-ended `kind`/`errorCode` strings in this compact
example with the catalog's closed unions. The typed observation payload is defined once
in `read-contract.ts`; do not invent a second success envelope around it. Image content
remains a separate MCP image block with its own byte controls.

`acknowledged` means all attempted normal input primitives relevant to this command have
known acknowledgements. Any unresolved primitive makes aggregate dispatch `attempted`.
It does not mean the requested postcondition, remote save or business outcome succeeded.
`completed` means execution finished; it does not change a `not_met` postcondition to `met`.

Focus, scrolling, hover, keydown, text input, navigation, resize, dialog handling and file
attachment count as potentially effectful preparations/input. A focus event can change
the page before text is rejected. Ordinary read-only CDP commands do not count as input.
Input release is separately tracked cleanup; a failed cleanup cannot make original input
disappear. Do not return a universal retry-safe boolean. `not_started` proves absence of
tracked browser input, not that retrying the unchanged request will now work.

Minimum receipt truth table:

| Scenario | Dispatch | Postcondition | Finish reason |
| --- | --- | --- | --- |
| Invalid target before any preparation | not_started | not_requested/unknown as applicable | rejected |
| Read-only field rejected before focus | not_started | not_met (value) | rejected |
| Field becomes sensitive after acknowledged focus | acknowledged | not_met (value) | rejected |
| Text input sent, acknowledgement lost | attempted | unknown (value) | timed_out/failed |
| Text acknowledged, final value differs | acknowledged | not_met (value) | completed |
| Correct local value, optional reader fails | acknowledged | met (value) | completed; observation unavailable |
| First batch step changed, second rejected | aggregate includes first dispatch | per-step facts retained | rejected with stoppedAt |
| Navigate acknowledged but CDP reports error | acknowledged | not_met (navigation) | failed |

Implement table-driven tests against these facts before integrating the old host.
Fixture oracles must observe the actual input/event/page state, not infer it from the receipt.

### F0.3 Bounded command IDs without replay holes

This is a design detail the high-level proposal left open. Use a monotonically increasing
positive integer `commandId` **within an opaque session instance** for mutating requests.
Start and action responses return `nextCommandId`. A small client helper may carry it;
the model should not need another status call to obtain it.

Why: arbitrary reusable IDs plus a bounded TTL cache cannot distinguish an expired old
ID from a never-used ID without an unbounded tombstone set. A per-session high-water mark
can. Do not implement "cache miss means execute" for an old mutation ID.

Admission algorithm, all synchronous until the entry is reserved:

1. Parse and canonicalize the request; exclude transport request IDs from its fingerprint.
2. If the command ID is retained, require identical canonical content and return the same
   active promise/record or terminal receipt. Different content is `command_id_conflict`.
3. If ID is at or below the admitted high-water mark but no record remains, return
   `command_expired`; do not execute it.
4. If ID is not exactly high-water plus one, reject `command_sequence_gap`.
5. Check queue count/byte capacity before consuming the ID. Reserve the entry and advance
   the high-water mark before the first await. Queue-full rejection does not burn an ID.
6. Retain active entries regardless of TTL. Retain terminal redacted receipts within a
   bounded count/TTL; never retain input values or CDP bodies just for idempotency.

Reads may use private queue operation IDs; they must not consume mutation IDs behind the
caller's back. `browser.command` distinguishes retained, expired and never-admitted IDs.
Expired commands cannot be recovered with invented success; an operator can investigate
the current page before deciding on a new command. Host restart invalidates old session
IDs. This is no promise of exactly-once business effects across a crash.

Initial centralized limits: 32 waiting actions, 1 MiB serialized queued input, 256 terminal
records, ten-minute terminal retention, 32 steps per batch. These reuse current practical
ceilings where possible; they are engineering defaults, not performance claims. Active
work and cleanup get their own bounded slots and are never silently evicted.

### F0.4 Read contract and budgets

```ts
type ReadRequest =
  | { kind: "none" }
  | { kind: "controls"; scope?: string; query?: string; maxBytes?: number;
      baselineId?: string }
  | { kind: "records"; shape: "table" | "links" | "form";
      scope?: string; maxBytes?: number }
  | { kind: "document"; scope?: string; cursor?: string; maxBytes?: number };
```

Replace `scope?: string` with a closed union of page, current dialog and container ref
in the actual contract; it is not a selector-expression language. Matching semantics,
default scope and limits belong in core. Retain selector targeting as an explicit typed
choice, not an arbitrary expression embedded in `scope`.

Freeze an initial default text envelope budget of 8 KiB and a maximum of 64 KiB. Validate
minimum feasible requests; do not promise to squeeze any receipt into an arbitrary byte
count. Determine required bounded metadata and step-receipt reserve **before input**.
If a requested budget cannot fit mandatory facts, reject the request before dispatch.
Enforce the final UTF-8 size after redaction and actual serialization, including wrappers.
Screenshot bytes are separate. Diagnostic CDP work limits are separate from output size.

Always retain scope, provenance, completeness, command facts, and cursor/baseline validity.
Only optional page-derived content may be reduced. Never slice serialized JSON. Never
drop a batch's already-dispatched prefix to fit an unexpectedly small envelope.

## F1 — Command execution and stop

Owner recommendation: implement here. Write paths: F1 files in the index; host provisioning
integration; narrowly required `input-dispatcher.ts` and pipe lifecycle changes; F1 tests.

### F1.1 Clock and context

Use `performance.now()` for execution deadlines. Inject a monotonic clock and scheduler
in tests. Wall-clock timestamps are evidence labels, never deadline arithmetic.

The small runnable examples accompanying this guide demonstrate budget checking and
dispatch accounting. The full context additionally owns cancellation, stage changes,
pending operations, cleanup, and the finalization guard. Its input API must enforce:

See [examples.ts](examples.ts) and [examples.test.mjs](examples.test.mjs). Run them with
`node --test docs/implementation/examples.test.mjs`. These are isolated teaching examples,
not F1's queue, route validation, transport cancellation or lifecycle implementation.

```ts
// Integration sketch: only the context may invoke an effectful connection method.
async function fillOne(ctx, target, desiredValue) {
  ctx.assertActive();
  const before = await target.readFacts(ctx);
  requireEditableNonSensitive(before); // Fail closed on unknown facts.
  await ctx.input("focus", () => target.focus(ctx));
  const finalFacts = await target.readFacts(ctx);
  requireSameBinding(before.binding, finalFacts.binding);
  requireEditableNonSensitive(finalFacts);
  await ctx.input("replace_text", () => target.replaceText(ctx, desiredValue));
  const after = await target.readFacts(ctx);
  return { postcondition: compareIntendedValue(after, desiredValue) };
}
```

`replaceText` is a sequence of trusted key/text primitives; each primitive uses the input
wrapper and checks remaining budget. Do not let the enclosing call mark one attempt while
an uninstrumented nested dispatcher issues several later inputs. The actual API should
provide an input scope to prevent double accounting. Focus/scroll wrappers must not call
an alternative uncancelled transport path.

The input wrapper marks attempted **before** handing the primitive to transport; marks
acknowledged only when that primitive returns an acknowledgement; preserves uncertainty
on failure after that boundary. An adapter may report a proven pre-write rejection with
a typed fact, but arbitrary exceptions cannot erase an attempted input.

After every await, check cancellation/deadline before starting another stage. Passing
`AbortSignal` to a function that ignores it does not meet this requirement. Register every
in-flight operation with the context so the engine knows whether execution has quiesced.
Read/floor facts are bound to the exact page/frame/document/backend node being acted on.

### F1.2 Queue state machine

Implement a small explicit scheduler, not a general job framework:

```text
admitted -> queued -> running -> finished
                       |
                       +-> cancellation requested -> reconciling -> finished
                                                               \-> quarantined
```

One action/batch and its coherent returned read occupy the lane. Public coherent reads
queue behind it. Diagnostics, cancellation and stop never queue behind it. Distinct
session engines have independent lanes. There is no profile-wide action lane.

The queue's outward promise and executor's lifetime are separate facts. A timeout must
not free the lane just because the outward promise rejected. Abort the context, prevent
later dispatch, and wait for the actual executor/in-flight operation to settle within a
bounded reconciliation period. If that cannot be established, quarantine the lane and
use the backend lifecycle path. Do not execute a following mutation through uncertainty.

Ordinary actions return their useful final receipt directly. Exceptional cancellation
may expose a small `reconciling` command record while bounded cleanup runs; it is not a
general background-job API and does not permit polling every click. A terminal receipt
is immutable. Later separately observed page facts must not rewrite it as if the earlier
command had known them at completion.

Required state-machine tests use deferred promises, not sleeps:

1. Hold a primitive after attempted dispatch; expire the clock; reject later primitives.
2. Confirm a second action has not begun while the first is held.
3. Release the acknowledgement; reconcile and prove that only then can the lane advance.
4. Never release it; invoke stop; prove owned termination proceeds independently.
5. Run status and a second session while the first is held; both remain responsive.
6. Cancel a queued command; it never calls target resolution or transport.
7. Cancel during a batch's second step; preserve the first step's observed effect.
8. Throw during cleanup; preserve dispatch facts and retain ownership quarantine.

### F1.3 Independent stop

Stop ordering is mandatory:

1. Synchronously close admission and mark the session stopping.
2. Reject/cancel queued operations without dispatch.
3. Request active-context cancellation and bounded input release.
4. Start ownership-specific cleanup immediately, independently of the queue drain promise.
5. Owned mode: use the existing guardian/runtime close path and exact-tree escalation.
6. Existing mode: revoke the exact claim generation and detach; never kill Chrome.
7. Release an identity/claim only after its cleanup proof. Failure retains quarantine and
   a retryable cleanup operation; it must not pretend the session was cleanly deleted.

Do not write `await engine.drain(); await runtime.close()`. That is the audited deadlock
shape. Do not "fix" it by starting two competing cleanup owners. One lifecycle operation
is memoized and idempotent; repeated stop calls join it. Host-wide close awaits all owned
cleanup results with `allSettled` and preserves each failure independently.

### F1.4 Integration acceptance

The foundation owner must connect the new engine to a real owned browser before handing
it off. Required path: full URL start → initial controls → ref fill → local value evidence
plus useful returned state → stop. Run it through `handleMcpMessage`, not only by directly
calling a driver helper. Use a fixture input whose focus handler changes it to a password
field as the negative case. No secret is entered. Optional-read failure must not alter
the input receipt. A held executor must not prevent exact owned-browser cleanup.

## F2 — Page directory, route fencing and owned adapter

Owner recommendation: implement here. Write paths: F2 files, necessary extraction from
`target-registry.ts`/`direct-debugger-port.ts`, related tests and low-level transport wiring.

### F2.1 One identity hierarchy

```ts
type Binding = Readonly<{
  connectionEpoch: string;
  claimGeneration: string;
  pageId: string;
  frameId: string;
  documentGeneration: number;
  backendNodeId: number;
}>;
```

The owned adapter creates a stable per-connection claim generation too, so the engine
does not invent a second binding type for extension mode. This does not imply a borrowed
tab or extension exists in standalone mode.

Public refs are opaque monotonic session-local tokens, e.g. `e1`, `e2`; their strings do
not need to encode browser session IDs. A ref maps to one Binding and is never reassigned
to a different node. Snapshot ID and document generation are different counters.

Maintain bounded maps for pages, frames, routes and public refs in this module only.
Begin with two retained public control snapshots and a hard 1,024-ref ceiling. Evict only
when publishing returned state, report expired snapshot IDs, and never allocate refs for
private verification. A local fill response may reuse its input ref without rebuilding a
full public snapshot. If a new view supersedes an old one, return the replacement explicitly.

### F2.2 Event cases

Implement and test these cases separately:

| Event/fact | Directory change |
| --- | --- |
| Main-frame new document, including reload at same URL | Increment that document generation; invalidate its old bindings |
| Same-document history/hash change | Update location, retain live document identity |
| Child frame navigation | Invalidate that frame subtree only; retain unrelated parent/sibling refs |
| Out-of-process frame attached/swapped | Reconcile its logical frame with its new CDP session; reject old route events |
| Late detach from old child session | Must not delete a newly attached replacement route |
| Page closed | Retire its refs/routes; select a live opener only by the documented policy |
| One attributable popup | Return it explicitly; documented follow behavior is visible in the receipt |
| Multiple or unattributable popups | Keep the admitted page; return bounded candidates |
| Extension disconnect/reload | Retire old connection/claim epoch; no old ref or command can silently reattach |

Bind the page at queue admission, not when an action eventually starts. If a queued action
has no explicit page ID, record the current active page then. A later popup cannot redirect
it silently. A batch also records document assumptions and stops on unexpected change.

### F2.3 Narrow connection seam

The engine consumes scoped commands/events and lifecycle capabilities. It does not know
Native Messaging framing, executable paths or registry keys. The adapter does not know
what a textbox, record table or business success means.

```text
connection.open/create/claim page -> scoped page route
connection.sendRead(route, allowed method, params, context)
connection.sendInput(route, allowed method, params, input scope)
connection.events -> directory/lifecycle subscribers
connection.release(claim) -> confirmed or quarantined
connection.closeOwnedTree() -> owned capability only
```

Use typed method/parameter subsets at the adapter seam and validate route ownership before
each send. Never let model-supplied CDP method strings, raw session IDs, function source,
arbitrary URLs for internal IPC, or shell commands reach that seam.

CDP response correlation cannot await an event callback that itself sends a CDP command.
Dispatch responses independently; perform bounded topology updates without deadlocking
the response path. An overflow is an explicit connection failure/quarantine, not silently
dropped detach/navigation events. Preserve event order within a route when it affects
identity. Optional logging must not delay topology or responses.

### F2.4 Existing code extraction rules

- Reuse target-registry tests for stale routes, frame swaps, embedding chains and limits.
  Move their assertions to the new directory API without deleting negative cases.
- Preserve private-pipe frame parsing and response validation. Do not replace it with an
  HTTP listener, TCP remote-debugging endpoint or generic WebSocket service.
- Remove synthetic browser/root token translation only when the new route owner assumes
  its validation obligations and the forged-session tests still pass.
- Do not copy `ownedPageContexts`, `discoveredOwnedPages`, `lastNodes` and registry maps
  into several new files. Decide which facts the single directory actually needs.
- Add a test where a protocol event handler issues a CDP request and its response arrives
  before the handler finishes. It must complete without widening a timeout.

## F3 — Shared login source and process facts

Owner recommendation: implement here before P10. The prototype proves opaque copying of a
fixture login, not the source lifecycle. Do not paste its sole-launcher closure callback
into production as a generic "closed" verifier.

### F3.1 Storage model

Keep this in the existing local filesystem store, not a database. A logical source has a
Newton-owned ID, browser family, currently published generation ID and optional maintenance
state. A generation is an immutable, narrow opaque authentication snapshot. A worker's
writable profile is a separate Newton identity tagged with its source generation.

No metadata contains cookie values, storage records, personal source paths in model output,
passwords, browser history, or copied file contents. Reuse the existing opaque allowlist
and its symlink/escape/stability/file-count/byte checks. Do not widen it to whole profiles,
Preferences, extensions, restored tabs or caches to make a single provider pass.

### F3.2 Publication algorithm

1. Resolve the configured Newton source; acquire its narrowly scoped publication lease.
2. Preserve the last published immutable generation while maintenance is active.
3. Open a dedicated Newton-owned maintenance identity for normal sign-in as needed.
4. After its guardian proves exact-tree closure, retain that ownership proof and lease
   binding. Do not require all Chrome/Edge processes on the machine to stop.
5. Copy allowed files into a new unpublished generation directory with an ownership marker.
   Verify the source before and after the copy; reject partial or unstable copies.
6. Finish all writes, validate the generation manifest and publish the generation through
   a filesystem operation whose crash behavior is explicitly tested on supported platforms.
7. Replace the small current-generation pointer only after that generation is complete.
   Never delete the previous pointer first and leave a missing-current window.
8. Release the publication lease. New workers select the new complete generation;
   existing workers retain their own copies and are not restarted.
9. Remove retired generations only when no clone/publication reader lease references them.

Implement recovery for a crash before copy, during copy, after generation publication,
before pointer replacement and after replacement. Recover from owned markers/manifests,
not guessed directory names or modification-time heuristics. Windows replacement and open
file behavior need real filesystem tests; do not assume POSIX rename semantics.

### F3.3 Worker startup

Read the current generation once under a short reader lease, create a worker identity
using the narrow opaque import, record generation provenance, then release that reader
lease. Launch the worker through the existing guardian with its exclusive writable lease.
Multiple workers may clone concurrently if file/work budgets allow; do not serialize their
whole sessions under the source publication lease. Bound clone work and avoid copying a
large source synchronously on the MCP event loop.

If the source has never been signed in, standalone remains usable with a clean identity.
Return its source/authentication-unknown state with initial output. Do not infer signed-in
status by inspecting profile data. Website login is observed through ordinary pages.
Refreshing the source is explicit maintenance; never merge a worker's changed credentials
back or switch to the operator's personal Chrome automatically.

### F3.4 Asynchronous process reader

Replace synchronous `spawnSync` in live profile/lease recovery with one `process-table.ts`
reader using `spawn`, bounded output, a deadline and abort cleanup. Preserve the two
different consumers' proof rules; do not merge "external profile closed" and "exact stale
identity owner absent" into a permissive boolean.

Kill only the helper child/tree created for the scan when its deadline expires. Do not
kill browsers found in the scan. An unavailable or truncated process list is unknown proof
and cannot release a lease. Share one in-flight scan where useful, but never cache a
negative ownership proof across a new launch or skip final source stability verification.

Required injection test: a child withholds EOF indefinitely. During it, status and another
session remain responsive, cancellation completes, and recovery returns bounded unknown.
Its pipe handles/listeners are removed. A JavaScript timeout around `spawnSync` is not a fix.

## F4 — Existing-browser authority, native wire and updates

Owner recommendation: implement here before Spark integrates the optional backend.
The probe's permissive message dispatcher, logical worker labels and .NET forwarder are
not production foundations. It tested one native connection and two logical claims,
not separate authenticated engine processes contending across restarts.

### F4.1 Authority and tab claims

Use the extension as the one browser-local claim authority across every native connection.
A native port is bound to its engine connection identity during handshake. Derive owner
identity from that bound connection, not a caller-supplied `owner` string on each message.

Claim state: free → reserved → attached → revoking → free, with quarantined as a failure
state. Reserve before awaiting `chrome.debugger.attach`. Failed attach releases only the
same reservation generation; an old failure cannot erase a newer claim. Every command
and child route includes current connection epoch and claim generation. Reject stale or
foreign messages before calling `sendCommand`.

Input already handed to Chrome may still have effects after detach. Detachment fences
future worker commands; it is not rollback. A failed detach quarantines the tab. Human
cancel/DevTools detachment and browser close invalidate claims. Do not auto-reattach and
fight the browser's cancellation. Different tab claims execute concurrently; no shared
profile action lock is allowed.

Revoking first blocks new normal commands. A narrowly scoped cleanup path may release
only the keys/buttons recorded as held by that exact claim, within its cleanup deadline,
before detach. It cannot type text, navigate or accept arbitrary additional actions.
Otherwise premature fencing would prevent input release, while a generic cleanup bypass
would let a stale worker keep controlling the tab. Test both failure modes explicitly.

Test with two real MCP processes and two native connections. Race claims for the same tab,
then run input concurrently on different tabs. Forge the other owner's label and known
tab ID, replay an old generation, disconnect one engine, and prove the other keeps working.

### F4.2 Wire and process topology

Use Chrome-launched Native Messaging hosts plus private OS-local IPC to the owning MCP
process. No installed daemon, HTTP relay, TCP CDP endpoint or MCP listener. Native-host
registration is optional setup, absent from standalone startup and package import.

The production packaging decision belongs to this foundation: a stable per-user launcher
must reach an immutable installed Node/engine build on Windows and Linux without depending
on a temporary worktree, plugin-cache version path or .NET from the probe. Prove Chrome can
launch that artifact from a packed installation before building UI around it. Do not add
an entire runtime language or require the operator to repair launcher paths after updates.

F4 owns the minimum native entry-point/build wiring needed for this proof. P12 extends
that proven path into the final optional package/install/update checks; it must not be
the first time anyone discovers whether the native launcher can run from an installed artifact.

Native messages have a native-endian 32-bit byte-length prefix, not MCP NDJSON. Keep frames
well below the documented host-to-Chrome 1 MiB ceiling; use a conservative 256 KiB frame cap
initially. Bound full-message reassembly, queued bytes, requests per peer and screenshot
payloads. Validate zero/oversized lengths, invalid JSON, duplicate IDs, unknown operations,
missing/out-of-order chunks, byte-order assumptions and stream truncation.

Use a small discriminated wire with handshake, claim/release, scoped CDP request/response,
topology event and development reload operations. Protocol major and capability versions
are independent of engine/extension build versions. An incompatible peer fails existing
mode promptly; standalone continues. Never accept arbitrary `Browser.close`, browser-wide
target enumeration or route IDs through a tab claim.

Separate control/response capacity from bulk screenshot traffic. Chunking is not enough
if one large write monopolizes the outbound buffer. Honor stream backpressure and bound
per-peer work; a noisy peer cannot block another's stop or detach event. Authenticate the
local peer with OS ownership/ACLs and an engine-issued connection capability, without user
prompts. Do not expose or log that capability as model-visible page data.

Chrome's [debugger API](https://developer.chrome.com/docs/extensions/reference/api/debugger)
has a restricted domain set and supports child-session routing in current versions.
The adapter must explicitly test the required subset, recursively reconcile relevant
out-of-process child frames, and reject unsupported commands rather than forwarding them
optimistically. See [Native Messaging documentation](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
for framing, registration and lifetime constraints; pin actual tested browser builds in evidence.

### F4.3 Development updates

Keep a separate stable development extension ID/path. First setup establishes Chrome's
developer mode and unpacked installation. Ordinary engine changes must not rebuild or
reload the extension. A protocol-compatible engine update uses the same extension bytes.

For a real extension change:

1. Build into a staging directory; validate manifest, unchanged permissions/ID and packaged
   code. Refuse partial publication before touching the working development installation.
2. Tell the browser-local authority to stop new claims and drain active commands from all
   connected engines. An idle claim is revocable; an in-flight command must be reconciled.
3. Record the last good immutable build and publish the new complete files at the stable
   development location using the tested platform-specific update strategy.
4. Request self-reload. Expect the connection to disappear; a lost reply is not failure
   proof or a reason to replay an input.
5. Wait on a new bootstrap connection, protocol/capability handshake and **expected build
   digest**. A new random epoch alone does not prove new code loaded.
6. Rebuild routes/claims and test a harmless controlled page. Never reload target websites
   or replay their last mutations as part of extension repair.
7. If validation/smoke fails, restore the previous complete build and prove its handshake.
   If the bootstrap cannot run, report that exact recovery limitation; do not claim rollback
   worked merely because files were copied back.

First installation, Chrome-required permission changes, and a dead bootstrap can require
browser setup/recovery. Keep that technical fact separate from Newton approvals. Do not
invent an unconditional autonomous recovery guarantee or use private browser APIs to
pretend the limitation is absent. No store upload or production distribution is authorized
by this local implementation plan.

## Foundation handoff certificate

For each foundation, record exact files/commit, its public API, immutable contract tests,
real integration evidence, known unsupported cases, and cleanup results in the execution
log. A compiling scaffold, one passing unit test, or a worker's assertion is insufficient.

Only then mark dependent Spark packets ready. Do not let every leaf packet edit these
foundations until its own tests pass; that would recreate competing semantics under new
filenames. Foundation defects get a focused correction and rerun of their contract suite.
