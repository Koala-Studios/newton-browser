# Codex Thread Orchestrator Guide

## Purpose

This guide defines a reusable way to coordinate up to four concurrent implementation
workers through user-visible Codex threads. It is intentionally project-agnostic. A
repository’s `AGENTS.md`, approved implementation plan, and safety rules always override
this guide.

Use threads when exact worker-model selection, isolated worktrees, durable task history,
or direct user visibility matters. Use fewer than four workers when dependencies or file
ownership do not permit four genuinely independent lanes.

## Model capability check

Before dispatch, inspect the current host’s thread-creation capabilities. In the Codex
desktop host used to author this guide, dedicated threads expose the exact model
`gpt-5.3-codex-spark` with `high` and `xhigh` thinking. The current subagent interface in
the same host exposes only its listed GPT-5.6 variants, so it cannot satisfy a request for
the exact Spark model.

Therefore, the owner’s observation is correct for this host: use Codex threads when the
exact worker requirement is GPT-5.3 Codex Spark. This is a capability fact about the
current interface, not a universal claim that subagents can never support explicit model
selection. Re-check the exposed schemas after product updates and never silently
substitute a model.

## Thinking-level policy

- `high`: bounded implementation with a clear plan, isolated modules, focused tests,
  documentation, fixtures, or mechanical refactors with strong acceptance criteria.
- `xhigh`: concurrency and lifecycle logic, security boundaries, protocol migrations,
  multi-process debugging, ambiguous root causes, or changes spanning several runtime
  surfaces.

Spark should execute an already reasoned plan. If the task is still underspecified, the
orchestrator resolves the contract first rather than paying four workers to make four
different assumptions.

## Orchestrator authority and review standard

The orchestrator is not only a dispatcher and integrator. It owns the architecture,
requirements interpretation, worker guidance, independent code review, adversarial
scrutiny, and final acceptance decision.

GPT-5.3 Codex Spark workers are fast and capable implementers, but they may have less
broad project context and may confidently fill an omitted detail with an incorrect
assumption. Worker prompts must therefore explain not only what to change, but also:

- why the behavior exists and which invariants it protects;
- exact success, failure, cancellation, cleanup, and compatibility semantics;
- forbidden shortcuts and examples of superficially passing but unacceptable solutions;
- important call sites and neighboring contracts the worker may inspect but not edit;
- required negative, boundary, race, and failure-injection cases;
- what uncertainty must be reported instead of guessed.

Worker output is an implementation candidate, not trusted proof of correctness. The
orchestrator independently reads the code and tests, attempts to falsify the worker's
reasoning, and withholds integration until every material concern is resolved. A worker's
self-review or claim that tests pass never substitutes for orchestrator review.

## Preconditions

Do not create worker threads until all of these are true:

1. The requested implementation is approved.
2. Repository instructions and applicable skills have been read.
3. The baseline branch, commit, dirty files, and required test commands are known.
4. The work is divided into independent deliverables with exact write ownership.
5. Shared integration files have one named owner—normally the orchestrator.
6. No worker requires a secret, public write, destructive action, or expanded scope that
   the user has not authorized.

## Concurrency design

Create a file-ownership matrix before creating threads:

| Lane | Deliverable | May edit | Must not edit | Depends on |
| --- | --- | --- | --- | --- |
| W1 | isolated runtime module | exact module/test paths | shared protocol/build/ledger | none |
| W2 | isolated fixture/regression | exact fixture/test paths | W1 paths and shared files | stable contract |
| W3 | isolated docs/tooling | exact docs/script paths | runtime and shared files | none |
| W4 | reserved or independent lane | exact paths | all other owned paths | stated prerequisite |

The matrix must name files or narrow directory globs. Labels such as “backend” and
“tests” are not sufficient when both lanes could touch the same helper, fixture index, or
package script.

Reserve these categories for the orchestrator unless a single worker receives exclusive
ownership:

- lockfiles and root dependency manifests;
- central protocol/schema types;
- changelog, decisions, progress ledger, and release evidence;
- shared build/release/CI configuration;
- generated indexes and cross-package barrel exports;
- files already modified in the owner’s working tree.

Workers may propose a patch for a reserved file in their final report, but they do not
edit it.

## Worktree and starting-state policy

