# Newton Browser — final implementation push

Audit date: 2026-09-08. This is the remaining execution contract, not a release claim.

Continuation guide, reconciled 2026-09-25: [CONTINUATION_HANDOFF.md](docs/implementation/CONTINUATION_HANDOFF.md). Start there for current implementation facts, exact code paths and batch instructions; the original baseline and old worker assignments below are historical.

Consolidated 2026-09-25: current status is [docs/PROGRESS_LEDGER.md](docs/PROGRESS_LEDGER.md), with fresh build/typecheck and 841 passing tests. Boundary lint remains failing; details and push scope are in [CONSOLIDATION_2026-09-25.md](docs/implementation/CONSOLIDATION_2026-09-25.md). This checklist retains its original baseline; do not interpret its old missing-edit/default-cutover descriptions as current facts.

Latest execution rule from the operator: Astra completes all implementation, review, QA and testing alone. Do not message, assign, poll or wait for either former worker; let already-running assignments finish. No subagents or other workers. This supersedes all delegation instructions below and in earlier handoffs. Independently inspect any concurrent output before incorporating it.

Solo progress checkpoint: `test/evidence/astra-solo-foundations-2026-09-08.md` records the new native precise-edit action, child-frame observation race fix, candidate digest, and 841/841 source tests with zero skips. Historical assessments below remain the start-of-push baseline. Precise editing now exists for exact verified native ranges; real persisted rich-editor, adapter/platform and final packed acceptance remain open.

Execution update from the operator: Luna owns QA/testing only, dispatched after a substantial implementation batch. It writes a separate findings Markdown file for every batch and must not message the parent task. This overrides the proactive-message instructions later in this document and in earlier handoffs. The implementation owner reviews findings at batch boundaries, without task polling or waiting. Production implementation stays with Astra.

Subsequent execution update: The operator authorized a fresh GPT-5.3 Codex Spark xhigh coding task and use of its restored allowance for precisely specified bulk coding. Spark may implement exact non-overlapping assigned files; Astra owns architecture/integration and reviews its output. Waiting on Spark is allowed. Luna remains QA/testing only with file-based reports and no messages. The earlier one-worker restriction is superseded only for this authorized Spark coding task; no subagents or additional workers.

Authoritative checkout: `C:\Users\<user>\.codex\worktrees\421a\newton-browser`.
Do not implement against the older `C:\DEV\newton-browser` checkout by mistake.
Baseline commit: `f2ae1ee71c66bea3488926df8332bec2d1ec7cfc`; substantial intended source is uncommitted/untracked.

## 1. What remains, in plain terms

The replacement engine exists and many hard foundations work. This is not another rewrite from zero. However, the original plan is not closeable by fixing a few more browser examples. Three substantial bodies of work remain: finish the model-facing product, remove the superseded implementation, and certify the actual installed product across its promised modes and platforms.

The most important unfinished user experience is **action → useful next state**. A click can navigate correctly while returning an empty incomplete observation. The model must then spend another turn discovering where it landed. Scoped search results, compact contextual controls, precise edits, and honest bounded text search also need completion. Raw input speed alone does not solve these problems.

The largest structural debt is the surviving direct runtime and its CLI/test/output machinery. The public default has moved toward the shared engine, but old authorities and exports remain. The current release and token-cost scripts are not sufficient evidence for the replacement. We need to migrate behavioral coverage and delete the second implementation, not keep extending both.

The largest acceptance gap is real application work: authenticated forms, persisted rich editing, visual/embedded UI, real shared login and both-backend model runs. Three public scripted workflows and a large unit suite are useful evidence, but they do not satisfy that contract.

This push groups changes by responsibility and dependency. We will stop repacking and running broad QA after every tiny fix. We will use focused source regressions while changing a workstream, run integration checks at meaningful boundaries, then freeze one candidate for full acceptance.

## 2. Evidence boundary at the start of this plan

