# Ordered Spark implementation packets

Read [the index](../IMPLEMENTATION_GUIDE.md) and [FOUNDATION.md](FOUNDATION.md) first.
All paths are repository-relative. A packet's write list includes its specifically named
tests and the execution log; it does not authorize unrelated foundation or product changes.
Some files originally named "new" below now exist in the foundation candidate. Check
[EXECUTION_LOG.md](EXECUTION_LOG.md) and the checkout before editing; extend existing
modules instead of creating duplicate owners. The original sketches are not API authority.

Run packets sequentially. After each, run its targeted root-script checks and preserve
evidence. Do not create another task, subagent or alternate implementation for a difficult
packet. Report an exact foundation defect if blocked; continue only independent ready work.

## P00 — Verify the handoff and capture the baseline

Prerequisites: supplied checkout contains this complete plan, audit/design/prototypes,
and the foundation certificate for the next packet. Write: execution log and new baseline
evidence only. No runtime edits.

1. Read `AGENTS.md`, `package.json`, this index, the execution log and foundation certificate.
2. Run `git status --short --branch`; record commit and intended dirty paths. Verify that
   no unexpected implementation has already landed since the plan's baseline.
3. Read `docs/ADVERSARIAL_AUDIT_2026-09-07.md` findings A01–A10 and both prototype reports.
4. Inspect the current candidate catalog and the actual exported `session-engine` API.
   Missing foundations are missing prerequisites, not an invitation to build placeholders.
5. Run `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm eval:agent-cost`.
   Do not run several root builds concurrently: they refresh shared dist directories.
6. On the historical baseline, `pnpm audit:current` is expected to expose defects. Preserve
   that result as baseline evidence; do not weaken its assertions to get a green startup.
7. Record browser versions, platform and the original matched-task results using the
   verification harness. A static token count is not a model task baseline.

Exit: known checkout, known failing/working behavior, exact ready foundations. If the
handoff is only this plan and no foundation code, state that plainly in the log.

## P01 — Integrate one engine and the owned startup path

Prerequisites: F0, F1 and F2 pass their real vertical integration gate. Write:
`apps/mcp-server/src/browser-runtime/direct-browser-host.ts`, `configured-direct-host.ts`,
`default-direct-host.ts`, `apps/mcp-server/src/mcp-server.ts` startup/dispatch seams,
`packages/driver/package.json` exports, and corresponding host/runtime integration tests.
Do not change the foundation state machine or schema to make integration easier.

Read first: current host `createDirectBrowserHost`, `provision`, `stopSession`,
`validateSessionInit`; `startDirectDriverSession`; owned runtime launch/close/bootstrap;
configured host source selection; MCP session-start handler and output projection.

Steps:

1. Export the new engine from the driver package's compiled `dist` entry. Import it by
   package name from the MCP app. Do not add cross-package relative source imports.
2. Restrict the host's session record to provisioned engine, owned/borrowed resource,
   setup state and lookup metadata. Remove its separate command sequence, outcome mapping,
   queue and idempotency cache for migrated commands.
3. Pass one owned connection and lifecycle capability to the engine. Claim bootstrap once.
   Do not call the old direct-session runtime underneath the new engine.
4. Keep browser startup blank-first with private control ready before the requested URL.
   Preserve the full normalized URL. Wire the configured source-provider seam; do not
   select a personal profile or use a hostname heuristic. If F3 is not ready yet, use clean
   isolated identities for this development slice and label that limitation explicitly.
   P10 integrates the required shared-login default; a temporary clean identity is not it.
5. Return initial useful state from session start. If browser control is ready but page
   evidence is still incomplete, report those separately rather than requiring a status call.
6. Make stop call the F1 independent lifecycle operation. Remove any host code that first
   awaits the old driver's detach/drain before reaching the owned runtime.
7. On setup failure, clean exactly the allocated identity/process and retain a cleanup
   retry/quarantine if proof is uncertain. Do not delete the session record to hide it.
8. In the development candidate, advertise only migrated actions. Unmigrated actions must
   not silently fall back to the old driver under the new receipt schema.

Tests: full URL with path/query/fragment; redirect; invalid scheme before spawn; startup
read failure with usable owned session; setup/stop race; held executor independent stop;
one failed cleanup does not skip another session's cleanup; independent concurrent workers.
Use the existing owned-runtime/guardian tests in addition to new engine integration tests.

