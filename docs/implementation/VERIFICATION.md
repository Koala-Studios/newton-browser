# Verification and acceptance instructions

This document is part of [the implementation guide](../IMPLEMENTATION_GUIDE.md).
It is a required test specification, not a claim that these tests already exist or passed.
The foundation owner implements the independent harness; Spark adds packet-specific cases.

## V0 — Build the right harness before fixing the receipt

Create `test/engine-regressions/` for deterministic integration cases and
`scripts/qa/session-engine.mjs` for a root-script runner. Keep driver unit tests in
`packages/driver/test/`, core contracts in `packages/core/test/`, and host/ownership tests
in `apps/mcp-server/test/`. Use the existing root test discovery instead of another test
framework. Root build scripts refresh shared output; run them sequentially.

Add these root commands when their harnesses exist; they are planned names, not commands
that can be run against today's unchanged runtime:

| Planned root command | Purpose |
| --- | --- |
| `test:engine` | F0–F2 queue, receipt, route and primitive regression corpus |
| `test:reader` | Structured reads, redaction, final budgets, refs and continuation |
| `test:connections` | Owned/shared-source and existing/native ownership/failure conformance |
| `qa:tasks` | Designated real online task corpus with independent effect oracles |
| `qa:model-cost` | Repeat the same tasks through the real model/tool loop and measure cost |

Each command must fail on its required unmet assertions. A script that merely prints
receipts for manual interpretation is diagnostic, not a regression gate. Keep the old
`audit:current` evidence and convert its individual expectations into the new harness;
do not rewrite historical receipts or require the diagnostic script's legacy API forever.

### Harness boundaries

- Drive behavioral integration cases through `handleMcpMessage` and, separately, packed
  stdio. Direct driver calls may inspect fixture truth, but cannot replace testing the tool.
- Test effect oracles live outside the code under test. For fixtures, use application-owned
  counters, accepted events, visible values and a test server's own synthetic login logic.
- Newton may not read browser cookies/storage/profile internals to prove login. The fixture
  application can validate its own synthetic session and render signed-in state normally.
- Inject a deferred primitive, process-reader child, clock and transport fault as needed.
  Do not make production pages special or use instrumentation on real sites.
- Test target websites load/render normally: no request interception, animation freezing,
  force-focus emulation, injected observers or browser switches added for passing QA.
- Disposable extension-loading switches belong only to explicitly isolated development
  fixtures. They must be absent from production launch code and packed runtime defaults.
- Own all temporary roots, browser trees, IPC endpoints and native registration names.
  Cleanup verifies marker/path/instance ownership before deleting anything.

## V1 — Audit-to-regression mapping

Every row is independently required; passing one must not mask another.

| Finding / case | Trigger | Independent oracle | Required result |
| --- | --- | --- | --- |
| A01 focus-sensitive race | Focus handler changes ordinary field to password | Fixture input never receives the synthetic text | Preparatory input retained; text prevented after final facts check |
| A01 replacement route | Field/frame changes between resolution and input | Replacement document has no unintended input | Stale/explicit checked re-resolution policy, never secret fallback |
| A02 partial batch | First ordinary fill, second rejected sensitive field | First value changed; second untouched | First dispatch retained, stoppedAt correct, no whole-batch prevention/retry-safe claim |
| A02 interleaving | Hold second step and enqueue another action | Third action starts only after batch settles | One queue entry for the whole batch |
| A03 readonly fill | Fill readonly input | Original value persists | Postcondition not met; no false verified value |
| A03 navigation failure | Target server closes request without response | Browser error/document facts, fixture request record | Failed navigation, not successful destination |
| A03 hidden semantic wait | Visible button plus hidden wait | Visibility remains true | Wait does not succeed |
| A04 useful returned state | Fill then continue with resulting control | Returned state contains actionable evidence | No routine extra observe required for the known next action |
| A04 private ref invalidation | Read late target, fill another field, act on original target | Original live element receives intended input | Private verification did not erase public ref |
| A05 node/byte budget | Request bounded output on >80 controls | Actual UTF-8 encoded response size and omitted data | Limit obeyed; incomplete whenever content omitted |
| A05 document continuation | Read more than one bounded chunk | Concatenated snapshot chunks match redacted source structure | No skipped/repeated text, truthful expiry/limits |
| A06 late semantic target | Exact match occurs after first 80 controls | Correct target receives event | Search before presentation cap; duplicate candidates still ambiguous |
| A07 deadline | Hold input acknowledgement, expire context | No later primitive dispatch starts | Caller timeout does not release live lane |
| A07 stop | Never resolve executor | Exact owned process tree exits; unrelated tree lives | Cleanup independent of driver drain |
| A08 scan stall | Process helper withholds EOF | Status/second session complete before releasing helper | Async bounded scan, no host event-loop stall |
| A09 trusted select | Fixture accepts only trusted change event | Application acceptance flag and selected option agree | Native input, no synthetic event assignment |
| A10 supplied URL | Start at path + query + fragment | Initial server route/browser location match | No avoidable navigate repair turn |
| New shared-source gate | Closed source plus other active browser workers | Source copy succeeds; live workers untouched | Exact source ownership proof replaces global family shutdown dependency |

