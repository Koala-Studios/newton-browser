# Astra execution checkpoint

> Status reconciliation, 2026-09-25: this file retains historical implementation/handoff evidence. Current facts and unresolved gates are in [PROGRESS_LEDGER.md](../PROGRESS_LEDGER.md). Default engine cutover and precise editing are now implemented; legacy deletion and full replacement release acceptance are not. Earlier three-pass or completion statements apply only to their narrower historical candidate. No worker instructions here override the current solo-only rule.


Active goal: complete all approved P00–P14 architecture and independently verify the
replacement. No publication. Authoritative checkout is this 421a worktree at baseline
`f2ae1ee71c66bea3488926df8332bec2d1ec7cfc`; extensive uncommitted work is intentional.

## Ownership (2026-09-08)

### Live MDN reveals page-wide text-wait scope bug; candidate fixed

- Source public-handler scripted MDN flow: navigation feedback refresh carries new
  generation3 but returns incomplete/rendered_subset with zero controls. It avoids
  stale_target but does not yet provide useful destination state. Keep feedback
  readiness/compact loading context open. astra-mdn-feedback-live.json/.log.
- Same run wait_for text timed out after5,032ms although its resulting AX feedback
  included the requested Search result. Root cause: text waits reused document
  reader main/article preference, excluding the search dialog outside main.
- Added preferMain option to bounded native reader; document reads keep preference,
  page-wide text waits read body. Existing exclusions and traversal bounds retained.
  Real Chrome regression verifies visible outside-main text matches, hidden text
  does not, focused document output still omits the header. Five tests pass3,871.8666ms.
- Fresh live MDN wait completes63.4366ms; Search-result click completes, still with
  zero-control incomplete destination feedback. Exact evidence:
  astra-mdn-wait-fixed.json/.log. Both live runs stopped sessions/hosts and cleaned
  disposable roots. Scripted diagnostic, not model task parity. Full suite v34
  passes816/816,31,722.9231ms,no skips/cancellations. Long-body text beyond read
  bound remains a separate gap.

### Navigation action feedback refresh candidate

- v49 MDN search-result click completed but navigation invalidated its optional
  observation. observeAfterAction now refreshes the same page once only when the
  first read throws stale_target and root document generation actually advanced.
  Original context/deadline/exact budget retained; no input replay, sleeps or generic
  recovery loop. Unchanged document, unrelated error and second instability refuse.
- Deterministic state-transition tests pass2/2,161.6802ms in
  astra-navigation-feedback.log. These inject generation changes; live model MDN
  replay is still needed to establish real feedback improvement. Full suite v33
  passes815/815,33,305.0257ms,no skips/cancellations. Packed v53 predates this candidate.

### Capture cleanup synchronous-throw edge fixed; QA scaffolding removed

- A synchronous wire.send throw before entering try/finally could strand capture
  observation ownership. Start dispatch now enters a promise first so the same
  cleanup handles synchronous throws and rejected acknowledgements. New repro
  confirms one stop and empty ownership. Eleven focused tests pass167.9071ms
  (astra-capture-sync-unit.log).
- Removed temporary full-page-first, active-tab, independent screencast and own-route
  QA brackets. Harness calls public screenshots directly and retains full-page and
  hidden-visibility assertions. Packed v53 passes the clean harness at
  2026-09-08T13:27:04.154Z (astra-clean-adapter-v53.log).
- Packed v53:329,700 bytes,13 files,SHA256
  `038bb2482517f3bfcb6e543d08b217134a40c001eade78a772101164cacc18ad`.
  pack:check passes. Latest full source suite remains v32 before this small fix;
  no updated full-suite claim. Pinned-hash online probes all pass: Wikipedia search,
  GitHub issues filter, W3C document continuations.27 calls,53,304 output-text tokens,
  4,808 catalog tokens; all three sessions stopped,process closed,artifact unchanged.
  astra-packed-probes-v53.json/.log. These are scripted checks, not model-run parity.

### Hidden full-page observation integrated and packed adapter passes

- Engine screenshot wrapper starts1x1 native screencast only for hidden borrowed
  full-page captures. No frame acknowledgements/retained stream. Original route is
  captured before start; finally stops after start settles, including late start on
  cancellation. Pending ownership rejects another capture until cleanup finishes.
  Release failure faults/closes that connection. Both capture attempts share bracket
  and original CommandContext; cancellation does not await late cleanup indefinitely.
- Packed v52:329,693 bytes,13 files,pack:check passes,SHA256
  `041dbbd8d6aa35f64d8ca7243f377b73a68a9778cce1bd71d456a241a6b1c221`.
  Normal qa:foundation-tabs (no workaround flags) passes2026-09-08T13:24:36.288Z,
  including full-page PNG/mask/height checks on both workers, hidden visibility and
  empty change arrays, native effects, update/rollback/crash recovery. Evidence:
  astra-capture-observation-adapter-v52.log. This establishes production integration
  for that fixture, not broad real-site acceptance.
- Ten focused tests pass,171.2061ms (astra-capture-observation-unit-b.log): normal
  start/stop route, no frame ack, cancelled late start, next-capture exclusion,
  start/capture failure cleanup, stop failure closes, plus recapture and mask checks.
  Full suite v32 passes812/812,30,811.7211ms,no skips/cancellations. Remaining
  requirements unchanged; no full release acceptance claim.

### Same-connection capture observation proven with packed v51

- Added Page.startScreencast/stopScreencast to private adapter method allowlist;
  no new public MCP tools. Packed v51 passes pack:check,329,249 bytes,13 files,
  SHA256b0c36076b381a32b5a28fa2eccab9c678b313972ee985f58645085696b2aed0e.
- QA-only client bracket starts1x1 native screencast on the session executor's own
  route, calls public full-page screenshot, then stops in finally. No independent
  oracle stream or tab activation. Full harness passes2026-09-08T13:21:21.535Z;
  both tabs remain hidden, no visibility changes, full-page assertions and all
  action/update/recovery checks pass. astra-adapter-own-route-capture-v51.log.
- Engine integration remains to implement: preserve original CommandContext,
  stop on success/error/cancel, handle late start acknowledgements, use captured
  route for cleanup, and avoid a cleanup response indefinitely stalling cancelled
  work. Failure to release must not silently leave a permanent capture observation.
  Diagnostic client accesses executor internals only under the QA flag and is not
  production logic. Package v51 contains allowlist support but not the bracket.

### Native screencast observation unblocks hidden full-page diagnostic

- Chromium page_handler.cc source inspected: screenshot creates a stay_hidden
  capturer, applies native size/emulation, then requests a surface snapshot. Source
  explicitly notes hidden surface presentation can stall. Omitting clip routes back
  into the same capture implementation, so is not a distinct solution.
- QA-only NEWTON_QA_CAPTURE_SCREENCAST starts native Page.startScreencast on the
  independent fixture oracle connections with maxWidth/maxHeight1. No frame ack
  loop or page writes; native in-flight limit bounds pending frame delivery.
  Full packed harness passes2026-09-08T13:19:16.370Z, including the new full-page
  state/mask/raster-height assertions. Both tab visibility values remain hidden,
  changes arrays empty. Update/recovery/input oracles still pass.
  Evidence: astra-adapter-full-page-screencast-v50.log. Native stream ends with
  owned fixture debugger/browser cleanup. This diagnostic is not production support.
- Next: implement bounded short-lived native capture observation on Newton's own
  debugger route, bracketed around full-page capture/retry. Prove same-connection
  operation, cleanup on error/cancel/late start, no retained stream/images, correct
  adapter allowlist and unchanged hidden visibility. Avoid permanent streaming or
  increasing capture deadlines. Package v50 remains unchanged.

### Adapter full-page stall isolated to hidden-tab operation

- Reordered full-page ahead of explicit viewport capture using QA-only flag; still
  times out. Trace shows initial input-preparation viewport response, then unanswered
  capture request. astra-adapter-full-page-first-v50.log rules out explicit viewport
  capture order as root cause.
- QA-only activation of each disposable worker tab before its probe lets both
  full-page PNG/state/mask/height assertions and subsequent action probes complete.
  The unchanged hidden-tab visibility oracle then correctly fails. Evidence:
  astra-adapter-full-page-active-v50.log. This is diagnostic, not an acceptance pass
  or authorization to activate production tabs. No production source/package edits.
- The native full-page path therefore needs a hidden-tab solution; merely changing
  deadlines or activating user tabs is not the intended implementation. Retained
  QA flags live only in scripts and are absent from packed v50. Browser fixtures
  exited through existing finally cleanup; no new cleanup rejection reported.

### Packed v50 adapter viewport passes; added full-page QA fails

- Existing packed adapter harness passes at2026-09-08T13:13:11.156Z, including
  two workers, masked viewport PNGs, native input, popups, scoped documents/controls,
  update/rollback/exact updater kill recovery. Evidence: astra-adapter-v50.log.
- Extended the same client/probe with a fullPage screenshot before opening prompts;
  assertions require available/masked PNG and clip/raster taller than viewport.
  Both calls retain ordinary budgets/deadlines. This QA-only change is not in package.
- New run fails timed_out at native Page.captureScreenshot, with no response before
  deadline, rather than the standalone spatial mismatch. Evidence:
  astra-adapter-full-page-v50.log. Need isolate hidden-tab native full-page behavior;
  do not widen timeouts, remove the check or claim adapter full-page acceptance.
  Existing overall v50 adapter pass predates the added check and cannot cover it.
- Tarball hash independently unchanged45ee7d4fc8729e08bea6cc60eb07a6fe3d4103b21931bb35572ed8a5751def16.
  Design screenshot status updated to distinguish standalone fix from adapter gap.

### Production full-page recapture candidate implemented

- PageExecutor.screenshot delegates to a private capture attempt. Only full-page
  spatial mismatch may trigger one fresh attempt; the first pixels and geometry are
  discarded without registering an ID. The second rebuilds clip, masks and frame
  evidence under the same CommandContext/deadline. Repeated mismatch rejects.
  Frame membership must remain unchanged and no frame attachment may be pending.
  Normal viewport-only captures retain their single-attempt contract.
- Focused suite first passes7/7 including native full-page bottom-marker oracle
  (astra-full-page-fixed.log). Added fault coverage for cancellation, navigation and
  pending frames: no second capture or published ID permitted. Full suite v31
  passes809/809,30,282.9814ms,no skips/cancellations. Temporary full-page top/recapture test flags
  removed after establishing production behavior; historical diagnostic logs remain.
- This addresses capture coherence, not Chromium's underlying scrollbar transition.
  Broader full-page live QA, transformed masking, closed shadow document reading,
  model feedback and complete P00–P14 release acceptance remain open. Packed v49
  is superseded by v50: pack:check passes,329,232 bytes,13 files,SHA256
  `45ee7d4fc8729e08bea6cc60eb07a6fe3d4103b21931bb35572ed8a5751def16`.
  Final focused rerun after removing inactive QA flags passes8/8,1,973.6257ms
  (astra-full-page-final.log). No packed live acceptance run yet for v50.

### Full-page native recapture diagnostic finds a viable path

- QA-only FULL_PAGE_AT_TOP confirms same749→764 width transition at scrollY0;
  failure is not scrolled coordinate conversion (astra-full-page-top.log).
- Chromium page_handler.cc source fetched directly from chromium.googlesource.com:
  captureBeyondViewport saves WebPreferences, sets hide_scrollbars and
  record_whole_document, and temporarily applies emulation sizes. Existing native
  implementation explains the scrollbar-width transition; no new production
  emulation/styles/scrolling were added.
- QA-only NEWTON_QA_FULL_PAGE_RECAPTURE retries once after stale_target. Actual
  trace is749→764 for first capture,764→764 for second. The second passes all
  existing spatial/mask checks and the offscreen bottom-marker RGB oracle. Full
  adversarial test passes (astra-full-page-recapture.log and -b.log), with the
  latter recording all metrics/capture params. Browser fixture cleanup succeeds.