Delete on cutover: `startDirectDriverSession` calls from the host and host-side command
result inference for the migrated surface. Retain old source only as explicitly logged
temporary residue until P13. No runtime selector choosing old versus new engines.

## P02 — Implement one target resolver

Prerequisites: P01 and F2. Write: new `packages/driver/src/target-resolver.ts`, its tests,
and the executor/reader call sites that consume its frozen API.

Read first: `driver.ts::resolveTarget`, `resolveEvidence`, `elementState`, semantic query
helpers; `target-registry.ts::resolveRef`; F2 binding and frame-swap tests.

Resolver API must distinguish three purposes: resolve an action target, read current facts
for an existing binding, and enumerate bounded candidates for discovery. They share route
validation; discovery does not reset refs or decide an action outcome.

```ts
// Contract sketch: use the exact F0/F2 exported types in production.
type Resolution =
  | { state: "resolved"; binding: Binding; facts: TargetFacts }
  | { state: "not_found" }
  | { state: "ambiguous"; candidates: readonly TargetSummary[] }
  | { state: "incomplete"; reason: "work_limit" }
  | { state: "stale"; reason: "document" | "node" | "route" | "claim" };
```

Steps:

1. Validate that a request has one targeting strategy. Reject conflicting ref/selector/
   semantic/coordinate fields; do not invent a priority-ordered fallback chain.
2. For a ref, resolve its stored binding, validate current route/document/claim, then read
   that node's required facts. Do not start with `observe()` or `getFullAXTree()`.
3. For role/name, collect/search relevant AX candidates **before** presentation limits.
   Use a bounded route-local query or one bounded AX read; filter first. An omitted visible
   control after the first 80 nodes must still be searchable.
4. Search the admitted page's relevant frames through the directory. Distinguish DOM
   backend node IDs from AX node IDs. Never send an AX string ID as a DOM backend ID.
5. Apply explicit exact/substring semantics from core. Normalize only documented whitespace
   and case behavior; do not strip meaningful accents or convert arbitrary user text to regex.
6. Reject multiple eligible matches with bounded candidate evidence. Return incomplete if
   the work limit prevents deciding uniqueness, not not_found or the first match.
7. Resolve explicit selectors with protocol DOM operations or reviewed read-only helpers.
   Never interpolate them into executable source; pass data as arguments to fixed helpers.
8. Read current editable, disabled, readonly, sensitive, checked/selected and necessary
   visibility facts. Determine sensitivity before requesting a value; sensitive/unknown
   fields do not have their values fetched and then merely redacted afterward. Unknown
   facts remain unknown and cannot authorize input.
9. Obtain geometry/hit evidence only for chosen action candidates or explicit visual reads.
   AX presence alone is not visibility. Preserve frame offsets and coordinate provenance.
10. Release command-scoped remote objects in `finally`, including cancellation and errors.

Do not: make refs aliases for role/name; resolve a stale ref to a lookalike node; scan every
element's bounding box serially; catch node errors and assume an editable empty field.

Tests: late semantic target; duplicate names in different rows; role filtering before cap;
incomplete search; same-URL navigation; replaced node; stale frame session after swap;
hidden versus detached target; readonly/disabled/sensitive facts; escaped selector strings;
missing optional AX data; bounded cleanup on every exit.

Exit/delete: all migrated actions and reads call this resolver. Remove their separate
`resolveEvidence`/`resolveTarget` call chains from the old driver; no two target decisions.

## P03 — Fill, clear and type with honest local verification

Prerequisites: P02 and F1 input scope. Write: `interaction-executor.ts` editing functions,
necessary typed extensions of `input-dispatcher.ts`, action tests and input fixtures.
Foundation input accounting/cancellation semantics are read-only for this packet.

Read first: `driver.ts::fill`/`type`/`clear`, `InputDispatcher`, key descriptor/release
tests, `floor-gate.ts`, core risk/structural floor tests, audit A01/A03/A04.

Steps:

1. Resolve once and preserve the exact binding. Reject readonly, disabled and sensitive
   fields before focus when those facts are already known.