Tests must distinguish a thrown error from an input that was actually prevented. When
preparatory input occurred, a passing "no text entered" oracle does not justify reporting
no effects. Verify both the effect and the receipt independently.

## V2 — Additional architectural regressions

### Command records and cancellation

1. Identical duplicate command while active joins the existing record without another input.
2. Different content under that ID is a conflict before dispatch.
3. Evict a terminal record; submitting its old ID cannot execute it again.
4. Active records survive terminal TTL/eviction pressure.
5. A future gap, invalid ID and queue-full request do not corrupt next-command sequencing.
6. Drop the tool response after input; read the same command result without replay.
7. Cancel before admission, while queued, during preparation, during input, during optional
   read and during cleanup. Assert the distinct facts in each state.
8. Late continuation after timeout cannot send another primitive. Late acknowledgement
   cannot accidentally finish a different command or change an immutable terminal receipt.
9. A failure in one session does not stall status, stop or a second session.

### Pages, frames and input

1. Same URL reload invalidates the prior document; pushState/hash update does not invent a
   new document; a detached node never resolves to a reused ref token.
2. Navigate one child frame without invalidating unrelated refs. Swap an OOPIF and deliver
   the old detach event late; it must not retire the new route.
3. Cause one popup, several popups, a background popup, then close an active page. Assert
   admitted page routing and the documented selection behavior with fresh page IDs.
4. Open a dialog during input and fail a release primitive. Receipt and held-input cleanup
   remain correct; no silent click retry.
5. Move/cover a target between observation and action. Test current actionability and honest
   uncertainty; do not freeze the page to avoid the race.
6. Check ordinary/native/custom select and contenteditable separately. Support is not inferred
   from one text input or one platform's keyboard behavior.

### Readers and budgets

1. Multi-byte Unicode, escaped JSON text, redaction expansion and long metadata hit exact
   output boundaries without invalid JSON or lost mandatory fields.
2. A tiny requested view does not cause an unbounded scan of all frames/nodes. Record CDP
   calls/work counts and the explicit incomplete reason when the work cap is hit.
3. Duplicate buttons retain row/dialog context; table cells are not concatenated guesses.
4. Virtualized lists, missing table headers, spans and mixed link text preserve truthful
   scope and missing/unsupported structure.
5. Document cache contains redacted data only, remains bounded, and expires cursors explicitly.
6. Missing/incompatible delta baseline returns a bounded full reset, never a guessed delta.
7. Screenshot clipping, scale, viewport movement, frames and trusted masking share the same
   provenance path used by coordinate input. An unsafe capture fails closed.

### Source and extension lifecycle

1. Three standalone workers share initial fixture login through separate writable identities.
2. Refresh a source while workers act; no active identity is modified. New workers receive
   the new generation. Interrupted publication preserves a usable complete generation.
3. Reject source locks, symlinks, path escapes, unstable/partial copies and unproved closure.
4. Test server-side login revocation separately from local logout isolation; do not promise
   that copied credentials make remote sessions independent.
5. Two real MCP processes/native ports race for one tab; only one owns it. Then each owns
   a different tab and both make progress with no profile-wide lock.
6. Reject caller-forged owner labels, old epochs, stale generations and unrelated frame IDs.
7. Kill one worker/native host, detach through Chrome, reload the extension and close the
   browser. Fence stale input and preserve the other worker's unrelated claims where valid.
8. Malformed/oversized/truncated/chunked native traffic and large screenshots cannot starve
   stop, detach or response correlation. Test byte caps, concurrency caps and backpressure.
9. Keep extension artifact bytes unchanged across two compatible engine builds. Test major
   incompatibility and missing optional helper while standalone remains usable.
10. Development update proves expected code digest, quiescence, stale-claim rejection and
    fresh working claim. Failed update/rollback and broken bootstrap are explicit states.