- This remains a diagnostic, not a production fix. Next: consider one bounded
  full-page recapture only after spatial transition, rebuilding masks/clip/frame
  evidence and retaining unchanged deadline. Prove repeated movement refuses,
  first capture has no published ID, navigation/attachment changes still refuse,
  and viewport-only screenshots retain their current contract. Do not generalize
  into retries of mutating actions or weaken sameCaptureSpatial.

### Explicit scopes now exclude unrendered light DOM and replaced slot fallback

- Repro: directly scoped unassigned light child returned unassigned-secret despite
  not appearing in the composed document. Ancestry now rejects children of an open
  shadow host without assignment, and fallback descendants when their slot has
  assigned nodes. Frame inclusion uses the same exclusion. Assigned content remains
  readable and included. Real test retains previous-behavior repro in-process.
- Chrome rejects native assignedNodes() under throwOnSideEffect for fallback checks.
  FRAME_SCOPE_FUNCTION now follows the existing document-reader call convention:
  read-only native function on objects resolved in the isolated world, without that
  debug checker. Production send() forces DOM.resolveNode into ReadonlyWorlds.
  Fixture overrides page HTMLSlotElement.assignedNodes to throw; native isolated
  document and frame predicates still succeed. No main-world/page-mutating fallback.
- Seven predicate/document tests pass,3,019.0475ms, no skips. Evidence:
  astra-unassigned-shadow-document-c.log. Failed checker attempt retained as -b.log.
  Full suite v30 completed in31,145.6139ms with only the known full-page screenshot
  spatial-guard failure (astra-suite-v30.log). Closed-shadow discovery remains open.

### Scoped shadow-host exclusions fixed

- Scoped document ancestry stopped at parentElement, bypassing outer shadow hosts.
  It now follows assignedSlot, parentElement, then the containing shadow root's host.
  FRAME_SCOPE_FUNCTION uses the same ancestry and bounded membership walk rather
  than ordinary contains(), preserving host exclusions and admitting visible shadow
  descendants. No page mutation or input changes.
- Actual Chrome regression runs the previous parentElement-only function and proves
  it exposes excluded-host-secret from an aria-hidden host; current reader returns
  empty text with excluded:true. Frame scope returns false for that hidden leaf and
  true for visible shadow code under main, with native side-effect checking enabled.
  Four document tests pass,2,981.7292ms (astra-scoped-shadow-document.log).
- Closed shadow document discovery and unrendered explicitly scoped light-DOM edge
  cases remain unproven. Full suite v29:802/806 pass,30,719.7098ms,no skips. Three
  VM fixtures asserted contains() membership without corresponding parent relations;
  updated to realistic ancestry. Membership walk now precedes style/exclusion walk,
  preserving outside-frame rejection before style reads. Combined predicate/real
  document rerun7/7 pass,2,938.7661ms (astra-scoped-shadow-document-b.log). Remaining
  full-run failure is known full-page geometry. Full suite not rerun after correction.
  Packed v49 predates both document fixes. No release claim.

### MDN code omission traced and open-shadow reading fixed

- Native live diagnostic confirms zero document-level PRE elements after hydration;
  five MDN-CODE-EXAMPLE hosts each have an open shadow root containing a PRE.
  Evidence: astra-mdn-code-diagnostic.log and astra-mdn-code-tree.log. Reader only
  followed childNodes, explaining the missing syntax/examples in v49 task output.
- DOCUMENT_READ_FUNCTION now descends open shadow content instead of unrendered
  light children. Slots contribute unflattened assigned nodes or fallback children,
  preserving bounded traversal, order, whitespace and existing exclusions.
- Extended actual-Chrome document fixture covers nested shadow code, assigned slot
  exactly once, fallback, unassigned/fallback suppression, hidden and input exclusion.
  Three document tests pass,2,971.8969ms; continuation reconstruction and generation
  expiry still pass. Evidence: astra-shadow-document.log.
- Fresh source public-handler MDN read returns available12,904 characters, including
  fetch(resource) syntax and new Request examples. Exact read/start/stop evidence in
  astra-mdn-code-fixed.json/.log; owned browser/host/temp root cleaned successfully.
- This is open-shadow support only. Closed-root document content and scoped-read
  exclusion ancestry across hosts still require explicit design/coverage. Packed v49
  predates this fix. Full suite v28 completed in30,153.8015ms with one failure:
  the known full-page screenshot spatial guard (luna-adversarial.test.mjs:142).
  No skips/cancellations; full-page geometry remains unresolved, not integration green.

### Packed v49 model-directed MDN task succeeds

- Search click/fill/result-selection and document read completed using returned
  controls, no screenshots/sleeps/wait_for/input retries. Seven public calls including
  stop,4,900 text tokens,1,393.808ms aggregate handler time; excludes stdio/model time.
  Exact evidence and limits: astra-model-v49.json/.md. Browser/host/REPL closed.
- Navigation succeeded but optional feedback returned stale_target, recovered by
  document read. Code examples appear absent from the returned document despite
  headings/prose and server HTML examples. Hydrated structure/root cause unproven;
  investigate before implementing a fix. Initial footer noise remains.
- Cleanup of exact QA package/config directories was blocked by automatic review.
  Paths recorded in the report; do not retry via another mechanism. No full release
  acceptance claim; full-page screenshot and wider architecture gates remain open.

### Screenshot response budget separated from text (v49 candidate)

- Image responses previously inherited the 64KiB text ceiling, causing ordinary
  MDN captures to fail and requiring repeated clipped requests. Screenshot default
  is now 2MiB, maximum 4MiB, centrally defined in ENGINE_LIMITS and shared by the
  public parser/catalog and session queue. Text reads/actions retain their limits.
  Exact final encoded-response enforcement and the 20M pixel raster cap remain.
- Public-handler regression delivers a 100KB image payload, rejects too-small
  explicit output budgets and invalid limits, and checks text catalog isolation.
  Combined with native shadow-input regression: 3/3 pass,825.4061ms, no skips.
  Evidence: astra-image-budget-regressions.log. This is bounded transport capacity,
  not image compression or a guarantee that every page fits.
- Live source public-handler MDN start/default screenshot/stop succeeds; inspected
  PNG is a readable749x485 viewport,36,007 PNG bytes,162.048ms screenshot call.
  That live capture is below the old ceiling, so does not independently reproduce
  the old oversized failure. Plain copied Windows environment also starts correctly.
  Files: astra-mdn-image-budget.json/.log/.png. Owned browser/host and disposable
  fixture root cleaned successfully. This three-call smoke is not full task QA.
- Packed v49 passes pack:check,328,481 bytes,13 files,SHA256
  `43fc069dfc1f7e0f7cc194dccf432eb669feb00a66af14a4d6b742e0b05351fe`.
  Includes shadow-input, Windows environment and screenshot budget fixes. No packed
  live replay or all-green full-suite claim yet. Full-page geometry defect remains.
  Luna shadow adversarial assignment remains pending proactive completion.

### Model-directed MDN QA found real shadow-input failures

- Interactive packed public-MCP task (not a scripted workflow) failed to search MDN:
  returned Search ref rejected target_moved; default screenshot exceeded64KiB;
  clipped capture-bound click opened search; returned combobox fill then failed
  stale_target after focus acknowledgement. Nine calls/4,708 text tokens, two images;
  no wait_for or sleeps. `astra-model-v48.json/.md` retains exact evidence and limits.
- Root cause reproduced in actual Chrome fixture: verifyHit used document-level
  elementFromPoint (retargets to shadow host), and fieldInspection used document
  activeElement (also retargets to host). Hit verification now checks every containing
  shadow root; native hit containment follows composed ancestry. Focus inspection
  walks parentNode to the tree root and reads its activeElement. getRootNode()/matches()
  were rejected by CDP side-effect checking; the property-only walk retains that guard.
- Global focused-target discovery now follows authored native shadow-root identities,
  including closed roots, before typing. `astra-shadow-input-repro.log` and
  `...-focus-repro.log` fail before the respective fixes; `...-fixed-e.log` passes actual
  open/closed click,fill and global text effects (816.0184ms). Full suite v27:
  802/804 pass,30,572.9261ms,no skipped tests. One failure was an outdated comparison
  of compressed PNG bytes despite intentional metadata-stripping re-encoding; corrected
  to compare decoded pixels plus mask_not_applicable,focused3/3 pass. The other remains
  the known full-page spatial transition. No all-green suite claim.
- Luna Windows env fix reviewed and independently rerun6/6: preserve case-insensitive
  standard browser-root env lookup for plain objects. Mixed-case Chrome/Edge candidate
  tests pass; explicit executable validation/platform behavior unchanged.
- Luna owns only new shadow-input-adversarial real-browser test and evidence, covering
  nested roots and inner/outer overlays. No polling. Fixed packed live-MDN replay and
  screenshot-size improvements remain to do.
- QA extraction cleanup was denied by automatic approval review (blocked by policy).
  Exact residual path and completed browser/host shutdown are recorded in the model
  QA report. Do not retry using a different deletion mechanism.

### v48 online results and full-page layout diagnostic

- Reviewed Luna's completed v48 evidence: all three scripted online workflows pass,
  27 recorded calls,52,713 output-text tokens,4,801 catalog tokens,three wait_for
  commands,no recovery entries. Artifact hash unchanged; three sessions stopped and
  process closed with empty stderr. Files:luna-packed-probes-v48.json/.log. This is
  scripted QA, not model-run acceptance. Luna is idle.
- QA-only NEWTON_QA_CAPTURE_LAYOUT_READ performs a post-capture readonly DOM layout
  measurement. `astra-full-page-layout-read-b.log` still fails the original spatial
  guard: viewport/clientWidth749→764 and post-capture bodyWidth748. Explicit layout
  access does not restore the old dimensions; this is not merely a stale metric read.
  No production wait, extra capture or weakened check was introduced.
- Corrected the adversarial fixture's first clip to include its password input. Its
  previous320px clip excluded that input but asserted mask_applied. The widened640px
  clip now exercises an actual mask under the new accurate disposition semantics.

### Automatic screenshot default (packed v48)

- Removed the mandatory explicit-zone requirement. Public MCP accepts omitted or
  empty sensitiveZones and still validates every supplied extra target. Discovery
  always runs; incomplete/unstable geometry still refuses output. The catalog now
  explains this and publishes the actual target schema for optional extra masks.
- Zero intersecting masks report mask_not_applicable rather than mask_applied.
  Trusted PNG validation/encoding now also strips ancillary metadata when no regions
  are applied, preserving pixels. No caller-provided selector is needed on ordinary pages.
- `astra-automatic-screenshot-b.log`: 5/5 pass,1356.2079ms. Includes real Chrome
  automatic masking of four field locations with no explicit zones, ordinary-page
  capture with no sensitive fields, zero-region pixel/metadata checks and public MCP
  optional-zone acceptance plus malformed-zone rejection before host invocation.
- Luna native lifecycle follow-up reviewed and independently rerun:10/10 pass,
  141.2574ms; covers multi-route aggregate limits, bounded cancellation synchronization,
  nested renderer projection, clipping, invalid geometry and transform retirement.
  Luna is running the existing three online packed workflows with exact v48 hash;
  only its two assigned evidence outputs may change. No polling.
- `astra-pack-v48.log` passes:327,210 bytes,13 files,SHA256
  `5b0e739969fd0e8ba847a18fd6bc2024453d07cd9fad1d85629ce2b1b001f65a`.
  `astra-automatic-screenshot-adapter-v48.log` passes at2026-09-08T12:25:34.868Z.
  Both borrowed workers request screenshots WITHOUT sensitiveZones, receive masked
  PNG blocks, and pass the existing ownership/input/update/recovery oracles. Both
  tabs remain hidden; the final retained prompt survives shutdown.

### Native sensitive discovery integrated (candidate v47)

- Replaced the open-shadow-only walker with `native-sensitive-regions.ts` native
  DOM search per renderer root. Search/remote-object allocations are released even
  when their responses arrive after cancellation. Limits: 32 aggregate matches,
  16 renderer roots, 256 frame stamps; before/after frame membership is compared.