| Evidence | What it proves | What it does not prove |
| --- | --- | --- |
| `test/evidence/astra-suite-v34.log`: 816/816, zero skips, 31.7 seconds | Current source regression suite passes | Entire P00–P14 complete; suite still includes legacy implementation tests |
| `astra-pack-v53.log`: 13 files, 329700 bytes | Deterministic package check passed for v53 | Latest source fixes are packed |
| v53 SHA-256 `038bb2482517f3bfcb6e543d08b217134a40c001eade78a772101164cacc18ad` | Exact identity of the latest recorded package | Release candidate identity for subsequent source edits |
| `astra-clean-adapter-v53.log` | Packed Chrome extension ownership, hidden-tab input/capture and update/recovery scenarios pass | Full cross-platform/action conformance or real authenticated acceptance |
| `astra-packed-probes-v53.json` | Wikipedia, GitHub issues and W3C scripted tasks pass: 27 calls, zero recorded recovery, 53304 output text tokens plus 4808 catalog tokens | Model decision time, full model input/output tokens, authenticated work, ChatGPT parity |
| `astra-model-v49.json/.md` | One model-directed MDN task completed in seven public calls | Current candidate coverage, matched repetitions or general product acceptance |
| `astra-mdn-wait-fixed.json` | Page-wide search-result text wait reduced from an erroneous timeout to a successful ~63 ms probe | Destination feedback solved: click still returned zero nodes, no destination metadata, `rendered_subset` |

v53 predates the source-only navigation feedback refresh and page-wide text-wait correction. Do not attach v53 results to those changes. No three-pass final release sequence has completed.

Historical evidence stays immutable. Current architecture/status documents will be corrected separately; chronological reports must not be rewritten to look successful.

## 3. Original packet reconciliation

Status means coverage against the original requirement, not percentage of lines implemented.

| Packet | Current assessment | Remaining exit work |
| --- | --- | --- |
| P00 baseline/handoff | Established, but candidate identity needs refreshing | Capture intended tracked/untracked source and exclusions once; reconcile evidence to actual candidate |
| P01 engine/owned startup | Implemented foundation | Make it the sole production path; packed lifecycle/platform coverage |
| P02 target resolver | Implemented with substantial frame/shadow tests | Nested shadow adversarial review, lifecycle stress and matched adapter coverage |
| P03 fill/clear/type | Implemented with local verification | Preserve during feedback changes; extend accepted-event/cancellation coverage across backends |
| P04 click/navigation/waits/primitives | Broad implementation; feedback incomplete | Destination readiness, bounded text-wait truth, pending popup/error visibility, dialog/hidden-input investigations |
| P05 select/edit/sequences | Partial | Precise range edit variant and implementation are missing; select is single native select only; validate custom-control interaction and platform semantics |
| P06 useful controls/budget | Partial | Context-directed action feedback, stable compact projection, complete omission reasons and bounded acquisition |
| P07 records/documents/deltas | Implemented core, incomplete coverage | Closed-shadow rendered reading, frame exclusion consistency, acquisition limits, real virtualized/table/document tasks |
| P08 visual control | Substantial implementation | Full visual matrix, hidden capture cleanup bounds, independent pixels on borrowed mode and real weak-AX tasks |
| P09 MCP/helper/skill | New engine boundary exists; legacy branch remains | Single parser/receipt path, current instructions/catalog, packed recovery tests; helper only if a real caller needs it |
| P10 shared login | Default cloning and maintenance exist | Correct CLI semantics, real-provider acceptance, concurrent refresh/revocation and platform tests |
| P11 optional existing browser | Working Chrome integration | Whole conformance corpus, failure/concurrency matrix, explicit platform capabilities |
| P12 packaging/update | Windows implementation and extensive recovery evidence | Compatible-build byte stability, production/dev separation, platform installation and migration/cleanup coverage |
| P13 legacy retirement/bounds | Major unfinished work | Dependency-by-dependency migration/deletion, production artifact assertions, resource stress, current docs |
| P14 acceptance/release | Partial evidence only | Replacement release harness, all real task families, actual model-loop measurements, Chrome/Edge/Linux and three frozen passes |

## 4. Workstream A — finish useful feedback and compact discovery

**Owner: Astra. Integration hotspot.** Files: `packages/driver/src/page-executor.ts`, `ax-snapshot.ts`, `control-reader.ts`, `page-directory.ts`, `session-engine.ts`; observation types/encoding in `packages/core/src`; `apps/mcp-server/src/engine-mcp.ts` only for necessary boundary changes.