## V3 — Real everyday online tasks

Fixtures are necessary for deterministic faults; they are insufficient for acceptance.
Use actual online applications, not locally recreated lookalikes, static screenshots, or
custom pages that contain only the controls the implementation already handles.

Choose concrete targets/accounts before a run and record them in the manifest. Public
read-only tasks can run without account mutations. Authenticated/creative/editing tasks
use designated operator-authorized QA data and normal website sign-in; do not invent
authority to send messages, publish, purchase or change production records for a benchmark.
This is ordinary task scope, not a new Newton permission mechanism.

| Task family | Concrete task pattern | Success oracle |
| --- | --- | --- |
| Public search/navigation | Search Wikipedia, open a result, follow a section/link and answer from it | Correct destination and cited page content, no fallback web search |
| Documentation reading | Navigate a real documentation site, read a long section through continuation, extract linked references | Correct text boundaries and actual destinations; no silently omitted middle |
| Public application filtering | Search/filter issues in a designated public code repository | Correct filter/query state and visible matching rows; no posting |
| Storefront selection | Use an approved online storefront's search/filter and select a product variant | Correct displayed product/variant; no purchase or account change |
| Authenticated form | Edit designated disposable QA data with validation, submit only the authorized QA operation, reopen it | Persisted intended fields and unchanged surrounding data, not merely local input value |
| Rich editor | Edit a specified range in an authorized disposable document with repeated text/Unicode | Intended range changed and surrounding text preserved after supported persistence check |
| Large/virtualized data | Extract a requested visible/loaded subset from a real online table/list | Correct cells/links, accurate subset scope and continuation/limits |
| Multiple tabs/popups | Follow a real app link that opens a new tab, return to the original and continue | Correct page IDs, ownership, opener behavior and no action on a wrong tab |
| Embedded/visual UI | Interact with a real app's embedded or weak-AX control through the supported visual path | Correct visible effect and screenshot provenance, no JS workaround |
| Shared authentication | Two standalone workers perform independent tasks using a designated Newton login source | Both signed in through page-visible state; isolated writable profiles; no credential reads |
| Existing browser | Two engine processes operate designated tabs through an explicitly selected existing connection | Both make progress; no tab stealing; stop leaves browser and unrelated tabs intact |

Use several sites and page shapes. Do not rename a corporate landing page as proof of the
main interactive application's behavior. For each task record exact URL, browser build,
mode, account class/QA-data identifier (no credentials), page state, steps and outcome.

Manual/visual QA is required where the effect is visual: inspect saved screenshots and
the real page result, including masks, dialogs, clipped regions and wrong-tab risks.
Do not claim visual QA from `screenshot.data.length > 0` or an AX title match.

A CAPTCHA, unavailable account, site outage or anti-automation failure is recorded as a
coverage gap/failure with its cause. It cannot be converted to passed by switching to a
simpler site, bypassing the challenge, or using a direct API. Correct the product if it is
at fault; retain external limitations honestly when it is not.

## V4 — Measure the model loop, not just CDP speed

Fix the task instructions, model/version/reasoning settings, harness, browser builds,
backend mode and starting state for each comparison. Use the same model for old/new
Newton measurements. Do not compare a hand-optimized script on the new engine with an
uncoached model on the old one and call it an architecture speedup.

Record at least:

- Actual task success under the independent oracle; failures stay in the denominator.
- Total wall time from task start to useful completion, including model decisions.
- Time from action admission to its useful returned state; p50/p95 and raw sample count.
- Tool calls/turns, explicit observe calls, repair calls, invalid refs and repeated unchanged reads.
- Model input/output tokens where the harness provides them. If tokenizing locally,
  record tokenizer/model assumptions and label estimates; character count is not tokens.
- Unconditional waiting time, condition waits, time spent reconciling uncertain input,
  and whether the caller had to poll.
- Operator interventions: setup/login, recovery, clarification and manual repair separately.
- CDP calls, AX-tree reads and optional geometry calls as diagnostics explaining cost.

Separate cold setup/startup from warm repeated actions. Report both; do not amortize
extension installation into every click or hide source-clone startup from standalone cost.
Separate deterministic scripted primitives from actual model tasks. The prototype's 18 ms
input sequence is not a model performance claim.

Initially run five matched repetitions per selected task/mode. Use larger samples for a
meaningful percentile claim; with five samples, report raw values and descriptive medians,
not a statistically stable p95. Alternate old/new order where possible to reduce cache and
load bias. Keep network conditions and account fixture resets comparable.