- Visible candidates are checked in a readonly isolated world using only type,
  autocomplete, geometry and computed visibility. Native border quads include
  closed-shadow and same-process fields. OOPIF quads are clipped to the child
  viewport and projected through ancestor renderer roots. Adapter allowlist includes
  the four required DOM search/geometry methods. Explicit zones remain required.
- Real Chrome production capture verifies four sensitive locations (ordinary,
  closed-shadow, same-process iframe, cross-site iframe) are black, while a neighbor
  stays white. `astra-native-sensitive-integrated.log`: 13 focused tests pass,
  1348.8131ms. Full suite v26: 788/790 pass, 29,151.7511ms, no skips; failures were
  the new-module build inventory (fixed, focused parity passes) and known full-page
  spatial mutation (still open). No all-green current suite claim.
- v47 packed artifact: 327,097 bytes, SHA256
  `fcf481551493431eac1d2ae11af0c4522207a1a3998ecfbf9c6421cbdcbb333d`.
  `astra-pack-v47.log` passes. Packed extension screenshot QA passes in
  `astra-native-sensitive-adapter-v47d.log` at 2026-09-08T12:19:28.698Z: both workers
  return PNG image blocks with mask_applied metadata, all prior input/ownership /
  update/recovery oracles still pass, both tabs stay hidden and the retained prompt
  survives shutdown. Pixel location proof is the separate real owned-Chrome test.
  New fixtures exposed harness assumptions about first-textbox selection and first
  MCP block being text; fixed to exact Draft and typed image/text block parsing.
- The first worker's retained modal then suspended the second worker's capture.
  v47c trace ends with an unanswered Page.captureScreenshot until the command
  deadline; no image returned. Retained-modal preservation QA now runs at the end,
  after both captures. Cross-worker modal feedback remains a separate open issue;
  changing fixture order does not fix or close it.
- Luna's expanded schema corpus: 503 cases (55 valid/448 invalid), zero factored /
  expanded mismatches; five permanent tests independently rerun and pass. Native
  lifecycle tests reviewed and rerun 5/5; assigned stronger multi-route aggregate,
  clipping/transform and bounded test synchronization coverage on the same two files.
- Remaining masking work includes same-process frame clipping, real transformed /
  zoomed / nested frame QA, independent lifecycle follow-up, and full-page capture.

### Frame-sensitive mask coordinate foundation

- Extended native search fixture with same-process and cross-site iframes. Root
  search sees ordinary, closed-shadow and same-process child fields, but not the
  cross-process child. DOM.getBoxModel maps same-process child geometry into root
  coordinates; cross-process child geometry remains local to its own CDP route.
- Added `frame-mask-geometry.ts` projective quad mapping for a child viewport into
  the iframe content quad. Handles translation, rotation, scale and perspective;
  rejects nonfinite/degenerate/concave or horizon-crossing geometry. Use child
  innerWidth/innerHeight (including scrollbar space), not transformed owner lengths.
- Four focused tests pass in `astra-frame-mask-projection.log` (1273.7919ms): pure
  transforms with an independently specified perspective equation, malformed
  geometry refusal, and real Chrome closed-shadow/same-process/OOPIF search plus
  exact cross-process placement. Production screenshot integration and clipping
  are still outstanding; this foundation is not yet a complete masking path.
- Luna's first catalog validation was reviewed; requested broader real-validator
  coverage of every action alias and generated malformed commands on the same two
  assigned test/evidence paths. No worker polling or additional worker introduced.

### Closed-shadow sensitive geometry feasibility verified

- Added real Chrome regression `sensitive-shadow-discovery.test.mjs`: native
  DOM.performSearch finds both an ordinary password input and an OTP input inside
  a closed shadow root. DOM.resolveNode plus geometry-only readonly callFunctionOn
  returns the expected rectangles; no field values or text are requested.
- First attempt failed because DOM.getSearchResults yielded unusable frontend IDs
  before document initialization. Explicit DOM.getDocument depth:0 fixes this;
  `astra-sensitive-shadow-search-b.log` passes (742.0565ms total), both boxes at
  exact fixture coordinates (20,30) and (150,90), size 88×26. Search results and
  remote objects are explicitly released, owned browser/identity cleaned up.
- This is feasibility evidence, not production closed-shadow masking. Production
  still uses the bounded open-shadow walker. Before integration, establish frame
  ownership/coordinate mapping, count/deadline limits and adapter method support.
  Do not replace missing geometry with guessed rectangles or return unmasked output.

### Catalog factoring candidate — no references required

- `command-json-schema.ts` now validates repeated target and waitFor constraints at
  the enclosing action object and sequence item object. Variant declarations retain
  empty property schemas so each additionalProperties:false allowlist still applies.
  Kind discrimination, required fields and press-specific anyOf remain unchanged.
- Source ENGINE_COMMAND_SCHEMA: 29,731 → 11,539 serialized bytes. Source tools/list
  response: 37,410 → 19,218 bytes; catalog o200k_base tokens: 9,293 → 4,633 (50.1%
  reduction). Same 13 tools. These are source measurements, not a newly packed run.
- Driver/core build and seven command-foundation tests pass. Luna owns only
  packages/core/test/command-schema-factoring.test.mjs and its evidence report for
  independent real-validator/adversarial equivalence QA, with proactive completion.
  No worker polling. Review and packed verification remain pending.
- This uses sibling properties plus oneOf already used by the schema; no $ref,
  client negotiation, runtime dependency or command-parser change was introduced.

### Full-page alternatives tested and rejected

- QA-only captureBeyondViewport=false override produced a tall PNG with blank bottom
  pixels. `astra-full-page-without-beyond.log` passed the old size-only check, but the
  stronger `astra-full-page-bottom-marker.log` fails: expected RGB (11,133,217) at
  document (25,1925), got white. The fixture now checks actual offscreen content.
- Requiring original geometry to return within a bounded render-transition window also
  failed (`astra-full-page-restoration.log`, `...-b.log`); an additional ordinary viewport
  capture did not restore it (`astra-full-page-restoration-frame.log`). Removed these
  ineffective production waits/capture attempts; strict immediate rejection remains.
- The QA-only NEWTON_QA_CAPTURE_WITHOUT_BEYOND switch is confined to the regression
  transport wrapper for reproducing the rejected alternative. Production is unchanged
  by that experiment. Full-page correctness is still open; no fake full-height image
  or weakened mask checks are accepted. Other implementation work can continue.

### Full-page failure cause narrowed; consistency review complete

- `astra-full-page-clip-diagnostic.log` proves the request matches measured content:
  clip 749×2121 at (0,0), then viewport/content width becomes 764 after capture.
  This is not an oversized requested clip causing the mismatch.
- Chromium's current primary source confirms captureBeyondViewport sets hide_scrollbars
  and record_whole_document, with temporary emulation handling:
  https://chromium.googlesource.com/chromium/src/+/refs/heads/main/content/browser/devtools/protocol/page_handler.cc
  This explains the observed 15px width transition. Do not add page styles, emulation
  switches or freeze instrumentation to conceal it. A verified capture strategy remains
  needed; no broader full-page guarantee has been established.
- Luna consistency tests reviewed and independently rerun: 4/4 pass, 162.9587 ms.
  They prove discovered-region pixels, incomplete-scan refusal before capture, and
  no output/capture registration on changed mask or viewport geometry using fake CDP.
  Luna is idle. The live full-page regression remains intentionally failing; source
  is not ready for release and packed artifact remains v46.

### Screenshot consistency check exposes full-page layout transition

- Screenshot regions are collected before and after capture; spatial state is also
  re-read. Changed geometry rejects with stale_target before image publication or
  capture registration. No page mutation, freeze or timeout increase was added.
- This revealed a material limitation of the prior full-page success claim:
  `astra-full-page-spatial-transition.log` records Chrome width changing 749→764 during
  captureBeyondViewport while height=485 and scrollY=400 stay fixed. The new consistency
  check correctly rejects that full-page capture; earlier raster-height evidence did
  not prove mask geometry remained valid. Full-page capture is OPEN pending a verified
  strategy. Do not relax the geometry check merely to restore the old green test.
- `astra-mask-consistency-source.log` retains the integrated failure. Main predicate
  and mask pixel tests passed in that run, but real full-page regression fails as above.
  Build/typecheck pass. Current source is not a passing release candidate.
- Luna owns ONLY `packages/driver/test/screenshot-mask-consistency.test.mjs` and
  `test/evidence/luna-screenshot-mask-consistency.md` for positive discovered-region
  pixels and incomplete/changing geometry refusal tests. Proactive completion required.
  Root owns full-page/native geometry investigation. Packed artifact remains v46.

### Main-document automatic mask discovery — incomplete feature

- Screenshot now supplements explicit regions with geometry-only detection of password
  and sensitive autocomplete elements in the main document and open shadow trees.
  Traversal reads attributes/rects only; it never reads field values, text or storage.
  Work is bounded to 10000 elements/32 regions; incomplete scans refuse capture.
  Duplicate exact regions are merged before the existing raster mask operation.
- The explicit sensitiveZones requirement remains because cross-frame/closed-shadow
  discovery and geometry-churn guarantees are not yet complete. This is a foundation,
  not a claim that screenshots are safe without operator-supplied zones.
- `astra-mask-discovery-root.log`: predicate access-trap/overflow tests and real Chrome
  screenshot regression pass 3/3, 1895.7207 ms. Build/typecheck pass. Existing pixel
  tests now supply an empty discovery response through fake CDP and still pass 3/3.
  Packed artifact remains v46; all screenshot changes since then need packed QA.

### Mask pixel review

- Luna's `scrolled-mask-geometry.test.mjs` reviewed and independently rerun against
  current source: 3/3 pass, 160.7194 ms. Tests exercise actual screenshot orchestration,
  spatial metrics, PNG masking and decoded pixels for supplied fake browser geometry;
  default scrolled clip, explicit document clip and entirely outside regions are covered.
  Unmasked pixels remain unchanged. These are not native zoom/frame geometry proofs.
- Current typecheck passes, including shared raster-limit refactor. Luna is idle.
  Full-page and scroll fixes still need packed verification; automatic discovery,
  cross-frame masking and broader zoom/churn handling remain unfinished.

### Full-page screenshot extent — source candidate

- Preserved `astra-full-page-repro.log`: fullPage at scrollY=400 still used a viewport
  clip starting at y=400. FullPage without an explicit clip now measures cssContentSize
  (legacy fallback where needed) and captures that extent. An explicit clip retains its
  requested extent. Capture records preserve captureBeyondViewport for revalidation.
- Raster work is checked against the same exported MAX_RASTER_PIXELS limit used by the
  PNG decoder before browser capture, accounting for device scale. Larger requests fail
  with output_budget rather than producing an image Newton cannot process.
- `astra-full-page-fixed.log` passes the real Chrome regression: origin and extent are
  correct and the actual PNG header height exceeds 2000 pixels. Scrolled fresh-click and
  stale-capture checks also pass. Build/typecheck pass before the final shared-constant
  refactor. Current packed artifact is still v46; this work is not yet packed-verified.
- Luna's scrolled-mask pixel test assignment remains active; automatic masking is still
  unimplemented and should follow pixel/geometry verification, not bypass it.

### Fresh scrolled screenshot coordinate fix — newer than v46

- `astra-scrolled-capture-repro.log` reproduces fresh screenshot after scrollY=400
  reporting clip.y=0. Default clips now start at visual viewport document coordinates;
  masks convert viewport-relative boxes to document coordinates and click_at converts
  capture coordinates back to viewport input coordinates. CSS viewport metrics are
  preferred, and off-viewport input is rejected instead of dispatching outside view.
- Expanded real-browser regression verifies fresh clip.y=400, clicks the visible button
  from its fresh capture, and checks the actual fixture click effect; intervening scroll
  and visible layout changes still reject stale captures. First fixed run was blocked
  by the fixture's deliberate click-covering overlay, retained from an earlier assertion;
  the test now removes it after the covered-target check and before fresh capture.
  `astra-scrolled-capture-fixed-b.log` passes, 1774.5023 ms total; build/typecheck pass.