### A1. Destination feedback after navigation

Confirmed defect: `observeAfterAction` refreshes once after `stale_target` when document generation advanced, but `observe` can catch AX/frame errors and return an empty incomplete page. Title/URL currently depend on finding RootWebArea in the AX response. The live MDN reproduction still fails the useful-state requirement.

Implementation:

1. Instrument bounded diagnostic timings around navigation commit, frame routing, execution-context readiness and AX read completion in the deterministic navigation fixture. Identify which transition makes MDN feedback empty; do not assume that a generic load delay is the cause.
2. Preserve location from current page/frame lifecycle facts independently of AX success. Never substitute metadata from the previous document. Bound/redact metadata through the canonical encoder.
3. Distinguish document not ready, unavailable renderer evidence, work exhaustion and genuinely empty content. Stop flattening unrelated read failures into `rendered_subset`.
4. Within the original command deadline, wait only for a missing known document/context transition and perform a bounded read refresh. No network-idle wait, new timeout, blind retry loop or second input.
5. Preserve the action's dispatch/postcondition facts even if optional feedback cannot be completed. Feedback can describe the newer document while the action stamp remains action provenance.
6. Return usable destination controls when available; if the deadline prevents them, return current location and a truthful explicit readiness/evidence state rather than an unexplained empty page.

Acceptance: fixture delays context and AX availability independently; same-URL reload, redirects, SPA/hash change, navigation failure, repeated navigation and cancellation. Assert no mutation replay, no deadline extension, correct document stamps and actionable next refs. Repeat MDN search→result→read through packed tools without a routine repair observe.

### A2. Action-specific changed context

Current local feedback returns the edited field and validation. That is appropriate for an ordinary fill, but insufficient when a search combobox exposes options or a click opens a dialog/menu. Whole-page fallback is costly and often dominated by unrelated navigation.

Implement one bounded feedback policy in the engine:

| Action effect | Default returned scope |
| --- | --- |
| Ordinary fill/clear/select | Field state and associated validation |
| Combobox/search expansion | Field plus bounded associated popup/options when native AX relationships identify them |
| Dialog/menu/tab transition | Current affected semantic container and actionable controls |
| Navigation/start/page selection | Current location and compact initial controls |
| Popup | Admitted page identities plus current action evidence; explicit pending/failed admission when applicable |
| Wait | Matched fact and appropriate local context |

Use observed relationships/current document facts, not website names, hardcoded MDN selectors or inferred instructions from page text. Reuse the resolver/ref store and current reader. Do not introduce another observer cache, scheduler or outcome mapper.

Acceptance: duplicate row buttons retain distinguishing context; search can continue from returned options; dialog can continue from returned controls; ordinary fill does not trigger a full-page AX scan. A04 private-ref preservation remains green. Measure acquisition calls and returned tokens per action.

### A3. Compactness and omission truth

Confirmed code concerns: `readAXControls` repeats `readonly:false` and `disabled:false` on all controls; output ordering prioritizes roles globally; some `incomplete` paths omit a reason (for example projection/validation truncation or the 512-candidate cap). `readAXSnapshot` bounds expansion, but role/landmark queries can return large payloads before local slicing.

Changes:

- Define one canonical compact projection with documented default booleans if omitted. Update types/schema/consumer tests together; do not add a parallel verbose result and duplicate its text.
- Preserve names, refs, disambiguating context, meaningful state, validation and destinations. Deduplicate repeated contextual labels in presentation only when association stays explicit.
- Rank by requested/current semantic scope before generic role priority. Keep semantic target search independent of presentation limits.
- Give every omission a truthful reason: output limit, work limit, rendered subset, unavailable evidence. Empty unsupported scope is not complete.
- Audit acquisition caps before browser work and at transport response boundaries, not merely after parsing. Avoid query-all link/form/control paths for tiny requested views when bounded traversal can serve them.
- Keep one final UTF-8 envelope budget, including mandatory receipt and refs. No discarded action-side read or silently reset snapshot.

Acceptance: exact-byte Unicode/redaction edges, long names/URLs, thousands of controls, deep controls, large link trees, duplicate rows, tiny budgets and missing frames. Record CDP calls and bytes as well as visible output. Set numerical improvement targets from fixed baseline tasks before tuning; correctness takes precedence.