1. Discover the repository/project through the host’s project-listing capability.
2. Default every implementation worker to an isolated Git worktree.
3. Start from the same clean baseline commit so commits can be reviewed and integrated
   deterministically.
4. Use a `working-tree` starting state only when uncommitted owner changes are genuinely
   required by every worker. Snapshot the exact state and warn workers which files are
   owner-controlled.
5. Never use separate threads that write concurrently into the same working directory.

If a task cannot be separated without overlapping writes, run those workers sequentially
or keep the shared portion with the orchestrator.

## Worker thread prompt

Every worker receives a self-contained prompt with this shape:

```text
Role: implementation worker W<N>.
Model requirement: gpt-5.3-codex-spark, thinking=<high|xhigh>.

Objective:
<one bounded, testable deliverable>

Authoritative context:
- repository instructions: <path>
- approved plan/spec: <path and relevant section>
- baseline commit: <hash>

Write boundary:
- allowed: <exact files/directories>
- prohibited: <shared and other-worker files>
- if a prohibited edit is needed, stop and report the proposed change; do not edit it

Acceptance:
- <observable behavior>
- <failure, cancellation, cleanup, and compatibility behavior>
- <negative, boundary, race, and failure-injection cases>
- <focused commands>
- no sleeps/timeouts unless proven root cause
- deterministic repro + regression for defects

Constraints:
- preserve unrelated owner changes
- no push, PR, publish, store/registry action, secret entry, or destructive operation
- do not broaden scope or add dependencies without approval

Deliver:
- summary and rationale
- assumptions made and alternatives rejected
- requirement-to-test mapping
- files changed
- commands/results
- commit hash if committing was authorized
- remaining risks and exact integrator follow-ups
```

Explicitly tell a worker whether it may commit. A commit does not imply permission to
push or publish.

## Dispatch procedure

1. List available projects and resolve the exact repository.
2. Create at most four threads with worktree isolation, exact model
   `gpt-5.3-codex-spark`, and the chosen thinking level.
3. Verify the returned thread metadata. If the exact model is unavailable or substituted,
   stop that lane and report the capability mismatch.
4. Record thread ID, worktree/branch, baseline, lane, allowed paths, and status in a local
   orchestration table.
5. Do not launch a dependent lane merely to maximize concurrency.

## Monitoring and steering

- Prefer cursor-based `wait_threads` snapshots for one to eight active targets. Use long,
  bounded waits rather than frequent polling.
- Use `read_thread` only for detailed diagnosis or when a worker requests input.
- Use `send_message_to_thread` for a precise correction, new evidence, or an integrator
  decision. Do not continuously rewrite the task while the worker is implementing it.
- Leave approval and user-input requests visible to the user; do not answer on the user’s
  behalf.
- If a worker touches a prohibited path, ask it to revert only its own change and report
  the dependency. Never discard unrelated worktree changes.

An orchestration table should remain compact:

| Thread | Lane | Model/thinking | Owned paths | State | Integration commit |
| --- | --- | --- | --- | --- | --- |
| `<id>` | W1 | Spark/high | `<paths>` | running | — |

## Review and integration

The orchestrator performs the following review before integrating a lane. This review is
independent; do not merely confirm the worker's narrative.

### 1. Instruction and scope audit

- Compare the diff line by line with the approved objective, repository instructions,
  worker prompt, write boundary, and non-goals.
- Verify every requested behavior is implemented and no requirement was silently
  narrowed, deferred, or reinterpreted.
- Identify unrelated refactors, new dependencies, public contract drift, forbidden-file
  edits, generated/private artifacts, and unauthorized external effects.
- Inspect the actual diff from the recorded baseline; do not rely on the worker's changed
  file list.

### 2. Logic and invariant audit

- Trace the changed path end to end through callers, state transitions, persistence or
  transport boundaries, error mapping, and cleanup.
- Challenge happy-path assumptions with invalid input, empty and maximum bounds, stale
  state, duplicate delivery, partial failure, cancellation, timeout, reconnect, teardown,
  and concurrent interleavings where applicable.
- Look specifically for swallowed errors, ambiguous outcomes, unsafe retries, missing
  epoch/ownership checks, resource leaks, listener/timer leaks, stale cache entries,
  incorrect rollback order, and success returned before the effect is verified.