- Pixel-level mask placement still needs independent verification. Luna owns ONLY
  `packages/driver/test/scrolled-mask-geometry.test.mjs` and
  `test/evidence/luna-scrolled-mask-geometry.md` for that test. Proactive report required.
  Automatic mask discovery is not implemented; fullPage/zoom/frame masking remain open.
  Packed artifact remains v46 and does not contain this source change.

### Integrated scoped-control review

- Reviewed Luna's scoped-control tests. Its named nested frame was originally a sibling;
  corrected the fixture parent to `inside`, then independently reran 2/2 tests successfully
  (167.9672 ms). These use real projection/directory/ref resolution, with fake CDP and
  membership, and assert the scoped root avoids broad role queries.
- Full source suite `astra-suite-v25.log`: 772/772 pass, 30689.1064 ms, no failures,
  cancellations, skips or todos. Production remains packed v46. Luna is idle.
- Screenshot audit begun: automatic mask discovery remains absent; explicit zones are
  still required. Before changing that API, verify CSS document versus viewport clip,
  mask and click coordinate handling after scrolling/zoom. Existing adversarial screenshot
  tests verify rejection after intervening scroll/layout change, but do not prove a fresh
  capture taken while already scrolled masks/clicks the correct coordinates. No screenshot
  production changes or confirmed geometry defect claim yet.

### Scoped control frames v46

- Scoped controls now include owned descendant frames whose owners belong inside the
  requested node, using the tested containment/exclusion predicate. Each child gets its
  own full-frame AX root; the original scope backend ID applies only in its own frame.
  Membership work is bounded to 16 descendants/passes with explicit incompleteness.
- Preserved `astra-native-scoped-controls-v45.log` and `...-v45b.log`: observation
  timed out. Trace ends with scoped queryAXTree searchbox/textbox replies and an
  unanswered combobox query. The original harness masked it with nodes.find on undefined;
  v45b preserves the engine's unavailable/timed_out result. No timeout was widened.
- Scoped AX reads now use existing bounded child expansion and do not issue broad
  queryAXTree role searches; unscoped high-value-field prioritization remains.
  Five AX snapshot regressions pass, 123.2342 ms; typecheck passes.
- V46: 321209 bytes, SHA256
  `520d0609cb5475e89459578c88f911de5f5e14973feb64294fca51b648d81356`.
  Pack check and `astra-native-scoped-controls-v46.log` pass at
  2026-09-08T11:30:15.505Z. Both workers fill the included cross-site field by its
  scoped observation ref, and the outside sibling field is absent. Prior document,
  native input, popup, modal and update/recovery checks also pass.
- Luna is actively writing ONLY `packages/driver/test/scoped-control-frames.test.mjs`
  and `test/evidence/luna-scoped-control-frames.md` for independent projection/route
  regressions; wait for its proactive message, never poll. Full-suite verification
  must follow review. Current ordinary online evidence remains v44.

### Heading hierarchy and current online evidence v44

- Document text preserves native H1–H6 and valid semantic heading levels with Markdown
  prefixes. Semantic headings without aria-level use level 2; invalid/out-of-range levels
  do not invent hierarchy. Prefixes share the existing character budget. VM regression
  plus live document regressions pass 11/11, 2642.9063 ms; build/typecheck pass.
- V44: 320853 bytes, SHA256
  `6714380a60734f7c024284b26fa7036ac2e47b039101ae722619e029e0e0161f`.
  Pack check passes. `astra-packed-probes-v44.json` passes all three everyday public
  tasks in 27 calls, finished 2026-09-08T11:25:34Z. Actual returned snippets contain
  `# Ada Lovelace`, `# HTML`, and `## Table of contents`. Artifact unchanged.
- Current o200k_base output: 52761 text tokens plus 9293 catalog tokens. This is not
  an established reduction from v38: live content and extraction changed, and broad
  repeated feedback remains the main cost issue. V43 remains latest extended native
  extension lifecycle QA; v44 online proof does not replace that separate gate.

### Ordinary document frame traversal v43

- Ordinary document reads now use the same bounded frame traversal as scoped reads.
  Membership follows each document reader's chosen main/article/role-main/body root,
  including hidden-main body fallback. A scoped root uses the exact requested node;
  embedded documents choose their own readable root. Ancestor exclusions remain active.
- Predicate and orchestration tests pass 11/11, 218.2955 ms; driver build/typecheck pass.
  Tests include main-versus-outside containment and hidden-main fallback. Full suite
  767-pass evidence below predates this change; do not present it as current verification.
- V43: 320564 bytes, SHA256
  `9d94f0700facdc3a1c9de54625c0f404f804c45bbbbdd7d19ec4e61cc875d5a0`.
  Pack check and `astra-native-document-frames-v43.log` pass at
  2026-09-08T11:23:32.184Z. Ordinary reads contain both visible sibling frames; scoped
  reads contain only their included frame; both exclude hidden/sensitive ancestors.
  Existing native input/popup/modal/update/recovery checks pass. Luna remains idle.

### Scoped frame verification checkpoint v42

- Current package: 320346 bytes, SHA256
  `9d18b6f7bd23a4a69171db5c4e4bbd0819bfb3f8b3735495adb8c40492b1769d`.
  Pack check passes. `astra-native-frame-exclusions-v42.log` passes at
  2026-09-08T11:20:20.509Z, adding real cross-site iframe exclusions under hidden and
  autocomplete-excluded ancestors to the prior inclusion/sibling/scroll/input/update
  checks. Fixture assertions verify exact known text inclusion and absence.
- Luna's six frame-budget/cursor tests are independently reviewed and rerun: 6/6,
  179.5051 ms. They stub DOM extraction/membership and test orchestration contracts;
  VM predicate tests and packed live checks provide complementary evidence.
- Full suite `astra-suite-v24.log`: 767/767 pass, 29663.0749 ms, zero failures,
  cancellations, skips or todos. Boundary check passes. Luna is idle with no active
  assignment. Current source matches v42 production; newer evidence/tests are unpacked.
- Remaining frame-reader work includes richer nested/live churn coverage, unscoped
  document frame semantics, scoped control descendant behavior, and dynamic membership
  completeness. Broader architecture/model-loop/release gates remain incomplete.

### Frame containment exclusions after v41

- Moved the actual CDP membership predicate into `FRAME_SCOPE_FUNCTION` in the
  document-reader module and applied its excluded tag rules to the iframe's ancestor
  chain (including canvas, template and field subtrees). Prior candidate checked
  visibility/sensitivity but omitted tag exclusions, permitting inconsistent reads.
- Predicate tests execute the actual function in a VM: hidden ancestors, excluded
  tags, autocomplete exclusions, aria-hidden, display/visibility, unrelated owner
  short-circuit, and excessive ancestry returning uncertainty. Combined predicate and
  traversal run passes 3/3, 183.0216 ms. Build/typecheck pass. A first test-only failure
  came from object spread invoking a fixture getter at construction; corrected using
  Object.defineProperty, retaining the access-trap assertion.
- This source is newer than packed v41. Hidden/excluded live frame cases and Luna's
  separate work-limit regressions remain outstanding; no new packed acceptance claimed.

### Scoped frame live verification and offscreen scroll regression

- V41: 320519 bytes, SHA256
  `2a6c5be3af76df452557c938e0ea55b3c9d7c9cbe4d90d4e17741116113eaa24`.
  Pack check passes. `astra-native-scoped-frame-v41.log` passes at
  2026-09-08T11:16:33.504Z, including scoped parent text, included cross-site frame
  prose, exclusion of unrelated sibling frame prose, native input and all prior
  popup/modal/update/recovery checks. Stronger hidden/excluded/nested cases remain.
- Preserved v40 failure `astra-native-scoped-frame-v40.log`: expanded fixture pushed
  scroll container below viewport and scroll rejected before wheel input. Scroll now
  prepares pointer observations and uses native DOM.scrollIntoViewIfNeeded when the
  target center is outside view, then revalidates before dispatching one wheel.
  The unchanged larger fixture passes v41 with trusted wheel and 100px offset oracles.
  `offscreen-container-scroll.test.mjs` deterministically verifies reveal-before-wheel
  order and offset postcondition; typecheck passes.
- Luna catalog analysis received and read; factoring savings are source measurements,
  client compatibility is unverified. No catalog mutation made. Luna now owns ONLY
  `packages/driver/test/scoped-document-frame-limits.test.mjs` and
  `test/evidence/luna-scoped-document-frame-limits.md` for adversarial work-limit and
  continuation tests. Completion must arrive proactively; do not poll.

### Scoped document frame traversal — candidate, live QA pending

- New source work after v39: scoped document reads follow controlled descendant frame
  relationships, check iframe owner containment and visibility through read-only CDP,
  append labeled embedded text, and share remaining character/node work budgets.
  Traversal is bounded to 16 included frames/passes. Snapshot continuations validate
  participating frame generations as well as the selected document generation.
- `scoped-document-frames.test.mjs` verifies traversal orchestration excluding an outside
  sibling, inclusion of a nested frame, and continuation expiry after child navigation.
  It stubs containment and DOM extraction; it does not prove the browser membership
  predicate. Combined document tests pass 8/8, 185.5486 ms; driver build/typecheck pass.
- Next: adversarial containment/exclusion/work-limit tests and packed same/cross-origin
  live scoped reading with independent content oracles. Review depth/frame limits,
  dynamic attachment membership and field-exclusion inheritance before acceptance.
  Unscoped extraction and scoped control observation still need separate frame coverage.
  Current packed artifact remains v39 and does not contain this candidate source work.

### Packed focused text feedback verification

- V39 packed candidate: 318240 bytes, SHA256
  `d435111af76f5f99845051a9b80d89293ca8c39a4e6068ad019b93442100f115`.
  `astra-pack-v39.log` passes; `astra-native-text-feedback-v39.log` passes at
  2026-09-08T11:10:33.239Z. Both worker processes use global text-only press after
  filling their explicitly created browser tab. The actual receipt must contain one
  target-scoped field with its updated value. An independent post-release DOM oracle
  verifies each exact final `created-by-ID-typed` value.
- Expanded iframe/popup/modal/update/rollback/wrong-profile/crashed-updater checks also
  pass. No source edits were made during packing or this run. This is packed fixture
  evidence for text-feedback correctness, not an aggregate token reduction benchmark.
  Everyday online token baseline remains v38; full release acceptance is outstanding.

### Current packed online workflows

- Source follow-up after v38: text-only press now selects existing field-local feedback,
  consistent with type/fill, while chords retain broad feedback. One focused selection
  test passes; driver build and typecheck pass. This does not by itself fix broad click/
  hover/wait feedback or eliminate the online harness's redundant observations. No
  token reduction is claimed until the next packed comparison. Luna's catalog analysis
  remains pending and must arrive proactively; do not poll its task.

- Token baseline added to the QA harness using the existing development tokenizer:
  counts full returned text blocks before evidence clipping, separately counts serialized
  tools/list catalog, and labels o200k_base plus excluded prompts/images/reasoning.
  `astra-packed-probes-v38-cost.json` reruns all three workflows successfully against
  the exact expected v38 hash: 27 calls, 53019 output text tokens, 9293 catalog tokens.
  This is an encoding-based output measurement, not billed usage or a model benchmark.
  Several action/observation responses each cost roughly 3700–3800 tokens; repeated
  broad post-action controls and explicit subsequent observations need focused review.
- Luna has an active read-only catalog redundancy assignment, writing only
  `test/evidence/luna-catalog-cost-analysis.md`. It must report proactively. Parent
  owns action-feedback architecture and must review compatibility before schema changes.

- `astra-packed-probes-v38.json` records three successful everyday public-site
  workflows against v38 SHA256
  `15d069c3502f1731d57e9f5f89bf6ab6d467ecaebfad63471de1ec605172af14`:
  Wikipedia search/open/read (4140 ms), GitHub issue filter/read (3758 ms), and W3C
  documentation continuations (2342 ms). Completed 2026-09-08T11:05:07.672Z.