## 5. Workstream B — complete reading, text search and precise editing

**Owner: Astra for production contracts and algorithms.** Files: `document-reader.ts`, `structured-reader.ts`, `table-reader.ts`, `table-grid.ts`, `target-resolver.ts`, `native-input.ts`, `page-executor.ts`, core command variants/schema and matching tests.

### B1. Text wait must not turn a truncated search into absence

Confirmed: `waitFact` searches each frame using `readBoundText(...8192,10000,false,false)` and checks `includes`; it ignores truncation. Text after that prefix can exist while the wait repeatedly reports no match. The recent outside-main fix is necessary but does not solve this.

Implement a bounded match-specific rendered-text probe that searches without returning the entire page. Return match / absent-within-complete-scope / incomplete, with work accounting. When exhausted, surface search incompleteness instead of using absence as evidence. Share exclusion/composed-tree rules with document reading. Check frame-owner visibility and scope before considering child text. A condition wait may retry on actual relevant transitions under its deadline; it must not blindly rescan an unchanged truncated prefix.

Tests: match after 8192 characters, boundary-spanning text, Unicode, hidden iframe owner, detached/replaced frame, search dialog outside main, shadow/slot text, work cap and cancellation. Document reading retains its main/article preference; wait searches page-visible scope.

### B2. Closed-shadow and cross-frame document reading

Open-shadow, slot and PRE handling now exist. Do not redo them. Closed-shadow discovery remains absent from the document traversal even though native target/sensitive discovery supports closed roots.

Add bounded native CDP discovery of authored closed roots and connect it to the same ordered rendered-document projection. Define insertion order at hosts/slots, prevent duplicate assigned content and exclude unrendered light/fallback nodes. Read isolated native objects; no page-world fallback or JS mutation. Preserve host/ancestor exclusions across shadow and frame boundaries. Release all temporary objects/search results on success, failure and cancellation.

Test nested open/closed roots, slots with fallback/assignment, hidden/sensitive hosts, code blocks, frames inside shadow content, late detach and exact Unicode continuation reconstruction. If native evidence cannot establish order/scope, expose incomplete coverage rather than silently dropping it.

### B3. Records/deltas and real data

Audit `readStructuredRecords`: link queries presently collect AX matches and only then apply result/work caps; form projection similarly has several distinct caps. Unify acquisition accounting with A3. Preserve table header/span/grid semantics already implemented. Check delta baseline scope, frame stamps and reset bounds against changed/virtualized content.

Acceptance: actual loaded subset from a real virtualized list/table, explicit missing cells/headers, row/col spans, links, form validation, delta after child navigation, expired cursor/baseline, output truncation. No guessed offscreen rows, whitespace-based table parsing or claims that rendered coverage equals the full remote dataset.

### B4. Precise editing — missing planned functionality

P05 requires explicit text match, optional prefix/suffix and occurrence constraints. Current native input provides chords/clicks/cleanup; whole-field fill/type is not that feature.

1. Add one strict typed edit variant in core: bounded match/replacement, optional context/occurrence, target, documented UTF-16 offsets and line-ending behavior. Reject unknown or conflicting constraints before input.
2. Resolve a unique range against an ordinary non-sensitive input/textarea with bounded native reads. Ambiguous match must not choose the first occurrence.
3. Prove a trusted bounded native selection/edit path on actual supported browsers. Investigate available native editing/composition primitives before choosing one; use primary protocol documentation when implementing. Do not set DOM Range/selection by injected mutation or simulate selection with unbounded arrow-key sequences.
4. Revalidate target/focus/sensitivity and selection immediately before insertion. Verify the resulting text and unchanged prefix/suffix. Preserve preparatory effects in failure receipts.
5. Extend to contenteditable only with a defined native selection model and independent persistence oracle. IME composition, multiline content and rich editor normalization need explicit tests; ordinary input success does not prove them.
6. If a requested range cannot be edited reliably within bounds, return unsupported with actual facts and keep the acceptance gap open. Do not replace the entire field as a hidden workaround.

Tests: repeated text, prefix/suffix disambiguation, occurrence, emoji/surrogates, CRLF/newlines, empty/replacement cases, readonly/password transition, DOM replacement, selection drift, cancellation after preparation and app-accepted trusted events. Persist/reopen a designated disposable rich document in real QA.