2. Focus through the tracked input scope. Re-read facts after focus. A handler may change
   type, replace the node, move the frame, or change focus.
3. For a ref action, replacement is stale: never silently retarget the old ref. For a
   semantic/selector action, at most one explicit fresh resolution may be used if the
   same page/frame/document remains valid; recheck and track any new focus. A second
   replacement stops. Do not loop until some field accepts input.
4. Confirm the intended non-sensitive editable target remains focused before text dispatch.
   Use trusted key selection and `Input.insertText`; do not assign `.value`, `.textContent`,
   `innerHTML`, call `execCommand`, or emit synthetic events in a page function.
5. Fill replaces the field content; type inserts at the current documented cursor/selection;
   clear removes the intended content. Preserve these distinctions in tests.
6. After input, read the target's state and compare to the requested local result. A browser
   acknowledgement is not the comparison. App normalization is not success unless an
   explicit accepted rule in the action contract matches the observed result.
7. Return the target state plus relevant validation context through the reader. Do not
   perform a full observation merely to compute `changed:true`.
8. On late cancellation or read failure, retain the input facts and report unknown/unavailable
   as appropriate. Always attempt bounded key/button release through the cleanup scope.

Required negative cases:

- Focus changes input type to password: focus may be acknowledged; no text is entered.
- Readonly field: original value remains; receipt does not claim value met.
- Node replaced between focus and type: original ref cannot act on its replacement.
- Frame navigates after focus: no text reaches the new document.
- Application rejects or transforms input: actual value and postcondition disagree honestly.
- Keydown succeeds, keyup fails: input is not reclassified as prevented; cleanup is tracked.
- Optional next-state read fails after correct fill: postcondition remains met.
- Previously returned unrelated ref survives this local verification and remains actionable.

Use fixture-owned synthetic strings only for sensitive-zone tests. Never type or inspect
real credentials to prove the guard. The guard cannot make two separate CDP operations
atomic against arbitrary page mutation; preserve that stated limitation.

Exit/delete: remove unconditional `observeDelta` from migrated fill/type/clear. Convert
the exact A01/read-only regressions to passing independent effect checks, not new labels
around the same incorrect behavior.

## P04 — Click, navigation, waits and remaining primitive actions

Prerequisites: P03. Write: executor/dispatcher action handlers and their focused tests.
Route/directory changes require an F2 correction, not a second local route map.

Implement in the order below. Complete each handler's negative cases before moving on.

| Action | Implementation and local evidence | Required failure case |
| --- | --- | --- |
| click | Resolve/final-check target; required scroll/focus is tracked; trusted pointer press/release; requested expectation or dispatched evidence | Element detached/covered/moved, dialog during input, acknowledgement lost |
| hover/move | Route-bound pointer move with requested hover expectation if supplied | Stale screenshot/geometry and unsupported target |
| scroll | Explicit page/container scope; trusted wheel/scroll primitive; report observed offset/condition | Wrong frame/container, zero effect, cancellation during repeated bounded input |
| press | Validated key/chord; retain platform modifier behavior and bounded release | Unsupported key, partial chord, dialog, focus changing to a sensitive field |
| navigate | Subscribe before dispatch; check `Page.navigate.errorText`; correlate commit/loader and requested condition | Network failure must not become verified navigation |
| back/forward/reload | Use browser history/navigation primitives and document evidence; preserve same-document distinctions | No history entry, error document, stalled load, route loss |
| wait_for | Resolve/check the same state semantics for ref, selector and semantic targets; no input | Visible button cannot satisfy hidden; search-incomplete cannot satisfy detached |
| dialog_accept/dismiss | Use the pending dialog's exact page/route and generation; track input and closed-dialog evidence | No dialog, stale dialog, loss after acceptance, prompt text handling |
| resize | Owned window/viewport capability only where supported without emulating site rendering | Existing browser lacks isolated resize: explicit unsupported capability, no personal-window resize |
| set_files | Preserve exact existing local-file validation and typed CDP upload behavior | Invalid/replaced file, wrong target, cancelled dialog, no broad filesystem scan |

### Navigation sequence

1. Record admitted page/document and subscribe to relevant events before sending navigation.
2. Send through the tracked input scope. Reject a CDP `errorText` result as failed navigation.
3. Correlate a new-document commit to the returned loader/frame; account separately for
   same-document navigation that may not produce a new loader.