- 27 calls, 257135 total response bytes including catalog, two explicit wait actions,
  10487 ms total. Artifact hashes match before/after; MCP cleanup reports closed.
  These are scripted workflows, not model tool-turn/token benchmarks or authenticated
  task acceptance. Raw wire bytes are not token counts. Current feedback cost still
  warrants model-run evaluation and reduction where it does not omit needed evidence.
- Invocation mistakenly supplied --evidence rather than --output; the harness ignored
  it and replaced its default untracked `luna-packed-probes.json`. The resulting current
  evidence was copied intact to the versioned path above; earlier versioned evidence
  remains separate. The harness now rejects unknown arguments before any filesystem
  or browser work, preventing this silent fallback. No historical default-file
  contents were reconstructed or claimed preserved.

### Pending command retirement on browser detach

- V38 packed candidate: 318217 bytes, SHA256
  `15d069c3502f1731d57e9f5f89bf6ab6d467ecaebfad63471de1ec605172af14`.
  `astra-pack-v38.log` passes. `astra-native-frame-v38.log` passes at
  2026-09-08T11:03:34.039Z with the expanded fixture: both packed workers fill
  a cross-site localhost iframe served from the 127.0.0.1 parent fixture's server,
  remove that frame through native parent input, then continue popup input and the
  existing lifecycle/update/recovery suite. The script asserts frame fill and removal
  postconditions, though the log's human-readable checks array retains its older labels.
  This is basic live frame lifecycle evidence, not an in-flight-detach stress test or
  everyday online acceptance. Stronger independent frame-effect oracles remain needed.
- Luna's connection-layer capacity change is complete and reviewed: only new routes
  count against capacity; cross-tab collision still closes the connection. Parent reran
  its three tests plus the four page-family tests: 7/7 pass, 117.6292 ms. No worker
  assignment is currently outstanding. The full suite result below predates these
  three additional tests; pack check and expanded Chrome QA cover their integrated code.

- Integrated route-retirement source suite `astra-suite-v23.log` passes 753/753,
  30557.069 ms, zero failures/cancellations/skips/todos. Adapter route capacity now
  permits duplicate attachment metadata for an existing route; actual overflow
  quarantines the claim and promptly rejects pending work instead of leaving it hung.
  A deterministic capacity regression also verifies disconnect releases quarantine.
- Luna has a bounded active assignment for the analogous connection-layer duplicate
  capacity check. Its only write paths are `apps/mcp-server/src/existing-page-family.ts`,
  `test/existing-page-family-route-capacity.test.mjs`, and
  `test/evidence/luna-family-route-capacity.md`. Completion must be proactively reported;
  no polling or other workers. Review this candidate before packing the next build.

- Follow-up source change: frame detach now retires commands and held inputs belonging
  to that route only. Attachment identity fences acknowledgements already fulfilled
  before a detach/reattach. `tab-route-retirement.test.mjs` adds two deterministic cases;
  combined with Luna's tab-detach cases, 7/7 pass and typecheck passes. This change is
  newer than v37 and the 750-test full-suite result below. Packed iframe churn evidence
  remains outstanding; no broad lifecycle completion claim is made.

- Confirmed manual detach now immediately retires pending commands and releases the
  old claim. Late debugger acknowledgements cannot report success for a released claim
  or affect a replacement generation. Owned release uses confirmed debugger detach as
  its barrier; uncertain cleanup rejects pending commands and retains quarantine.
- Luna independently added five adversarial tests and found a synchronous throw in
  the fallback detach path escaping normalization. Astra reviewed and fixed that path
  by invoking the fallback inside the caught promise chain. No timeout was increased.
- `astra-suite-v22.log`: 750/750 pass, 31315.2118 ms, zero failures/cancellations/skips/
  todos. Typecheck and boundary checks pass. Tests include the retained Luna repro.
- V37 packed verification and Chrome lifecycle/update QA passed before the final
  synchronous fallback normalization: 318084 bytes, SHA256
  `2ce8809bb86272467f4541f1d563e38671604ca9576ff59b9ec4ef891f374e3a`;
  `astra-native-detach-v37.log` passed 2026-09-08T10:53:16.326Z. This is fixture QA,
  not everyday online acceptance. Current source includes the additional normalization
  fix and therefore needs a new packed candidate before release claims.
- Still outstanding: live frame-route retirement verification, explicit popup attachment
  failure feedback, remaining architecture work and current-artifact everyday online QA.
  The three unchanged full packed release passes have not been completed.

### Popup action feedback

- Frozen v36: 317966 bytes, SHA256
  `91ac855b3326ebe360356238c4ec6697a2cc67c529959e42ac2683b1dc61cd5c`.
  Pack check passes. `astra-native-popup-feedback-v36.log` passes at
  2026-09-08T10:48:08.001Z, including direct popup follow-up from action feedback,
  independent popup/new-tab effects and all existing update/recovery checks.
- Luna's four projection tests are reviewed and independently rerun (301.9633 ms).
  They prove unchanged-page exclusion, bounded metadata, exact escaped-byte fitting
  through the shared budget predicate, flag distinctions and pending-attachment
  cancellation. They stub the local reader and seed the baseline; packed live tests
  supply actual input/baseline evidence. Full suite `astra-suite-v21.log` passes
  743/743 tests, 29927.9328 ms, no failures/cancellations/skips/todos. Typecheck and
  boundary check pass. No QA process remains running.
- Action feedback records page identities at the first input step and includes newly
  observed owned pages as `observation.newPages`, with pageId/opener/selection and
  bounded title/URL. One sequence retains one baseline; existing pages are not repeated.
  Known attachment work uses the command's existing deadline. Selection is unchanged.
- Candidate feedback shares the exact receipt serializer budget. At most eight entries
  are included; long metadata/candidate overflow sets newPagesIncomplete. Local controls
  may be omitted to preserve page identities, making the observation incomplete without
  falsely claiming more popup candidates exist. No second browser read is added.
- V35 package/live proof: `astra-native-popup-direct-v35.log` passes at
  2026-09-08T10:46:48.219Z. The worker edits the child using the preceding receipt before
  any pages.list call; the later listing is a QA ownership/selection cross-check. Both
  child values are independently checked after release. Full earlier lifecycle/update
  checks also pass. V35 SHA256
  `ebb2a7b057f1a218e205a792e828f56b0c4e2080828945b5991fe3f61c8b393c`, 317916 bytes.
- Source after v35 distinguishes popup truncation from omitted local controls and fixes
  inventory falsely showing a failed created tab as available while its removal is
  pending. `tab-create-cleanup.test.mjs` deterministically holds removal and proves
  inventory/claim exclusion agree until settlement. V36 validation passes above.
- Luna's assignment is complete; worker is idle. Next work remains attachment-failure
  reporting, broader page/frame/modal lifecycle cases, platform/artifact separation,
  legacy retirement and actual everyday online/model-loop acceptance.

### Explicit new tab in the selected browser

- `browser.session.start` now accepts existing target `{kind:'new_tab',instanceId,url}`
  and optional connectionId (required to disambiguate multiple connections). Invalid
  URLs/conflicting fields fail before connecting. Owned mode remains the default.
- Native create_tab capability creates only inactive about:blank; TabClaims reserves
  capacity before creation yields, attaches ownership, and the shared PageExecutor
  then navigates to the normalized URL. No website scripts, foregrounding or alternate
  navigation engine are used. Failed attachment removes only that request's new tab;
  foreign intervening claims are preserved. Disconnect/quiesce await pending creation
  cleanup under the existing reconciliation bound, preventing late ownership.
- Parent tests prove validation and attachment-before-navigation. Five independent
  Luna claims tests were reviewed and rerun: all pass (107.0375 ms), covering normal
  creation, attach failure, disconnect/quiesce, concurrent capacity and foreign claims.
- Frozen v34: 317084 bytes, SHA256
  `88c51f8851801a754f1fb5d59f5283a1faae5587c4fcace298577dd3a52ddb1f`.
  `astra-pack-v34.log` passes. `astra-native-new-tab-v34.log` passes at
  2026-09-08T10:40:12.117Z with two workers creating/editing their own tabs through MCP,
  foreign claim refusal and independent post-release values. Popup ownership and the
  existing update/rollback/wrong-profile/process-kill recovery checks also pass.
- Current full suite `astra-suite-v20.log`: 738/738 pass, 29162.0551 ms, no failures,
  cancellations, skips or todos. Typecheck and boundary check pass. Luna's assignment
  is complete; worker is idle. No QA process remains running.
  Next remaining work includes popup receipt feedback, attachment-failure reporting,
  broader lifecycle/online acceptance and the platform/artifact/legacy retirement gaps.

### Borrowed popup ownership

- Current full source suite: `astra-suite-v19.log`, 731/731 passed, 29743.9784 ms,
  no failures/cancellations/skips/todos. Typecheck and boundary check pass. No QA
  process remains running; Luna work is complete and the single worker is idle.
- Current frozen v33: 316279 bytes, SHA256
  `5de7de18460ad1d74824a3737c74c182c6c06f4c367f0d34d3e3feddb4005871`.
  Pack check passes. `astra-native-popup-v33.log` passes at
  2026-09-08T10:33:49.202Z, including independent browser-side popup values after
  worker release (`child-of-1360084053`, `child-of-1360084054`), parent selection,
  cross-owner refusal, and the full existing update/rollback/process-kill recovery flow.
- Latest source additionally fixes pages.list returning before a known popup attachment
  completes. Live v32b showed Page.enable in flight and claimed=true while the list omitted
  the child. PageExecutor.pages drains known attachment promises; host/MCP await it.
  Two deterministic gated regressions pass, including closure during attachment. V33
  package/live validation passes above. Earlier full suite v18 passed 729 tests before
  this specific fix; do not attribute it to the new async listing yet.
- Expanded independent oracle originally ran before the intentionally retained parent
  modal was dismissed and stalled. The exact owned browser was terminated and normal
  cleanup ran; temp root o4bAEU is absent. Oracle reads now occur after the modal test
  dismisses it and use bounded read calls. V32b then exposed the distinct listing race.
- Added browser-attributed popup inheritance to TabClaims and a shared native owner
  page-family connection. Child pages carry their own claim tokens; recursive frame
  routes map to the correct claim. Foreign/stale opener events are ignored, child
  closure removes routes, initial events are buffered until the engine subscribes,
  and stop releases the family's claims without closing the operator's tabs/browser.
- EngineConnection exposes scoped owned-page events separately from ownsBrowser.
  PageExecutor consumes them through its existing page attachment path. Borrowed
  connections still cannot issue browser-wide target discovery/attachment commands.
- Live v31 exposed wrong opener attribution: `chrome.tabs` listed the active setup tab
  as the popup opener while CDP identified the actual background parent. Use
  `webNavigation.onCreatedNavigationTarget.sourceTabId` instead. The initial extension
  manifest therefore includes `webNavigation`; worker-only updates never change an
  installed manifest or permissions. Existing pre-release candidate manifests lacking
  that permission need a new explicitly prepared candidate installation.
- Frozen v32: 316197 bytes, SHA256
  `7bfc9c82cd527c71b5f976c44efaeb2008fa4a6b3998b00e3114ca6b343b8ba5`.
  `astra-pack-v32.log` passes. `astra-native-popup-v32.log` passes at
  2026-09-08T10:26:49.171Z: two workers each open/list/edit their own popup; another
  connection cannot claim it; update/rollback/kill-recovery checks also pass. Expanded
  independent popup effect oracle and the full suite are running separately.
- Focused tests: 3 parent claim tests, 4 independently reviewed Luna claim tests,
  4 independently reviewed page-family tests, plus actual bundled worker response
  regression pass. Luna assignments are complete; currently idle.