### B5. Selection and sequence conformance

Current native select uses Home/ArrowDown/Enter and explicitly rejects multiple select; custom controls return unsupported from the select action. Retain honest errors. Bound option discovery (currently `Array.from(this.options)` collects all options) and input work before focus. Prove Windows Chrome/Edge/Linux keyboard semantics and trusted change acceptance, including disabled optgroups and duplicate labels/values.

Use normal observed custom listbox controls for custom widgets. A direct multi-select API should be added only with an explicit selection-set contract and a proven native path; do not quietly reinterpret the existing single string. Document supported limits. Re-run sequence prefix preservation, exclusivity, dialogs/navigation mid-batch and no replay after timeout with new edit primitives.

## 6. Workstream C — visual, lifecycle and adapter reliability

**Owner: Astra.** Files: capture/mask modules, `page-executor.ts`, `page-directory.ts`, `existing-page-family.ts`, `existing-connection.ts`, `apps/tab-adapter/src/claims.ts`, native transport and engine host.

### C1. Complete visual evidence, not more screenshot-length checks

Keep the implemented automatic masks, projective child-frame mapping, one bounded full-page recapture and native hidden borrowed observation. Verify their remaining edges in one matrix:

- Viewport/full page/clipped capture; scroll, zoom, device scale and transformed nested frames.
- Same-process iframe clipping versus OOPIF projection; sensitive regions partly outside visible iframe area. Investigate overmasking as a usability defect as well as undermasking.
- Independent bottom-pixel oracle for borrowed full-page capture, matching the existing owned regression; mask pixel oracle in both modes.
- Coordinate action after resize/navigation/scroll/layout movement: invalidate stale provenance and never quietly click an old coordinate.
- Dynamic masks/frame membership, repeated spatial movement, cancellation and late replies. No page freezing or fake focus.
- Hidden capture lifecycle: stop never acknowledges, route closes during capture, late start after deadline, cleanup failure. Prove bounded ownership/buffer lifetime and quarantine the exact connection on unresolved cleanup. Do not leak streams or publish a usable capture whose cleanup failed.

Actual screenshot inspection is required for real visual tasks. Record its reviewer and oracle. A nonempty PNG or matching AX title is insufficient.

### C2. Popup/frame/dialog/worker stress

Run same-tab races and distinct-tab concurrency through separate MCP processes, not two calls in one host. Cover recursive popups, popup attach failure, OOPIF replacement/late detach, human tab close, extension reload, DevTools detach, one native peer dying, browser exit and stale ID reuse.

Investigate the historical hidden hover timeout and cross-worker modal stall with held/deferred native acknowledgements. Determine browser-imposed blocking versus Newton queue/transport coupling. Fix product coupling; report real browser constraints honestly. No global browser lock, activation workaround or timeout inflation.

Pending popup attachment must not disappear into empty output or block unrelated status/stop. Return owned admitted identities and explicit bounded incompleteness/failure. Stop retains personal tabs/dialogs and cannot kill the user's Chrome. Owned host loss terminates only its proven browser tree/lease.

### C3. Resource ledger

Create one table of each retained resource, owner, admission cap, eviction/cleanup trigger and regression: pages/frames, refs/snapshots/cursors, command tombstones/results, pending CDP, IPC chunks, image buffers, native claims, read objects, event listeners and capture cleanup. Exercise navigation/cancellation churn at the cap and assert plateau plus correct errors. Do not add a permanent monitoring subsystem to measure this.

## 7. Workstream D — shared login, installation and platforms

### D1. Shared source product flow

Confirmed default `createDefaultEngineHost` clones the configured/default Newton source and launches a separate headless identity. Preserve this. No extension discovery delay in standalone startup, no personal-profile auto-selection.

Confirmed CLI mismatch: `source refresh` calls `collectRetired()` and prints `refreshed`; publication occurs via `source login`. Correct the naming/semantics and help text so refreshing authentication means an explicit maintenance→closed publication transaction, while garbage collection is described as such. Preserve active clones and immutable generation publication. Audit setup/doctor/identity commands during legacy removal so none instantiate the old runtime.