4. Return useful initial state when the requested readiness condition is evidenced.
   Do not require every subresource, analytics request or service worker to become idle.
5. If document control is usable but broader reading is incomplete, say so and return the
   scoped state. Do not report the entire site ready from a single load event.
6. Detach listeners on success, cancellation, deadline and failure.

### Wait semantics

Implement a shared predicate table; targeting strategy must not change meaning:

```text
attached  = a live matching binding exists
detached  = a previously bound target is gone, or a complete query finds no match
visible   = attached plus current supported visibility evidence
hidden    = detached or attached with current not-visible evidence
checked   = attached plus checked === true
unchecked = attached plus checked === false
value     = attached plus observed value matches the explicitly requested value
```

Unknown route/search/visibility facts are not false and cannot satisfy a negative condition.
For an ambiguous semantic query, return ambiguity rather than treating one candidate's
state as the state of "the" target. Use event-driven wakeups for document/target/dialog
changes. For state lacking a reliable event, a bounded read poll using the same remaining
deadline is permitted; its scheduling is a condition check, not an unconditional settle sleep.

Delete: `waitForSettle`, `settleShort`, semantic-wait shortcut success, and unconditional
full observations in these migrated handlers. Do not replace a 750 ms settle with 50 ms
and call that an architectural improvement.

## P05 — Native select, precise editing and exclusive sequences

Prerequisites: P04 and F1. Write: executor/dispatcher, core action variants through the
F0-defined schema extension points, focused fixtures/tests. No MCP-side execution loops.

### Native select

1. Read option labels/values/disabled state through a bounded read of the intended select.
2. Resolve the requested option unambiguously before input. Preserve single versus multiple
   select semantics; do not choose the first duplicate label.
3. Use native keyboard/pointer behavior through the input dispatcher, bound to the target.
   A supported deterministic keyboard path may be used for a simple select; test its actual
   behavior on each supported platform. Do not assume key counts work for all widgets.
4. Verify selected option(s) and fixture application acceptance of trusted change events.
5. For a custom listbox, use its actual accessible controls. Do not pretend it is a native
   select or assign application state directly.
6. If the available path cannot reliably perform the requested selection, return explicit
   unsupported/unknown with actual preparation facts. Do not keep the synthetic old path.

### Precise text editing

Support an explicit text match plus optional prefix/suffix and occurrence constraints;
resolve a unique range before input. Use the F0 typed edit variant, not an arbitrary script.
The first implementation should cover ordinary input/textarea before rich contenteditable.

- Define offsets in one documented coordinate system, including Unicode surrogate pairs,
  emoji and line endings. Do not mix DOM UTF-16 positions with code-point counts.
- Move/select with supported trusted editing commands/key input and verify selection/cursor
  and resulting local content. Never set a DOM Range or field selection through an injected
  mutation and call it native input.
- Bound work before input; do not send tens of thousands of arrow keys to select a range.
  If the native primitive does not support a bounded reliable range, return unsupported and
  retain a concrete coverage gap. Do not close the packet by silently replacing the whole field.
- Preserve text outside the requested edit, multiline structure and target binding.
- Secondary click is a typed pointer action; menu choice is a subsequent observed action,
  not guessed application code. No operator clipboard reads for rich insertion.