- Explicit new-tab creation is implemented above. Still required: popup receipt/candidate feedback, delayed and
  unattachable popup reporting, child closure/human detach integration, recursive popup
  and OOPIF live coverage, and everyday online task acceptance. This is not P11 complete.

### Installation update ownership and durable journal

- Actual updater-process interruption now passes with unchanged packed v30:
  `astra-native-kill-v30.log`, 2026-09-08T10:14:10.824Z. A disposable child executes
  the packed transaction to real code publication, signals at its reload boundary,
  then the parent kills that exact process. No updater finally/close runs. Public
  status changes from updating to recovery_required; public original-profile recovery
  verifies the previous code and returns ready. The fixture hook is outside production.
- Luna's CLI edge cases are reviewed and independently rerun: four pass, 225.2131 ms,
  in `adapter-cli-update.test.mjs`. Missing/invalid/duplicate/unknown flags do not mutate
  config; status covers absent installation, held lock and pending journal.
- Current verification: `astra-suite-v17.log` passes 714/714 tests, 31766.743 ms,
  no failures/cancellations/skips/todos. Typecheck and boundary check pass.
  `astra-native-recovery-v30.log` passes at 2026-09-08T10:12:03.406Z: forced double
  bootstrap failure retains a recovery-required journal; public recovery through a
  second live profile fails without changing it; original-profile public recovery
  restores verified rollback and ready status. This used the unchanged v30 package.
- Durable transaction is now composed in `adapter-update-transaction.ts` and wired to
  public `adapter update` / `adapter recover`. CLI status distinguishes held update
  ownership and unfinished journal evidence. Installation metadata accepts only the
  two journaled worker digests during recovery, then returns to strict verification
  after bootstrap/smoke and metadata commit. First public packed Chromium QA passes:
  `astra-native-update-v30.log`, 2026-09-08T10:10:13.637Z. It exercises CLI update,
  valid ready status after metadata commit, real forced rollback, second-profile
  marker rejection and public already-committed recovery. The later interrupted
  recovery check above also passes; this is still not full release acceptance.
- Frozen v30: 313945 bytes, SHA256
  `83fe0b2645a73ba59e0b184199f426cf313c76197e5654eb27ac1eb3e8590c7e`.
  `astra-pack-v30.log` passes deterministic packaging and install checks. V29 was
  superseded after the journal-open failure cleanup fix; use v30 for current evidence.
- Independent transaction tests: seven pass (688.0225 ms on parent rerun), covering
  success, wrong-digest rollback, double failure then recovery, pending-update exclusion,
  committed recovery without replay, prior-marker cleanup failure preserving the ticket,
  and unknown worker rejection. Journal adversarial tests: five independently rerun pass.
- Marker cleanup is now idempotent only when no marker remains. Foreign or ambiguous
  markers still fail. New updates clean a previous committed marker before replacing
  its journal ticket. Recovery after publication requires existing marker proof;
  prepared recovery may initialize a marker because no code publication has begun.
- Current source checks: `astra-suite-v16.log` passes 702/702 tests, no failures,
  cancellations, skips or todos, 29093.0524 ms. Typecheck and boundary check pass.
- New `installation-lock.ts` reserves a private kernel IPC name derived from the
  canonical installation directory. Windows named pipes and Linux abstract sockets
  carry no messages and expose no TCP listener. Process exit releases ownership;
  unrelated installations remain concurrent. Windows crash/reacquisition, aliases,
  invalid roots and unrelated-client behavior pass deterministic tests. Linux is
  implemented but not yet exercised on Linux.
- New `adapter-update-journal.ts` retains one bounded atomic record containing the
  update ticket, installation identity, both code snapshots/digests, publication
  phase and verified bootstrap epoch. It serializes writes, drains them before
  releasing ownership, rejects invalid transitions/corrupt snapshots, and retains
  unfinished recovery evidence. File data is fsynced; POSIX also fsyncs the directory
  after rename. Windows power-loss durability has not been demonstrated.
- Next address remaining installation/platform/artifact gaps and browser-control gaps,
  including borrowed new-tab/popup ownership, then extend everyday online acceptance.
  Borrowed popup integration is recorded above; explicit new-tab creation and the
  remaining page lifecycle/feedback cases still need implementation and acceptance.
- Luna's journal, transaction and CLI assignments are complete. It is currently idle.
  Require proactive completion on future bounded assignments; do not wait or poll.

### Native setup race follow-up (09:44 UTC)

- Final frozen v28 package: 304261 bytes, SHA256
  `45138d3057f5b39c4ca55d5d2842cf6fb7bde354c71edb16fbc3b20ab580c7ec`.
  `astra-pack-v28.log` passes. `astra-native-headed-v28.log` passes at 09:46:24 UTC
  with concurrent setup, unchanged runtime inode/mtime/ctime, default-host native
  actions, two live profiles, update and forced rollback. This does not close the
  earlier intermittent hover timeout. Worker ownership is recorded above.

- Full source suite `astra-suite-v15.log`: 691/691 passed, 29221.4051 ms, no failures,
  cancellations, skips or todos. This includes actual-launcher validation and native
  diagnostic metadata tests; it does not close the separate live hover timeout below.
- V25 concurrent repeated setup found native_file_changed. Direct Windows evidence in
  `astra-native-acl-proof.json` proves applying inherited ACLs changes child ctime while
  bytes and mtime stay identical. ACLs now apply to the unpublished native root stage,
  before ownership publication; repeated setup does not mutate inherited file metadata.
  The live verifier additionally requires unchanged runtime ctime after repeat setup.
- Launcher now bounds JSON/entry/runtime reads and rejects symlinked/noncanonical build
  directories before spawning. Tests execute the actual launcher source with inert files
  and a capture-only spawn, proving pinned runtime/environment, tamper/oversize rejection,
  and symlink rejection. No fixture executable is run.
- V26 completed setup but failed hover before dispatch at its existing 2500 ms action
  deadline. This is OPEN, not explained by the ACL fix. Do not call it a closed flake or
  increase the deadline. `astra-native-concurrent-v26.log` contains the failed receipt.
- A local opt-in Node diagnostics channel now records native request correlation,
  method names, phases and time only, never arguments/results/tokens. The QA client
  retains a bounded trace on failure. Its metadata-only contract is tested. V27 passed
  headless adapter/setup/update QA, but did not reproduce or explain the prior hover
  timeout. Source after v27 adds per-connection trace IDs to disambiguate simultaneous
  clients. Retain the unresolved case for targeted tracing and release acceptance.

### Immutable native setup checkpoint (09:34 UTC; supersedes older checkpoints)

- Native runtime builds now seal both host entry and copied Node bytes. Repeated setup
  verifies and reuses an existing complete build without touching executable bytes,
  inode or mtime. A changed host entry creates a separate build; an updated source Node
  does not silently mutate the existing verified runtime. Partial/unsealed/tampered
  directories are rejected rather than overwritten. Legacy unsealed migration remains
  a recovery concern, not a claim of automatic repair.
- Launchers are immutable, keyed by launcher source digest, published with their binary
  verification record as one complete directory. The native manifest points into the
  installed launchers directory; there is no repository/package-cache path dependency.
  Launcher startup verifies the host entry and runtime digest with bounded hashing.
- The native root is published with an extension-ID ownership record before setup
  proceeds. Foreign roots/symlinks are refused. Runtime, launcher, and owner publication
  stage under validated parents; only exact owned stage members are removed.
- Concurrent native setup exposed Windows EPERM while publishing the same launcher
  pointer (`astra-native-concurrent-v23.log`). Publication now skips identical state
  and treats a rename collision as success only if the complete desired JSON is already
  present. A different effect remains an error. No sleep or wider timeout was added.
  Three deterministic tests cover same/different concurrent effects and no rewrite.
  The QA harness now settles both setup subprocesses before cleanup on failure.
- V24: 303603 bytes, SHA256
  `1b1154470f5e2c86305278cf0f83931c29f1cef9fca8dacf65cd42301cab4222`.
  Pack passes; headless `astra-native-concurrent-v24.log` passes at 09:32:23 UTC with
  two simultaneous initial setups, two repeated setups while the native host is live,
  immutable runtime facts, default-host input and two-profile update/rollback. The final
  source additionally fsyncs staged JSON before rename; that refinement is not in v24.
- Luna's seven inert-file runtime tests were independently rerun successfully; three
  publication tests pass. Typecheck passes. Full suite is `astra-suite-v14.log`; use its
  completed outcome. No Luna assignment remains active and no worker polling occurred.
- Remaining: installation-wide kernel-backed ownership for different concurrent update
  versions, durable journal and public update/recovery, legacy unsealed recovery,
  Linux support and final dev/production artifact separation. Same-version setup
  convergence does not prove transaction ownership across different builds.

### Packed installation checkpoint (09:18 UTC; supersedes older checkpoints)

- The deterministic MCP archive now includes three optional adapter assets under
  `dist/tab-adapter`. Exact build/pack/boundary assertions include that directory.
  The worker derives native host name from Chrome's extension ID, so setup does not
  compile a per-installation host constant. Each installation gets its own registration.
- New public `adapter prepare`, `adapter setup`, `adapter status` commands use stable
  copied worker bytes and a generated persistent unpacked ID. Prepare does not register
  a host; setup currently registers Windows Chrome only. Status performs a live probe.
  Packed checks prove repeated preparation preserves identity and bytes without native
  registration or browser startup. Native registration removal now compares the exact
  registry value to the owned manifest path instead of a substring match.
- `adapter-directory.ts` validates ownership metadata, exact artifact hashes, canonical
  paths and manifest capabilities; concurrent first setup converges on one complete
  identity. Seven independent filesystem tests pass. Luna's initial chmod(0777) failure
  asserted an unsupported Windows/Unix mode contract; corrected tests target actual
  Chrome permissions and reject additional host permissions/scripts/resources.
- Default EngineHost discovers installed ads lazily only for existing-browser operations.
  It no longer needs NEWTON_BROWSER_NATIVE_ADVERTISEMENT. Multiple live profiles retain
  distinct IDs and a shared actual escaped 8 KiB output budget. A deterministic two-peer
  test confirms inventory-only discovery and retained identities under truncation.
- V20 package: 13 files, 300515 bytes, SHA256
  `e7445c26ed5903050528c83c3535e2d1b0b1e17563114d862d82749c5294a158`.
  `astra-pack-v20.log` passes. `astra-public-setup-v20.log` passes at 09:17:04 UTC:
  actual packaged CLI prepare/setup, packaged worker bytes (no source build or worker
  rewriting), default-host discovery/start/actions, two-profile update binding, fresh
  claim/DOM smoke and forced rollback. Only manifest.key is installation-specific.
  The update coordinator is still invoked internally by QA, not via a public command.
- Full suite `astra-suite-v13.log`: 676 passed, no failures/cancellations/skips/todos,
  28191.7261 ms. Typecheck and boundary checks pass. A later focused native-registration
  regression proves exact-path matching and rejects ambiguous multiple registry values;
  that final parsing refinement is source-only after v20. Latest everyday online QA
  remains v8 and is not attributed to v20.
- Remaining lifecycle work: durable journal and installation-wide update lock; public
  update/recovery commands; safe idempotent native setup (current installer copies into
  an existing build on repeat); Linux launcher/registration; final dev-control artifact
  separation. Existing adapter metadata also needs journaled digest updates after
  publication. The tested internal updater does not yet maintain that public record.

### Update continuity checkpoint (08:57 UTC; supersedes older checkpoints)

- `adapter-update-control.ts` now composes the shared native client, same-profile
  proof, quiescence, reload, fresh bootstrap, harmless fresh tab claim/DOM smoke and
  marker cleanup. `native-reconnect.ts` subscribes to advertisement changes before
  scanning; four bounded concurrent handshakes avoid serial stale-peer stalls. There
  is no periodic polling or second protocol implementation in the QA script.
- Update continuity uses one inactive blank tab with an extension-scoped 256-bit
  random ticket in its fragment. It contains no script or website state. A new peer
  must prove the exact marker; another profile with the same extension/native host
  cannot satisfy it. The caller must journal the ticket before mutation; public
  durable journal/recovery commands are still unfinished.