Acceptance: three real MCP workers inherit the synthetic fixture login; refresh while two remain active; third uses new generation; local logout does not mutate another profile; server revocation is reflected normally; interrupted publication/recovery, stale lease, locked/symlink/partial source. Then repeat actual sign-in and independent tasks with a designated real QA account. Prove login via page-visible application state, never credential/storage inspection.

### D2. Finish supported installation paths

Confirmed: `native-install.ts` rejects non-Windows and native runtime storage assumes `node.exe`. This is a concrete platform implementation gap, not just a missing Linux test.

Keep the Windows private IPC/immutable launcher design. Implement the supported Linux native-host registration/launcher/IPC path using the same protocol/claim authority and owned installation rules. Separate platform path/registration mechanics narrowly; do not fork the engine or add TCP listeners/daemons. Verify executable permissions, atomic updates, process ownership, missing runtime and cleanup on actual Linux. Verify Windows Edge separately, including registration/extension setup and standalone discovery.

Inventory available Linux environment, browser binaries and real QA account/data at the beginning of execution. If unavailable, continue independent implementation, but preserve the explicit blocked coverage row. Do not silently remove promised platform acceptance or label Windows emulation a Linux pass.

### D3. Thin extension and update finish

Reuse the existing immutable installation/journal/recovery work. Test two compatible engine builds against byte-identical extension assets and prove the install works after the source checkout is unavailable. Validate major incompatibility and missing/disabled/broken helper while standalone remains usable.

Separate developer update artifacts/commands from production runtime behavior with actual packed-byte assertions. Keep one-time browser installation honest; ordinary engine edits must not require reinstalling the extension. Exercise older/unsealed installation migration without weakening digest/ownership checks, failed bootstrap, concurrent setup/update and another installation/browser family remaining untouched.

No remotely loaded code, auto-update daemon, restored retired extension/relay, exact engine-version lockstep, or public store submission.

## 8. Workstream E — retire legacy and make one product

**Owner: Astra; do not delegate overlapping deletion.** This is a major migration, not a cleanup grep.

Verified surviving dependencies:

| Surface | Required disposition |
| --- | --- |
| `packages/driver/src/driver.ts`, `direct-session-runtime.ts`, `session-command-pump.ts`, old target/input/liveness helpers | Map consumers and behavior, port missing negative tests, remove superseded runtime/ref/queue responsibilities |
| `packages/driver/package.json` `./direct-session-runtime` export | Remove once callers migrate; inspect built package exports too |
| `apps/mcp-server/src/mcp-server.ts` direct host branch, `prepareActionForDispatch`, legacy catalog/normalization | Make canonical engine the only production command/receipt path |
| `browser-runtime/direct-browser-host.ts`, `default-direct-host.ts`, `configured-direct-host.ts` | Migrate CLI/runtime consumers; preserve useful config/profile utilities without preserving old execution |
| `cli.ts`, `direct-setup-cli.ts` | Setup/login/doctor use new lifecycle; maintain explicit operator utilities and safe compatibility where needed |
| `agent-output.ts`, old action schema/types and mapper fixtures | Remove superseded output inference; retain only independently useful redaction/encoding functions |
| Old smoke/eval scripts | Port actual behavioral oracles; retire assertions of deleted implementation shapes |
| `engine-candidate.js` packaging entry | Audit actual consumers and purpose; eliminate candidate-only duplicate runtime if unnecessary after migration |

Execution order: map imports/exports → identify behavior oracles → add replacement coverage → migrate CLI/tests/harness → delete obsolete modules/exports → inspect bundle/artifact → update docs. Do not delete a failing behavior test without its stronger replacement in the same change. Do not move old code to `legacy/` or preserve fallback execution behind an environment flag.

Port A01–A10 explicitly: focus-sensitive race, replacement route, partial/exclusive batch, readonly fill, navigation failure, hidden wait, useful returned state, private ref preservation, exact budgets/continuation, late semantic matches, deadlines, stop independence, asynchronous process scan, trusted select and initial URL preservation. Record test file and independent oracle for every row.

Artifact gate: one action/receipt/ref authority, no old exports/catalog, no production development-loading switches or obsolete relay/listener/init-era code, no dependency on prototype/.NET tooling. Use bundle entry/import analysis plus packed content assertions and a real extracted-package run; string matching alone is not proof.