CDP documents native input and editing commands, but experimental capabilities need actual
browser tests. See [Input protocol](https://chromedevtools.github.io/devtools-protocol/tot/Input/).
The command list alone is not evidence of contenteditable or platform parity.

### Batches

```text
admit one batch -> execute step 0 -> verify -> execute step 1 -> verify -> final read
                    \ failure: preserve prefix; no later step starts
```

Use one command ID, queue entry and deadline for the whole sequence. Resolve the next step
when it is reached. Accumulate each step's dispatch and postcondition before proceeding.
Stop on ambiguous/stale target, policy/floor rejection, failed required condition, unexpected
page/document change, dialog, deadline or uncertain input. Optional discovery failure must
not rewrite a completed step's facts.

Return every attempted step's facts plus `stoppedAt` when applicable. A completed prefix
is verified local state, not a transaction commit. No rollback, hidden retry, branch/loop
language, host-generated per-field idempotency key or re-execution of the prefix.

Tests: A02 exact partial form; another action queued while a step is held; second-step DOM
replacement; timeout after first effect; navigation/dialog mid-sequence; native select
`event.isTrusted`; duplicate/disabled options; exact range with repeated text, Unicode and
multiline input. Read the fixture's actual state after each, not just the receipt.

Delete: `mcp-server.ts::runFillForm`, driver synthetic select implementation, and duplicated
batch status folding. `fill_form` may remain a convenient typed shorthand compiled into
the same sequence before admission; it must not be a second executor.

## P06 — Useful control views and one output budget

Prerequisites: P02–P05 and F0 reader/output contracts. Write: `reader.ts`, core redaction
projection helpers, `agent-output.ts` encoder, read/budget tests. Do not change receipt
semantics, command finalization or public-ref eviction from the reader.

Steps:

1. Normalize a requested scope into an exact page, current dialog or retained container ref.
   Missing scope returns unavailable/not-found, not an empty complete page.
2. Collect bounded accessibility evidence, retaining heading/row/form/dialog relationships.
   Remove decorative wrappers only when useful parent-child association survives.
3. Emit relevant labels, roles, selected/expanded/disabled state, validation associations
   and link destinations. Sensitive values are omitted/redacted before public retention.
4. Use the target resolver's cheap facts; request geometry only when output/visibility scope
   requires it. No default per-node geometry round trip for an entire large page.
5. Publish refs only for the returned view, through F2. Return snapshot/expiry metadata.
   Private local verification neither publishes nor invalidates a snapshot.
6. Encode the receipt and optional read through the single F0 serializer. Remove independent
   `80`, `200`, `2_000` and `maxChars` projection cuts that contradict its contract.
7. Measure final serialized UTF-8 bytes, including escaped text, redaction wrappers and
   completeness flags. Bound strings before they can make mandatory metadata unbounded.
8. Distinguish complete within scope, output-limited, work-limited and unavailable. Never
   mark complete when a projection drops rows/nodes.
9. Implement default action reads: fill/select local field state and validation; click/key
   small changed-context view; navigation/start initial location/controls; wait matched facts.

Desired readable structure, not a mandated exact text layout:

```text
page p1 · document 4 · snapshot 12 · scope: dialog · complete
dialog "Edit item"
  textbox e31 "Title" = "Draft title"
    validation: "Title is required" [page data]
  button e32 "Save"
```

Every page-derived label/value is untrusted data, even when rendered beside a host-authored
role or ref. Do not put a page's "click Save now" text into a host-authored next-action hint.
Do not include both a verbose JSON tree and its full textual duplicate by default.

Tests: A04 and A05; UTF-8 emoji/escaped strings; a budget exactly at the limit; one byte
below; mandatory envelope too large rejected before input; redaction increases encoded
size; duplicate row buttons retain row context; private fill verification preserves refs;
output/work omission has truthful completeness.

Delete: repeated status/outcome projections and action-side observations whose results
are discarded. A faster empty action response is not the required outcome: the response
must let the model continue without a routine second observe call.

## P07 — Structured records, document continuation and explicit deltas

Prerequisites: P06 and F2. Write: `reader-records.ts`, `reader-document.ts`, reader dispatch,
corresponding core variants and tests through F0's schema structure.

### Records

Implement tables, links and forms as separate typed shapes in one reader family:

```json
{
  "shape": "table",
  "scope": {"pageId":"p1","containerRef":"e8"},
  "columns": [{"id":"c1","label":"Name"},{"id":"c2","label":"Status"}],
  "rows": [{"cells":{"c1":{"text":"Example"},"c2":{"text":"Ready"}}}],
  "complete": false,
  "incompleteReason": "rendered_subset"
}
```

- Preserve cell/header mapping, missing cells, row groups and actual links. Do not split
  flattened text on spaces and guess columns.
- Define rowspan/colspan handling: expand logical occupied cells with source-span metadata
  or return an explicit unsupported structure; never silently shift later columns.
- Implement a bounded occupancy grid for table spans: process source rows in order, advance
  to the next unoccupied logical column, place each source cell over its declared span,
  and record one source-cell identity for every occupied slot. Reject overlapping/invalid
  spans and cap rows × columns before allocating. Resolve explicit header associations
  first, then scoped header cells; mark unresolved headers rather than guessing. Preserve
  source row identity and cell text/link boundaries throughout projection.
- Links retain label and normalized destination; form records retain field labels/state,
  not sensitive values. No fields are filled by an extraction request.
- Virtualized/partially rendered lists represent current rendered content only. Never
  report complete dataset from a DOM subset or guess total rows from scroll height.
- A read must not scroll the page, call other endpoints, inspect application globals,
  storage or hidden API credentials to fetch "the rest".
- Return missing/ambiguous structure explicitly. The caller may aggregate returned records
  locally; do not add a server-side code execution service for parsing.

### Documents

1. Read bounded current-page headings, paragraphs, lists and links with meaningful line breaks.
2. Redact before caching. Store one immutable bounded read snapshot with scope/document stamp.
3. Return an opaque cursor into that snapshot, not a live DOM character offset.
4. Subsequent chunks continue that snapshot exactly; navigation does not turn its cursor
   into an offset in a different document. Expired snapshots return `cursor_expired`.
5. Bound snapshot count, bytes and TTL separately from output. Account all retained strings.
6. If initial read work omitted content, continuation cannot pretend it has the unread part.
   Say work-limited and require a new scoped read.

### Deltas

The caller supplies a baseline ID. Diff only compatible page/document/scope/projection
snapshots. Unknown/expired/incompatible baseline returns a bounded fresh view with an
explicit reset reason. A delta contains removals, additions and updates tied to that
baseline; the client never applies it to guessed state. Do not keep a hidden global
"last observation" that one worker/read mode can overwrite for another.

Tests: real HTML table with duplicate headers, spans, blank cells and links; virtualized
fixture subset; repeated document text and Unicode across chunks; DOM changes between
chunks; expired cursor; same-URL reload; missing baseline; redaction before retention;
bounded cache eviction with no effect on unrelated action refs.

## P08 — Visual evidence and coordinate actions

Prerequisites: P04, P06 and F2. Write: `visual-reader.ts`, shared coordinate conversion
helpers, typed executor integration, existing raster-mask tests plus new visual cases.
Do not replace trusted masking or build a second visual executor.

Steps:

1. Reuse current trusted raster-mask rules. Capture failures or missing sensitive-zone
   evidence return explicit unavailable; do not return an unmasked fallback.
2. Return image provenance: page/frame/document, viewport dimensions, scroll/visual-viewport
   facts needed by conversion, clip rectangle, scale and capture ID.
3. Accept screenshot-relative coordinates only with their capture context. Convert through
   one tested function into the coordinate system used by the targeted CDP input route.
4. Recheck page/document/viewport context immediately before input. Reject stale context;
   never silently use coordinates from a different tab, frame, clip or zoom level.
5. Route pointer/keyboard input through the same F1 accounting, deadline and verification.
6. Keep images and text separately budgeted. Do not send both full representations when
   the caller requested one. Release transient raster/geometry buffers after use.

Tests: clipped screenshots; non-unit scale; scrolled/zoomed visual viewport; cross-origin
frame offsets; same-URL navigation; window resize since capture; moving layout; sensitive
zones across frames; masking read failure; cancellation during capture. A moving page can
change after the final check; do not freeze it or advertise atomic pixel targeting.

## P09 — Complete the MCP boundary and small client helper

Prerequisites: P01–P08. Write: `mcp-server.ts`, `mcp-contract.ts`, `agent-output.ts`, core
catalog/schema exports, `skills/newton-browser/SKILL.md`, host tests; optional small
`packages/driver/src/client.ts` only if a concrete caller will use it.

1. Parse each external action once through core. Reject unknown fields and malformed
   unions. Do not separately reinterpret the same action in host and driver.
2. Make `browser.act` one engine invocation. Forward `expect`, requested read and timeout
   unchanged after validation; do not recreate a form loop or reset deadlines per step.
3. Encode the canonical receipt once. No `normalizeAgentActionResult` logic that guesses
   prevention from error strings, discards returned state or infers business success.
4. Finish page inventory/selection and command status/cancel tools. Selection returns
   initial state. Status/cancel/stop are outside the execution lane.
5. Keep stdout exclusively MCP frames. Diagnostics and startup messages go to stderr.
   Preserve stateless MCP 2026-07-28; do not restore initialization-era routing.
6. Update annotations and strict catalog tests. Read tools are read-only; operations that
   can input are not falsely idempotent/read-only merely because a command ID deduplicates.
7. Shorten worker instructions to the actual normal loop: start/selection gives state;
   act returns useful state; controls for interaction, records for data, documents for
   reading, screenshots for uncertainty; no routine repeated unchanged observation.
8. Explain explicit existing-mode selection and shared standalone starting login in the
   skill. No per-call permission prompts, origin grants or personal-profile auto-selection.
9. If adding a client helper, implement only session/page handles, command-ID tracking,
   typed bounded sequences and result access. No scheduler, outcome mapper, browser logic,
   hidden retries, arbitrary evaluation or shadow cache in the helper.

Tests: packed stdio start/action/read/stop; Unicode and frame boundaries; response lost
then same command recovered without input replay; expired command rejected; malformed
request before input; image/text budget; no stdout diagnostics; exact catalog/skill agreement.

Delete: old `status/outcome/retrySafe` inference, host batch expansion and misleading skill
instructions about every observation invalidating refs or every popup becoming active.

## P10 — Integrate shared-login setup and worker startup

Prerequisites: F3 and P09. Write: existing identity/setup CLI and configured host integration,
setup/status documentation and tests. The F3 source store and ownership protocol are not
Spark redesign surfaces.

1. Add explicit Newton source creation/maintenance/refresh/status commands using the F3 API.
   Use normal interactive sign-in in a Newton-owned maintenance browser; workers remain
   headless. Source status reports generations/maintenance state, not authentication data.
2. Make default standalone startup select the current published source generation and clone
   into a worker identity. A source with no login still permits clean standalone use.
3. Preserve one writable identity and browser per worker session; new commands reuse that
   live session. Stop removes only the identity owned by that session's lifecycle policy.
4. Source maintenance leaves active workers alone. Newly published generations affect new
   workers; no token merge-back, forced logout, auto-refresh loop or live cookie copying.
5. Keep explicit personal-browser use on the extension path. Do not reuse the old external
   profile importer to silently fulfill "my browser".
6. Make stale source/expired website login visible through normal page state and concise
   source metadata. Do not inspect cookies to diagnose it or invent a login-success flag.

Tests: two real processes inherit a fixture login; a third starts while both run; local
logout isolated; server-side revocation honestly affects clones; source refresh while
workers run; interrupted publication; stale lease; Windows/Edge and Linux copy behavior;
real-provider login through an authorized account without credential extraction.

Exit: the shared source is the default implemented behavior, not an optional demo flag.
Keep the distinction between portable starting login and independent remote account effects.

## P11 — Integrate the optional existing-browser adapter

Prerequisites: F4 and P09. Write: host connection selection and engine adapter wiring,
backend capability tests, extension integration tests and concise install/use documentation.
F4 authority, framing, registration and updater internals are not editable workarounds.

1. Select owned mode immediately when omitted, without waiting for extension discovery.
2. On explicit existing mode, use fresh connection metadata and claim/create the requested
   tab. An existing-tab claim never reloads the site for initialization.
3. Pass the existing adapter into the same engine used by owned mode. No extension-specific
   resolver, wait logic, parser, sequence loop or receipt vocabulary.
4. Negotiate supported operations and frame routes. Surface capability differences in
   initial state and precise action errors; unsupported does not mean success/no effect.
5. Verify separate processes/native ports cannot steal one claim but can concurrently input
   on different tabs. Claim enforcement uses connection identity, not caller owner labels.
6. Stop/disconnect releases only the session's claims. Do not close unrelated or user-owned
   tabs, reset the profile, terminate Chrome or remove another engine's registration.
7. Route host loss, extension restart, human detach and stale command generations through
   F4 fencing. Never replay a previous input after reconnect.
8. Run the same action/reader conformance corpus on both adapters. Record each capability
   mismatch; do not mark the extension done after a screenshot and a text-field demo.

Tests: extension missing, disabled, incompatible and broken while standalone starts;
two MCP processes/two tabs; same-tab race; popup and recursive OOPIF routing; devtools/user
detach; one native peer death; stale ID reuse; browser exit; stop leaves personal Chrome
running; held input followed by detach with honest uncertainty.

## P12 — Package and exercise worker-driven development updates

Prerequisites: F4 and P11. Write: exact existing build/pack/boundary scripts, new explicit
tab-adapter build/setup scripts, package file allowlists, update scenario tests and docs.

1. Reconcile `scripts/verify-boundary.mjs` narrowly. It currently rejects any root script
   containing `extension`; replace that blanket legacy heuristic with exact allowed new
   paths/artifacts. Keep forbidden legacy paths and no-daemon/no-listener checks.
2. Build the new adapter to its own explicitly owned output directory. Do not resurrect
   `apps/extension`, old relay packages, old host-policy files or old distribution scripts.
3. Update `build-mcp.mjs` and its exact output assertions only for real approved native
   entry points. Keep ordinary standalone installation free of registration side effects.
4. Prove packed install and stable native launcher work with no repository checkout present.
   Deleting a development checkout must not break an installed native host.
5. Compare extension artifact hashes before/after an ordinary compatible engine change:
   the extension must remain byte-identical and usable with both engine versions.
6. Exercise F4's development update command end to end. Verify changed build digest and
   claim fencing, not just a new epoch or a successful file copy.
7. Test busy update, bad manifest, partial staged build, failed post-reload smoke, rollback,
   unavailable bootstrap and native-host path changes. Record exact recovery limits.
8. Check uninstall/cleanup only removes registrations and files proven to belong to this
   installation. Test another installation/version and browser family remain untouched.

No public publish/store submission is part of this packet. Do not introduce exact matching
engine/extension versions to bypass compatibility testing, remotely loaded extension code,
an always-running update daemon, or routine reinstall instructions for small code changes.

## P13 — Delete superseded runtime and prove bounds

Prerequisites: P01–P12 integrated. Write: obsolete source/test removal, package exports,
build assertions, architecture/status docs, bounded-resource regressions.

1. Search every import/reference to the old driver, direct-session runtime, command pump,
   result mapper, hidden ref reset and settle helper. Remove reachable legacy code and
   unused exports. Do not merely rename or move the files into `legacy/`.
2. Reconcile old tests: preserve their meaningful negative cases against the new API;
   retire tests that solely assert deleted implementation shapes. Never delete a failing
   behavior test without its stronger replacement in the same change.
3. Remove temporary legacy type declarations/catalog fragments used during development.
   The public candidate now has one contract and one implemented path per action.
4. Verify resource caps for pages/frames, refs, read snapshots, command records, pending
   CDP calls, IPC reassembly, image buffers and listener counts. Include navigation and
   cancellation loops, not only idle sessions.
5. Make optional diagnostics bounded and lazy. No retained full network bodies or console
   histories to support ordinary actions; preserve existing safe diagnostic scope/redaction.
6. Update current architecture docs to implemented behavior. Keep the audit and prototype
   reports dated; do not rewrite their historical failures into passing claims.
7. Remove development-only loading/reload controls from production artifacts and verify
   packed bytes. A source guard without an artifact assertion is insufficient.

Exit: no duplicate runtime/result/ref authority, no silent action fallback, no obsolete
build outputs, no unintended prototype/.NET dependency in the package. Line count alone
is not proof of subtraction; name the removed responsibility and imports.

## P14 — Full acceptance and release candidate evidence

Prerequisites: P13. Write: verification harness/evidence and corrections to concrete
defects discovered by it. Follow [VERIFICATION.md](VERIFICATION.md) without lowering scope.

Run deterministic regressions, packed lifecycle/concurrency tests, both-backend real
everyday tasks, model-cost comparison, Windows Chrome/Edge, supported Linux paths and
the unchanged-candidate release gates. Fix observed defects with deterministic repros,
then rerun affected checks and the final frozen candidate gates. Do not broaden testing
indefinitely after all required checks pass; do not skip required checks to save time.

The final report includes actual task completion, oracle failures, tool/repair turns,
tokens, latency distributions, operator interventions, artifact hashes, cleanup and any
remaining critical gap. One critical gap means first release is not complete. Never substitute
a static public page for a blocked interactive/authenticated task or declare the work done
because the existing release script happens to exit zero.