- The rejected extension-page prototype failed in actual Chrome: create initially
  returned pending navigation, and extension reload removed the extension-owned tab.
  Evidence is `astra-update-binding-v13.log`, `astra-update-binding-diagnosis.log`
  and `astra-update-binding-commit.log`. The final blank marker waits on actual
  tab update/removal events plus an initial state read. No sleep was added.
- The blank marker survives reload but Chrome rejected debugger attachment to it.
  `astra-update-control-v14.log` records attach_failed for both update and rollback.
  The control now requires an authorized normal smoke tab and only reads its DOM
  root under a fresh claim, then releases it; no navigation or input is replayed.
- Frozen v15 package: 283648 bytes, SHA256
  `9c6af01c974cd61791ff32d6d25e30e4e0ca612fbf5bc85344a071ef000583e7`.
  Pack gate passes. Shared packed control passes headless (08:54:47 UTC) and headed
  (08:56:51 UTC), each with a second live profile, update, fresh claim/DOM smoke,
  forced digest mismatch, rollback and exact marker cleanup. See
  `astra-update-control-v15.log` and `astra-update-control-headed-v15.log`.
  The extension is still built from current source by this verifier, not yet shipped
  as an installable optional artifact; do not overstate packed extension coverage.
- Three deterministic reconnect tests pass: reject another live profile and observe
  a later ad, abort unanswered proof, bounded deadline. Typecheck passes. Full suite
  v11 is NOT green: 664/667 passed while Luna's updated tests were in progress.
  The actual-worker fixture used an invalid fake extension ID; Astra corrected it
  and its oversized-response regression passes. Luna owns only the update-binding
  test/evidence files while completing event-race cases; rerun after completion.
- Next coherent production work: packed optional extension assets; explicit local
  setup/status/update/recovery commands and durable ownership journal; platform
  registration/launcher coverage; multi-instance public discovery. Do not require
  exact engine/extension version equality: runtime capabilities establish usability,
  while the active update validates its requested code digest.
- Luna completed ten event/race tests and identified a retained-marker retry failure.
  Astra fixed same-ticket preparation to reuse one exact committed marker, preserving
  rejection of a different ticket or ambiguity. Eleven binding tests plus three native
  reconnect tests and the actual-worker response test pass independently. Full suite
  `astra-suite-v12.log` is 668/668 passed, no failures/cancellations/skips/todos,
  27580.6089 ms; typecheck also passes.
  This final marker refinement is source-only in extension code (the MCP v15 package
  does not contain the extension artifact).
- The public update journal must hold an exclusive lock for the installation directory,
  not merely the selected browser profile: multiple profiles share worker.js on disk.
  Marker proof resolves browser identity but does not serialize file publication.
  Interrupted recovery must preserve ticket, last-good build and publication state,
  and cannot claim rollback from copied files without a fresh proven bootstrap/smoke.

### Native readiness checkpoint (supersedes older checkpoints below)

- Full source suite `astra-suite-v10.log`: 648 passed, zero failures, cancellations,
  skips or todos; 28778.7448 ms. Typecheck passes. These are implementation gates,
  not full release acceptance.
- Frozen v12 package: 282431 bytes, SHA256
  `84ce9788e14a8839439d7311c74649ed7cf68f51c33c7be1298f2aa0e035923a`.
  `astra-pack-v12.log` proves deterministic packing, installation with spaces,
  symlinked entrypoint and the 13-tool catalog without browser startup.
- `native-client.ts` is now the sole private client implementation, reused by the
  tab-claim adapter, discovery and development update QA. It validates derived
  endpoints, hello identity/capabilities, correlation and response envelopes;
  repeated hello is terminal. Read timeouts retire the request; uncertain mutation
  timeouts retire the connection. Peer error text is normalized.
- Public existing discover/setup now perform a live hello and bounded tab inventory,
  with explicit untrusted content, ownership, connection and instance identity.
  Configuration alone cannot report ready. Probes do not claim or navigate tabs.
  Owned executable discovery is lazy, so existing mode does not require an owned
  browser launch. Production discovery still uses an explicitly configured ad file.
- Native broker publishes its advertisement atomically only after a validated hello.
  Early EOF rejects startup. Its 64-request limit now counts unanswered requests,
  not completed writes. Response consumption frees one slot; duplicate request IDs
  close the client, with one owner release. Deterministic regressions cover these.
- V11 headless adapter passed actual discovery/setup, file actions and native-based
  update/rollback bootstrap. V12 headed verification passed at 08:38:32 UTC in
  `astra-adapter-headed-v12.log`, including update and forced rollback. Last everyday
  public-site QA remains v8; do not attribute it to v12.
- Source after v12 also rejects malformed response results rather than converting
  them to successful empty acknowledgements. Five cases cover absent/null/array/scalar
  results and conflicting result/error envelopes. Typecheck and the 22 focused native
  tests pass; this last change is not yet represented by the frozen v12 artifact.
- Development reload now follows a fresh native bootstrap using a filesystem event
  subscription, not an immediately usable setup-page context. Its unique disposable
  host namespace is NOT a production browser-instance identity solution. The old v9
  failure discarded its original causes; subsequent passes do not prove that cause.
- Remaining native work: public installation/update/recovery entrypoints, persistent
  installed identity/digest expectations, correct browser binding across reload,
  multi-instance discovery and Linux launcher. Luna is auditing only
  `test/evidence/luna-native-installation-audit.md`; initial stale assertions were
  returned for correction. No worker polling or waiting.

### Latest checkpoint (08:07 UTC; supersedes historical updates below)

- Full source suite: `astra-suite-v8.log`, 625 passed, zero failures/cancellations/skips,
  28798.1514 ms. Later six independent file-action cases and the new update-cause case
  also pass focused runs. This is not a release acceptance result.
- Native table/form/link records now run through public MCP, preserving spans, blanks,
  headers, actionable fields and actual escaped output budgets. Table identity checks
  bracket extraction; native row ordering handles footer source order. Unsupported
  structures are explicit. Scoped iframe descendant completeness remains unfinished.
- Compact record deltas omit unchanged content, refresh nested action refs, preserve
  ordering, and reset incompatible/incomplete baselines. Actual encoded bytes choose
  compact versus full output. Regression tests reconstruct the complete new view.
- DOM object resolution now uses isolated native wrappers, with no page writes or
  navigation scripts. Live document/table/form/control tests pass, including application
  DOM prototype overrides. Luna's eight deterministic context lifecycle tests pass.
- Luna completed file validator implementation/review fixes and six integrated action
  tests, all independently reviewed/rerun by Astra. Current exclusive lane is read-only
  integration audit written ONLY to `test/evidence/luna-existing-entrypoint-audit.md`;
  it maps real vs configured discovery/setup and reusable native transport. Proactive
  report required; no worker polling/waiting.
- Frozen v9 package: SHA256 b39dff7640bf7722a61be7a2bf18962a5bd1daa5b1c0829d26b314a02408e0d3
  (279297 bytes). Source additionally preserves failed update+rollback causes.
  Most recent online probes remain v8 (27 calls, all three workflows pass); do not
  attribute those probes to v9.
- Files and owned resize are implemented through MCP. Native file selection verifies
  filenames, omits paths, handles hidden inputs and site-cleared files, and returns site
  dialogs promptly. Local validator checks exact bounded media files, path safety and
  retained handle identity; Windows slash/case normalization was fixed after review.
  Owned resize uses Browser.setContentsSize and actual viewport evidence; borrowed
  resize rejects before dispatch. No device emulation or script mutation.
- V7 package failed Wikipedia after a later DOM.documentUpdated invalidated frontend
  IDs within an unchanged navigation generation. Exact trace in navigation-race-7.log.
  Wait probes now retry only on same-page DOM revision or generation change; unrelated
  failures still propagate, and input is never replayed. Source diagnostic confirmed an
  actual recovered error and verified article effect; packed v8 online probes pass.
- Headed/headless packed adapter v9 fixtures pass with native file selection and independent
  effect checks. OPEN: first headless v9 run failed update and rollback after all action
  checks passed. Later passes do not resolve this intermittent failure. Causes were
  previously discarded; now preserved and regression-tested. Investigate actual native
  bootstrap/epoch transition after reload before accepting update reliability.
- Remaining: scoped descendants/changed-context feedback, precise editing,
  broader frame/input/modal lifecycles, borrowed popup ownership, real adapter discovery,
  production extension install/update packaging, legacy retirement, broad everyday and
  authenticated model-loop QA, then three unchanged packed release checks.

### Historical updates (dates and lane assignments below are not current)

Current integration update (06:40 UTC): the frozen A562DFB5 artifact passed 556 tests
and headed/headless adapter fixtures, but failed ordinary Wikipedia QA. Independent
investigation found ignored rejected actions in the QA runner, a navigation read race,
and a whole-AX-tree response exceeding the private transport's 4 MiB limit. Earlier
v2/v3 workflow pass labels are NOT acceptance evidence: they ignored rejected Enter
actions, including GitHub's filter submission. See `luna-qa-oracle-audit.md`.

Active Luna write lane: ONLY `scripts/qa/packed-acceptance-probes.mjs` and
`test/evidence/luna-qa-oracle-audit.md`, correcting those assertions. No browser/build/pack
work in that lane. Astra owns new reader/navigation code and current suite execution.

Current source uses bounded AX expansion (depth-4 seed, 64 branch requests in batches
of eight, 4096 retained nodes, explicit incompleteness), renderer-side semantic queries,
and no expansion of control/text layout leaves. This is not a hard protocol-size bound
for arbitrarily wide nodes or enormous individual AX names; that adversarial case still
needs transport/reader work. Live Wikipedia now opens and reads article-specific text
without transport loss (`navigation-diagnosis.json`, source evidence only). Read-only
condition probes retry across a proven document-generation transition without replaying
input. Parsing documents are not cached as complete empty snapshots. Document projection
removes indentation noise while preserving preformatted whitespace.

06:53 UTC update: current source additionally keeps the private pipe alive after a
positively correlated oversized read response. It drains that frame without retaining
it, rejects only that reader, and preserves following replies. Oversized events, unknown
IDs and mutations retain terminal behavior. Real Chrome regression with a 5 MiB AX
name proves document reads and navigation still work. Native adapter response-post
failures now return a bounded error instead of becoming an unhandled rejected promise.

Packed v5 (180e5246, 258120 bytes) verified Wikipedia with corrected receipts and body
identity. It exposed a missing deeply nested GitHub filter; current source now queries
scarce edit roles directly and retrieves their ancestor paths. Primary-landmark links
are prioritized over global navigation links without site-specific selectors. Current
source GitHub evidence verifies filter submission URL and visible issue links in
`github-diagnosis.json`. W3C continuation itself passed; its runner mistakenly expected
structured links instead of the documented inline angle-bracket destinations. Luna
corrected that oracle and is idle, awaiting a new frozen candidate. Do not reuse v5's
overall pass/fail labels as evidence for subsequent source changes.

07:05 UTC update: frozen v6 artifact (78468b0e, 258956 bytes) passed all three corrected
online workflows: 27 calls, 9652 ms overall; Wikipedia, GitHub submitted query, W3C
identity/immutable continuation/inline links. Full suite before the following popup
changes: 571/571, 28120 ms. No release acceptance claim; full architecture still incomplete.

Current source adds private owned-browser target discovery and popup attachment without
changing selection; borrowed connections never receive browser discovery. Page inventory
now includes bounded observed URL/title, selected flag and opener identity. A popup that
closes during attachment cancels that attachment wait and cannot be resurrected by a
late reply. Real popup regression includes an independently operated child and a
self-closing transient popup. `tab-adapter-response.test.mjs` executes the actual bundled
worker against a mock native port, proving oversized response errors and same-claim reuse.

`CommandContext.read` now races cancellation, so a stalled read cannot hold the queue
waiting for a CDP reply. Input acknowledgement behavior remains separate and conservative.
An optional read timeout cannot overwrite an already verified action outcome or close the
session merely for that read; its observation reports unavailable/timed_out. Deterministic
engine regression verifies next-command progress and no late input replay.