Update README, installation/help, worker skill, architecture and migration inventory. The existing inventory falsely lists upload/hover/dialog/resize as missing; correct current status while retaining dated reports. Document limitations/capabilities, the shortest normal model loop, shared-source defaults and explicit existing-browser selection.

## 9. Workstream F — acceptance and release orchestration

### F1. Replace misleading gates before counting release passes

`scripts/release-complete-local.mjs` currently runs deterministic stages plus real-sites and packed-direct scripts, then reports other platform evidence separately. `scripts/measure-agent-cost.mjs` imports old `agent-output` projections and old fixture formats. Neither is sufficient replacement acceptance.

Implement the planned root gates using existing test infrastructure: `test:engine`, `test:reader`, `test:connections`, `qa:tasks`, `qa:model-cost`. Reuse current packed probes and independent fixtures; do not build another framework. Behavioral integration must exercise `handleMcpMessage` and separately extracted packed stdio. Direct executor tests remain focused unit evidence only.

Release orchestration must require a manifest of all mandatory cases/modes/platforms and same-candidate receipts. Missing/skipped/failed critical rows fail completeness. Validate browser versions, package hash, source digest, oracle result and cleanup; do not accept an arbitrary JSON file with `ok:true`.

Candidate hashing must include intended untracked source/config/docs/catalog/skill. Explicitly exclude only generated run outputs/temporary artifacts. Current evidence outside ignored `test/evidence/runs/` can change the tree hash during a run: standardize new run output there and keep exclusions narrow. Recheck source and artifact identities after every pass.

### F2. Real task matrix

Choose exact targets and authorized QA data in the run manifest before executing. Public task choices below reuse useful established baselines; other tasks need actual designated pages, not lookalike fixtures.

| Family | Concrete completion oracle | Required coverage |
| --- | --- | --- |
| Wikipedia search/navigation | Correct result, section/link and supported answer | Both modes |
| MDN/W3C documentation | Correct destination, code/links, complete bounded continuation | Both modes; MDN feedback reproduction included |
| GitHub public issue filtering | Intended query/filter and matching visible rows | Both modes; no posting |
| Storefront | Correct displayed product and selected variant | Real store; no purchase |
| Authenticated form | Disposable authorized record persists intended fields after reopen; surrounding data unchanged | Both modes |
| Rich editor | Exact intended range changed, surrounding Unicode/repeated text preserved after persistence | Both modes |
| Virtualized data | Accurate loaded/visible cells and destinations; truthful subset limits | Real interactive list/table |
| Tabs/popups | Correct opener/page ownership, return and continue | Both modes and two-process checks |
| Embedded/weak-AX UI | Visible intended effect through supported screenshot/coordinate path | Saved screenshots inspected |
| Shared authentication | Two standalone workers visibly signed in and independently progress | Real Newton source, isolated identities |
| Existing browser | Two workers operate separate owned tabs; stop preserves unrelated state | Explicit connection, real extension |

CAPTCHA, unavailable account/environment and site outage remain named gaps. Do not substitute easier static pages, direct APIs, instrumentation or fabricated success. Existing task authorization does not authorize arbitrary messages, purchases or edits to production records. If no suitable disposable account/data exists, that specific input is required; it does not block unrelated engineering.

### F3. Measure the actual model loop

Migrate deterministic cost tests to canonical engine receipts, but label them serialization/script benchmarks. Separately run actual model-directed tasks through public tools. Fix model/settings, instructions, browser, mode, starting state and candidate; capture model identity available from the harness rather than assuming it.

Five matched repetitions per selected task/mode initially. Preserve failures in the denominator. Record tool turns, explicit observes, repair calls, invalid refs, unchanged reads, useful action-feedback latency, condition/unconditional waits, reconciliation, total time including model decisions, available model tokens, locally estimated tool text tokens with tokenizer, screenshots and operator interventions. Separate cold installation/source clone from warm action cost. Five samples support raw results/medians, not a stable p95 claim.

Use current Newton baseline evidence where comparable; do not rebuild/retain a legacy production engine solely for benchmarking. Historical scripted and model runs are not automatically matched. Record comparator limitations. No ChatGPT speed/parity claim without an actual matched run.