Hard acceptance is correctness and removal of the unnecessary loop:

1. Start/selection returns useful state without a mandatory status/observe call.
2. A ref fill does not perform a whole-page discovery just to verify one value.
3. A normal action result includes the state needed for the known next decision.
4. No hidden ref invalidation forces a repair call.
5. No default global settle/network-idle delay on an already usable control.
6. No timeout/recovery path dispatches unrequested later input or replays a mutation.

Set numerical latency/token targets from the recorded baseline before tuning; record them
in the run manifest. Do not invent a five-times-faster claim or lower targets after seeing
a failing candidate. Correctness/ownership failures cannot be traded for faster medians.
ChatGPT Chrome control is a product reference; its private implementation/performance is
not established by these tests. Compare directly only when an actual matched tool run exists.

## V5 — Evidence format

Use a run-scoped evidence directory under `test/evidence/`. Preserve an immutable manifest
and per-task results, with raw bounded traces where allowed. Never put credentials, browser
cookie/storage/profile contents or full sensitive console/network dumps in evidence.

```json
{
  "runId": "engine-candidate-001",
  "candidate": {"commit":"<actual commit>","sourceDigest":"<actual digest>"},
  "platform": "win32",
  "browser": {"family":"chrome","version":"<observed version>"},
  "mode": "owned",
  "taskId": "form-validation-01",
  "status": "passed",
  "oracle": {"kind":"reopened_qa_record","matched":true},
  "metrics": {"toolCalls":7,"repairCalls":0,"elapsedMs":12000},
  "artifacts": ["<bounded trace>","<reviewed screenshot>"],
  "cleanup": {"confirmed":true}
}
```

Numbers above are placeholders, not measured evidence. The harness fills them from the
run; workers must not hand-edit them to match expectations. Missing metrics are unavailable,
not zero. Save failures with their last dispatch/postcondition facts and independent oracle.

The candidate digest must include intended source/config/catalog/skill changes, including
untracked source before a local checkpoint. Exclude only explicitly declared run outputs
and temporary roots so writing evidence does not mutate the candidate being certified.
Do not exclude all docs or new files to suppress a changing-tree check. Verify input source
digest again after each release pass.

## V6 — Packed and release gates

Use the existing root scripts and strengthen their coverage for the new topology:

```powershell
pnpm build
pnpm typecheck
pnpm lint
pnpm test
pnpm eval
pnpm pack:check
pnpm eval:agent-cost
```

Then run the implemented new engine/reader/connection and task gates. Run current owned
live/packed checks on Windows Chrome and Edge and the supported Linux environment. Add
packed existing-mode setup/transport/stop/update checks; a source-only fixture is insufficient.
Do not assume `pnpm release:check` runs every new real-task or authentication gate: today it
explicitly leaves some evidence separate. Update the release orchestration or attach
verified same-candidate receipts with an explicit completeness check.

For the final frozen tree, three consecutive `pnpm release:check` passes are required,
with no skipped critical cases and the same candidate/artifact identity. Any source change
during or after that sequence restarts the final sequence after appropriate targeted tests.
Separate public publishing remains outside this plan.

Capture exact owned-process cleanup and borrowed detach/quarantine results. Remove only
the run's verified temporary roots, native registrations and disposable runtime resources.
Do not prune shared caches or stop unrelated applications as routine release cleanup.

## V7 — Completion checklist

The first replacement release is complete only when all are true:

- A01–A10 and the additional source/ownership regressions pass against independent oracles.
- Every advertised action uses the new engine/context/receipt; no hidden legacy route remains.
- Default shared-source standalone and explicit existing-browser modes work as specified.
- Separate workers progress concurrently with correct process/tab ownership.
- Useful state, structured reading, continuation, deltas, precise editing and visual control
  meet their contracts; unsupported cases are not silently declared supported.
- Real everyday online tasks and authenticated workflows have completed with visual QA.
- The model-cost comparison shows the intended feedback-loop improvements with honest failures.
- Native framing/claims/recovery and dev update/rollback cases pass; standalone survives an
  absent or broken optional backend.
- Packed installation, platform checks and the unchanged-tree three-pass release gates pass.
- All required evidence exists, cleanup is verified, and current documentation describes
  implemented behavior rather than proposals.

A missing account/environment or failed real task is a remaining gap, not a reason to
declare this checklist complete. Report exactly what is missing and which claims it prevents.