Active Luna lane: ONLY `packages/driver/test/page-metadata.test.mjs` and
`test/evidence/luna-page-metadata-findings.md`, independent metadata/generation regressions.
No browser/build/pack work in that lane. Parent continues popup/engine integration.

Astra owns runtime, protocol, builds, integration and release acceptance. Luna task
`01a07df6-18c6-7401-9155-f8cb73cbcc18` relinquished all runtime writes at a safe checkpoint.
Only this worker may be used; no additional tasks or subagents. It must proactively
message parent `01a07ce4-32ec-7882-8e58-20feeac2199a` on completion/blockage. Never poll or
wait_threads. Delegate only bounded simpler work that actually saves time.

Completed Luna lane: read-only `LEGACY_MIGRATION_INVENTORY.md`, independently read by Astra.
Completed Luna lane: frozen packed baseline workflow QA. ONLY allowed writes:
`scripts/qa/packed-acceptance-probes.mjs`, `test/evidence/luna-packed-probes.json`.
It must not build or use changing source/dist. It tests Wikipedia search/article, public
GitHub issue filtering, and documentation continuation. This is scripted workflow QA,
not model-turn or ChatGPT parity evidence. It proactively returned 29-call passing
Wikipedia/GitHub/W3C scripted workflows, then 21-call passing two-session isolation,
cross-session progress, cancellation, recovery and independent stop probes. Second lane
outputs: `scripts/qa/packed-concurrency-probes.mjs`, `test/evidence/luna-packed-concurrency.json`.
Both used immutable artifact SHA-256 `8C8C78BB76BB34B3795077910D89F70AF93176A01D5C13C025300A1741751BE8`.
Path normalization completed; lint passes. Luna also completed independent document-reader
live regressions in `test/engine-regressions/document-reader.test.mjs` with findings in
`test/evidence/luna-document-reader-findings.md`. Astra reviewed and strengthened the
newline, encoded-byte-budget and cursor-progress assertions; all pass. Luna is idle with
no active write paths. Baseline packed probes do not verify later Astra edits.

## Changes made by Astra

- Sensitive inspection now gates `.value` access itself; two getter-oracle tests failed
  before and pass after. Both normal refusal and sensitive-zone masking are covered.
- Same-process frame selector roots now use DOM frame owners/content documents. Live
  parent/child test failed with ambiguous/not_found before and passes after.
- Sequence steps without requested assertions continue; later steps rebind only the
  admitted page's current document. Failed local postconditions report stoppedAt.
- Wait parser/schema reject meaningless/contradictory predicates and target strategies.
- NativeInput action scope consolidates chord/pointer held-input ownership and narrow
  bounded cleanup; keydown/character boundaries recheck focus/sensitivity. Global press
  resolves actual focused frame targets. Pure key descriptions now live in
  `key-description.ts`; the replacement no longer imports the old dispatcher. Key release
  modifier bits preserve the modifiers still held during reverse release.
- Key preflight now runs before focus; select resolves disabled optgroups and bounds its
  keyboard work before focus. Internal ordinary values remain exact for verification,
  while sensitive access is prohibited and public observation redaction stays separate.
- Record IDs use opaque node/document identity instead of fresh action refs. Missing or
  incomplete baselines reset explicitly; projection failures settle the read lane. Optional
  duplicate delta data falls back to a bounded reset rather than losing useful full records.
- Adapter forwarding now includes the shared engine's document/history/frame/pointer methods.
  Browser-wide attach/close remains prohibited. Disconnect tracks keys/buttons per original
  frame route, so a main-frame key release cannot erase a child's held input.
- Live iframe click repro failed before: child-local coordinates targeted the wrong page
  location. Browser content quads and hit-node evidence now pass same-site and cross-site
  offset frames. Fragment navigation and back/forward preserve document generation.
- Dialog actions have exact opaque dialog IDs and route-bound accept/dismiss. Modal opening
  interrupts acknowledgement waiting without claiming acknowledgement or repeating input.
  Held releases remain suspended until dialog closure, with ordinary actions fenced.
  Live prompt, keyboard Enter, stale ID, accept/dismiss, navigation alert and owned stop
  regressions pass. Document/visual reads expose the modal instead of entering its renderer.
- Field edits now use `observeAfterAction` to return fresh target-scoped AX/facts and a
  usable ref instead of a full page tree. General observations expose page stamps and
  root AX title/URL when bounded; local observations expose their page stamp.
- `document-reader.ts` replaces flattened text extraction with bounded read-only traversal,
  paragraph/preformatted structure and visible link destinations. It excludes field and
  hidden subtrees before descending, preserves Unicode boundaries, measures the encoded
  response, and continues retained prefixes even when source work was capped. Cached
  document reads now carry page generations and reject stale/split-pair cursors.
- Hover, capture-bound move, secondary button and repeated clicks share native input and
  pointer hit checks. Luna's independent pointer tests exposed a missing dblclick fixture
  listener (corrected) and real root-only text waits (fixed using frame document resolution
  and the shared bounded reader). Actual trusted event and iframe effect tests pass.
- Scroll accepts an explicit container target. Live same/cross-site frame tests reproduced
  asynchronous compositor application after wheel acknowledgement; verification now waits
  on offset transitions with a bounded event/fallback check and reports unknown if absent.
  It neither repeats wheel input nor waits for page/network idle.

Checks so far: focused contract, lifecycle, getter-oracle and native-input tests pass;
live frame, dialog and Luna adversarial regressions pass; typecheck and driver build pass.
Broad suite passed 531/531 with no skips (17.8 seconds) before local-field/document changes.
Latest local-field/live-document/chunk/getter/pointer/frame-scroll checks and typecheck pass;
driver builds. A fresh broad run for this batch is in progress. No release claim.

## Immediate remaining work

### Latest packed checkpoint and adapter input fixes

- Luna recovered the broad suite evidence: 543/543, zero skips, 22.51 seconds,
  before the hidden-input changes. See `astra-suite-current.json` and its full log.
- Latest `pack:check` passed for 255860-byte artifact, SHA-256
  `a562dfb54fdf6341aa934f61716b5db843a9681ed8363a5597769d343bb547d9`.
- Luna's first candidate rerun (`astra-packed-probes.json`) exposed crowded-out search
  controls. Default views now omit redundant record IDs and prioritize edit/search controls
  before navigation links. The control-budget unit test reproduces the crowded layout.
  Frozen v2 report `astra-packed-probes-v2.json` passes all three online workflows, 29 calls.
  Candidate concurrency report passes all 21 calls. Frozen v3 online report also passes
  all 29 calls on `fb708402...` (248718 bytes, before document-specific pointer preparation).
  Luna currently owns ONLY `astra-suite-v2.log`, `astra-suite-v2.json` and
  `astra-packed-probes-v4.json` for one frozen-source suite and frozen-artifact live QA.
  Runtime is frozen during that lane; proactively delivered completion is required.
- Extended `scripts/verify-tab-foundation.mjs` and `foundation-tab-client.mjs` now probe
  borrowed hover/checkbox/prompt/document/records/container scroll and stopping with a prompt.
  It now PASSES on both headed and headless Chrome with hidden tabs, no activation or
  visibility changes, exactly one trusted wheel event per scroll, real DOM effects,
  retained native prompt after detach and actual update/rollback.
  Chromium queues mouse moves for animation frames (five-second fallback in hidden tabs).
  `Overlay.enable` requests unbuffered debugger input without adding a visible overlay.
  New hidden headed documents also discarded acknowledged clicks before first paint;
  one viewport observation per document prepares pointer input. Hidden wheel dispatch
  waits for a compositor visual-state callback: a concurrent viewport capture lets it
  complete. A 1px capture did not reliably commit off-clip scroll layers and was rejected.
  Captures are single-flight per page, discarded, never used to activate tabs or emulate
  visibility. An optional capture must not hold an already verified scroll receipt;
  another tab's native modal can withhold its completion. Three deterministic hidden-input
  tests and live pointer/frame tests pass. No release or complete adapter-parity claim.
  The post-detach prompt oracle was wrong: a newly attached Page handler cannot inherit
  Chromium's pending-dialog callback. An observer attached before the dialog opens proves
  preservation and dismisses it independently after worker detach.
  Diagnostic activation/window/unbuffered/capture flags were removed after investigation;
  `NEWTON_TAB_QA_HEADED=1` remains the legitimate headed QA variant.
- TabClaims detach now fences new input and issues held releases, then awaits detach instead
  of waiting behind modal-held CDP acknowledgements. Unit repro and real borrowed modal
  preservation now pass.
- All diagnostic operations now have bounded oracle waits; one earlier run required Ctrl-C.
  Its browser processes ended, but automatic policy rejected BOTH recursive temp removal
  and the narrower childless registry-key removal. Do not retry those deletions:
  temp suffix `newton-prototype-tab-foundation-LlXRFT`, test native host
  `newton.browser.test_57edfdebd851406e82407b3429d1eb86`. The registry manifest points into
  that retained temp root. Explain this residual separately in the final response.

### Remaining implementation

Current reader/action batch (Astra-owned, targeted tests/build/typecheck pass):

- New `control-reader.ts` preserves row/form/dialog/group ancestry, native checked
  tristates, descriptions and error relationships without copying AX field values.
  Luna's four independent helper tests pass after fixing string `true`/`false`.
  Real Chromium additionally exposed `LayoutTableRow` and textless error relations;
  default views read related AX text, and local field feedback reads only explicitly
  related error containers through the same bounded document reader.
- `browser.observe` accepts one strict `scope` target (ref/selector/semantic). Missing
  scope differs from empty scope; row-specific views retain useful refs. Record baselines
  cannot be applied across incompatible scopes. Native JS dialogs still take precedence.
- `browser.document.read` accepts page/container scope. Its five-minute bounded snapshots
  retain the original frame/document; continuation cannot cross root or child navigation.
  A hidden preferred main falls back to visible body text, while an explicitly hidden
  container remains empty. Scoped child-frame reads and immutable continuation after
  DOM text changes are verified through MCP.
- One result serializer now supplies the reader's exact escaped UTF-8 output predicate,
  including the actual action receipt envelope or read/image envelope. Removed the
  independent 1536/2048 reader deductions. Refs are allocated after selecting a view that
  fits. Local views can omit oversized optional details with explicit incompleteness.
  Actual scoped views and filled-field validation fit and remain useful at 2048 bytes.
- Offscreen/overflow-clipped pointer targets use typed `DOM.scrollIntoViewIfNeeded`,
  counted as preparatory input, followed by fresh geometry. Covered targets still refuse
  without pointer input. Repro exposed that `DOM.getNodeForLocation` consumes document
  coordinates while content quads and pointer dispatch use viewport coordinates; the
  hit test now adds the route-root scroll offset. Native offscreen and clipped clicks,
  same/cross-site frame checks and the expanded headless packed adapter test pass.

- Finish records/readers: current records still wrap controls, and deltas retain full
  records for fresh refs. Implement actual table/link/form shapes, reference-aware compact
  deltas and scoped iframe descendants without misleading completeness. Changed-context
  click/key views remain; basic field validation and container scopes are now implemented.
- Finish page/popup ownership, precise edits, files/resize and remaining native select
  coverage. Broaden borrowed modal disconnect cases,
  human dialog closure, startup dialogs, frame teardown and multi-quad pointer targets.
- Broaden packed adapter parity beyond the early fill prototype and ensure discovery/setup
  reports actual adapter availability rather than configured capability alone.
- Migrate useful old setup/test callers and remove obsolete owners per inventory.
- Full packed adversarial suites and actual everyday online/model-loop acceptance, then
  three unchanged full release-check runs. Older green suites are not sufficient.

Preserve unrelated release-verification-win32.json and the two previously denied temp
residue deletions. Original reviews/scripts live under C:/DEV/newton-browser; do not
overwrite current code from that older checkout.