Hard product criteria: start/select returns useful state; ordinary local edit avoids full-page verification; action response enables the known next decision; no hidden ref invalidation; no global settle delay; no uncertain-input replay. Establish token/latency targets from baseline before optimizing and retain failed samples.

### F4. Freeze and certify

After A–E and acceptance corrections: run build/typecheck/lint/test, migrated eval/cost gates, pack and replacement connection/task gates on supported Windows Chrome/Edge and Linux. Freeze source plus package. Require **three consecutive complete `pnpm release:check` passes with identical candidate/package identity and no skipped critical cases**. Any source change restarts the final sequence after affected checks.

Final evidence index includes A01–A10 mapping, all packet exits, real task receipts, model metrics, reviewed visual artifacts, platform/install evidence, cleanup and explicit limitations. No public publishing, remote changes, store submission or license changes are included.

## 10. Consolidated execution order and ownership

1. **Preflight and coverage ledger:** inventory candidate/platform/account availability; map exact legacy consumers and required tests; preserve existing baseline. Do not spend this phase rerunning every historical diagnostic.
2. **Model-facing implementation batch:** A1–A3 and B1–B5 together, focused regressions as each defect is fixed. Establish the native precise-edit feasibility path early because it can constrain real editor acceptance.
3. **Lifecycle/platform batch:** C and D, plus independent resource/connection conformance. Begin Linux installation work early enough that it is not discovered at release time.
4. **Single-engine integration:** E and F1 together. Migrate tests/CLI/release consumers before deleting their old implementation. Run full source gates once the integrated tree is coherent.
5. **One packed acceptance candidate:** both-backend conformance, real tasks, visual inspection and actual model-loop runs. Group resulting defects by root cause; add deterministic regression, fix, rerun affected checks, then broad integration once.
6. **Final freeze:** same-candidate platform receipts, three full gates, final evidence/docs. Stop broadening scope when every agreed requirement passes; do not declare completion before then.

Build/dist/package mutations are sequential. No QA process imports a dist tree being rebuilt. Repack at integration boundaries, not after every assertion. No sleeps or larger timeouts to hide failures. No speculative extra framework or feature outside this contract.

Only the existing Luna task `01a07df6-18c6-7401-9155-f8cb73cbcc18` may assist. Its outstanding shadow-input adversarial assignment retains ownership of `test/engine-regressions/shadow-input-adversarial.test.mjs` and `test/evidence/luna-shadow-input-adversarial.md` until its proactive completion report. Do not poll/read those paths for progress or overlap its writes.

After that report, useful bounded assignments are independent fixture oracles, a read-only legacy-test mapping, or fixed-candidate QA with run-scoped evidence paths. Give exact write paths and acceptance criteria; prohibit production/build/package edits during QA. Require proactive completion/failure report to the parent task as its highest-priority coordination rule. Astra continues useful work without wait_threads/polling, reviews every candidate independently and owns core architecture/integration. No other tasks or subagents.

## 11. Completion definition and unresolved facts

This plan deliberately does not give a percentage or promise one uninterrupted session can overcome missing external environments. The remaining engineering is substantial; some of it is architecture and native-browser behavior, not merely churning through tests.

Known missing implementation: precise range editing; Linux native installation; complete useful navigation/changed-context feedback; legacy retirement; replacement acceptance orchestration. Known defects/contract mismatches include truncated text-wait absence, incomplete observation reasons and refresh CLI semantics. Other listed visual/lifecycle/real-app items are investigations or unproven acceptance, not invented confirmed bugs.

Resolve early: exact root cause of empty navigation AX feedback; reliable bounded native range-selection capability by platform/editor; available Linux runtime; designated real authenticated QA accounts/data; remaining browser-imposed modal constraints. An unresolved capability remains explicit; it cannot become a pass through a weaker test.

Preserve previously reported cleanup residues whose deletion was denied by automatic review. Do not retry them through a different shell/tool or count them as newly cleaned. Each new run cleans only resources it can prove it owns.

The final deliverable is one coherent installed browser-control product, current documentation and a complete same-candidate evidence set. Passing another small regression batch is progress toward that deliverable, not its substitute.