- Verify security and privacy checks occur before the effect they claim to prevent and
  cannot be bypassed through alternate targets, encodings, redirects, or recovery paths.
- Reject sleeps, broad timeout increases, global serialization, silent fallback, and
  weakened validation unless the approved contract explicitly requires them.

### 3. Test-quality audit

- Read every added or changed test and confirm it would fail against the original defect
  or a deliberately broken implementation.
- Require assertions on externally observable behavior, outcomes, cleanup, and forbidden
  side effects—not merely function calls or snapshots produced by the implementation
  under test.
- Check negative, boundary, concurrency, failure-injection, and regression coverage.
- Detect mocks that bypass the real integration boundary, tautological expectations,
  excessive snapshot approval, nondeterminism, real-user-profile writes, leaked ports,
  and test order dependence.
- Add or strengthen tests directly when the worker's suite leaves a plausible hole. The
  orchestrator owns final verification and does not need to delegate review fixes.

### 4. Independent execution and integration audit

1. Run the focused tests in the worker worktree and reproduce important failures or
   prevention claims independently.
2. Inspect build/package output when the changed behavior crosses a compiled or packed
   boundary.
3. Integrate one reviewed commit/lane at a time using a non-destructive workflow.
4. Resolve shared-file changes centrally; never ask multiple workers to race on a
   conflict resolution.
5. Run affected cross-package tests after each integration to locate the first
   incompatible lane.
6. Re-review the integrated diff for interaction bugs that were absent in isolated
   worktrees.
7. After all lanes land, run repository-wide lint/typecheck/tests and required live or
   packed-artifact gates.
8. Update decisions, evidence, changelog, and progress ledger once from the integrated
   truth.

If review finds a problem, the orchestrator records the concrete issue and either fixes
it directly within the approved scope or returns a narrowly specified correction to the
worker. Integration waits for the correction and its regression proof.

A passing worker branch is evidence for that lane, not evidence that the integrated
result passes.

## Failure handling

- **Blocked on a contract:** stop the dependent lanes, decide centrally, then update all
  affected prompts with the same resolution.
- **Unexpected overlap:** finish or pause the first owner; rebase/restart the second lane
  after integration. Do not permit simultaneous edits.
- **Flaky test:** require a deterministic repro and root cause. Do not widen timeouts as
  an orchestration shortcut.
- **Worker scope drift:** steer once with exact boundaries; stop the lane if drift
  continues.
- **Model unavailable:** do not substitute. Ask whether to wait, use another supported
  model, or proceed locally.
- **Dirty baseline:** preserve owner changes. Create a deliberate snapshot or restructure
  the work; never reset them away.
- **Failed integration:** revert only the newly integrated commit when safe, preserve
  evidence, and return the lane with the concrete failure.

## Completion and cleanup

The orchestrated task is complete only when the integrated branch—not merely each worker
thread—meets the approved acceptance criteria. Report:

- integrated commits and final changed-file set;
- focused and repository-wide test results;
- live/packed evidence where required;
- deferred risks or decisions;
- confirmation that no unauthorized external action occurred.

Archive worker threads only after their useful report, commit, and evidence identifiers
have been captured. Remove worktrees through the normal recoverable Git workflow after
integration; never use broad recursive deletion against an unresolved path.

## Quick checklist

- [ ] Approval and exact baseline recorded
- [ ] Model capability verified; no substitution
- [ ] One bounded deliverable per thread
- [ ] Exact, non-overlapping file ownership assigned
- [ ] Shared files reserved for one integrator
- [ ] Worktree isolation enabled
- [ ] Acceptance commands included in every prompt
- [ ] Prompts explain rationale, invariants, forbidden shortcuts, and failure semantics
- [ ] Full worker diffs independently reviewed against instructions
- [ ] Logic challenged across boundary, race, cancellation, and cleanup paths
- [ ] Tests scrutinized for false confidence and missing negative coverage
- [ ] Security/privacy prevention verified before effects
- [ ] Cross-lane gates run after each integration
- [ ] Integrated diff re-reviewed for worker interaction bugs
- [ ] Final integrated gates and evidence complete
- [ ] Threads/worktrees cleaned up safely
