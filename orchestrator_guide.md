# Codex Subagent Orchestrator Guide

## Purpose

This guide defines a reusable way for one Codex orchestrator to coordinate parallel
implementation with GPT-5.6 Sol subagents. It is project-agnostic: repository
instructions, applicable skills, approved plans, and user constraints always take
precedence.

Use subagents only for bounded work that can proceed independently. The orchestrator
owns architecture, shared files, integration, adversarial review, final verification,
and the truth of all completion claims.

## Model and capacity policy

- Default worker model: exact `gpt-5.6-sol`.
- Default reasoning effort: `medium`.
- Raise reasoning only when the user explicitly changes this policy or repository/skill
  instructions require it; never silently substitute another model.
- Verify active collaboration capacity before dispatch. With four total active agent
  slots, run at most three subagents alongside the orchestrator.
- Use fewer workers when dependency order or file ownership does not permit safe
  parallelism. Concurrency is a latency tool, not a delivery requirement.
- Reuse a live subagent for a related correction or follow-up when practical. Start a
  new subagent only for a genuinely independent lane or after the prior agent has ended.

This policy supersedes the earlier GPT-5.3 Codex Spark thread policy. Spark task IDs may
remain in historical evidence, but no new work depends on Spark availability.

## Orchestrator authority and review standard

The orchestrator is the reviewer and scrutinizer, not a passive dispatcher. Worker
output is an implementation candidate, never trusted proof. For every lane the
orchestrator must independently inspect the actual diff, trace the affected execution
path, challenge assumptions, read the tests, and rerun appropriate checks.

Worker prompts must make the following explicit:

- why the behavior exists and which invariants it protects;
- exact allowed files and prohibited shared files;
- success, failure, cancellation, cleanup, compatibility, and retry semantics;
- negative, boundary, concurrency, stale-state, and failure-injection cases;
- forbidden shortcuts, especially sleeps, wider timeouts, silent fallback, validation
  weakening, blanket `any`, and error suppression;
- what uncertainty must be reported instead of guessed.

The orchestrator actively looks for instruction drift, missing cases, false-positive
tests, swallowed errors, unsafe retries, stale state, leaks, premature success, security
checks performed after an effect, and behavior changes hidden inside refactors.

## Preconditions

Before dispatching workers:

1. Confirm the work is approved.
2. Read repository instructions, applicable skills, and the approved plan.
3. Inspect the current branch, commit, dirty files, and required verification commands.
4. Divide work into independent deliverables with exact file ownership.
5. Reserve all shared integration surfaces for one owner, normally the orchestrator.
6. Confirm no lane requires unauthorized secrets, destructive actions, publishing,
   external writes, or scope expansion.

## Shared-workspace ownership

Codex subagents share the orchestrator's workspace. They are not isolated worktrees.
Parallel safety therefore depends on strict, non-overlapping write ownership.

Create an ownership matrix before dispatch:

| Lane | Deliverable | May edit | Must not edit | Depends on |
| --- | --- | --- | --- | --- |
| W1 | isolated runtime module | exact module/test paths | shared config/docs and other lanes | none |
| W2 | isolated runtime module | exact module/test paths | W1 paths and shared files | stable contract |
| W3 | isolated tests/tooling | exact paths | runtime owned by W1/W2 | stable behavior |
| O | integration/review | shared protocol/build/ledger | worker-owned files while active | worker reports |

Directory labels such as `backend` or `tests` are too broad when lanes could touch the
same helper, fixture index, or manifest. Name files or narrow globs.

Reserve these for the orchestrator unless one worker has exclusive ownership:

- lockfiles and root manifests;
- central protocol/schema types;
- progress ledgers, decisions, changelogs, and release evidence;
- shared build, release, and CI configuration;
- generated indexes and cross-package barrels;
- files already modified by the orchestrator.

Workers must not commit in a shared workspace unless the orchestrator explicitly grants
exclusive commit authority. Normally the orchestrator reviews the combined working tree
and creates intentional integration commits.

## Worker prompt template

```text
Role: implementation worker W<N>.
Model requirement: gpt-5.6-sol, reasoning=medium.

Objective:
<one bounded, testable deliverable>

Authoritative context:
- repository instructions: <path>
- approved plan/spec: <path and section>
- current integration baseline: <hash or dirty-state note>

Write boundary:
- allowed: <exact files/directories>
- prohibited: <shared and other-worker paths>
- if a prohibited edit is needed, stop and report the proposed change

Acceptance:
- <observable behavior and behavior-parity requirement>
- <failure/cancellation/cleanup/compatibility semantics>
- <negative/boundary/concurrency/failure-injection cases>
- <focused commands>
- every defect needs deterministic repro, root cause, regression, and evidence

Constraints:
- preserve unrelated and concurrent changes
- use apply_patch for manual file edits
- no sleeps or wider timeouts unless timing is the proven root cause
- no blanket any, ts-ignore, ts-nocheck, validation weakening, or silent fallback
- no commit/push/PR/publish/external write unless explicitly authorized
- do not broaden scope or add dependencies without approval

Deliver:
- summary and rationale
- assumptions and unresolved uncertainty
- requirement-to-test mapping
- exact files changed
- commands and results
- remaining risks and integrator follow-ups
```

## Dispatch and monitoring

1. Spawn at most the available number of non-overlapping workers using exact model
   `gpt-5.6-sol` and reasoning `medium`.
2. Record agent name, lane, owned paths, dependency, and state.
3. Continue useful orchestrator-owned work while workers run.
4. Use long bounded waits for mailbox updates; do not busy-poll.
5. Use follow-up tasks for precise corrections after review. Do not continuously rewrite
   a worker's scope mid-implementation.
6. If a worker touches a prohibited path, stop or steer that lane immediately. Preserve
   unrelated concurrent changes; never reset the shared worktree to clean it up.
7. Do not launch a dependent lane merely to fill a slot.

## Independent review and integration

### 1. Scope and instruction audit

- Compare every changed line with the approved objective, repository rules, prompt,
  ownership boundary, and non-goals.
- Verify no requirement was silently narrowed, deferred, or reinterpreted.
- Identify unrelated refactors, dependency drift, public-contract changes, forbidden
  files, generated/private artifacts, and unauthorized effects.
- Inspect Git status and the actual diff; do not trust the worker's file list.

### 2. Logic and invariant audit

- Trace callers, state transitions, transport/persistence boundaries, error mapping,
  cancellation, and cleanup end to end.
- Test invalid, empty, maximum, duplicate, stale, reordered, partial-failure, teardown,
  reconnect, timeout, and concurrent cases where applicable.
- Look for swallowed errors, ambiguous outcomes, unsafe retries, missing epochs or
  ownership checks, resource/listener/timer leaks, stale caches, rollback-order errors,
  and success before verification.
- Verify security and privacy prevention occurs before the effect and cannot be bypassed
  through alternate targets, redirects, encodings, recovery, or compatibility paths.

### 3. Test-quality audit

- Confirm each regression would fail against the original defect or a deliberately
  broken implementation.
- Prefer externally observable behavior, outcome, cleanup, and forbidden-side-effect
  assertions over call-count or implementation snapshots.
- Detect mocks that bypass the real boundary, tautological assertions, nondeterminism,
  order dependence, leaked resources, and overbroad snapshots.
- Add missing tests directly or return one narrowly scoped correction to the worker.

### 4. Integrated verification

1. Run focused checks after each lane becomes quiescent.
2. Resolve shared-file changes centrally.
3. Review interaction risks after all lanes coexist in the shared workspace.
4. Inspect compiled and packed output when behavior crosses build/package boundaries.
5. Run repository-wide lint, typecheck, tests, build, live smokes, packed gates, and
   repeated release checks required by the approved plan.
6. Update decisions, evidence, changelog, and progress ledger from integrated truth.
7. Commit only the reviewed, intended file set.

If review finds a defect, the orchestrator records the concrete issue, adds or demands a
regression, and either fixes it directly or sends a bounded correction to the owning
worker. A worker's passing focused suite is evidence for that lane, not for the product.

## Failure handling

- **Contract ambiguity:** stop dependent lanes, decide centrally, then send the same
  resolution to every affected worker.
- **Unexpected overlap:** interrupt one lane, establish a single owner, inspect both
  diffs, and resume only after the shared state is reconciled.
- **Flaky test:** require a deterministic repro and proven root cause; do not widen time.
- **Scope drift:** steer once with exact boundaries; interrupt the lane if drift repeats.
- **Model unavailable:** do not substitute silently; continue locally or ask the user.
- **Dirty workspace:** preserve owner and worker changes; never use destructive reset or
  checkout commands.
- **Failed integration:** revert only an intentional integration commit when safe, keep
  evidence, and return a concrete correction to the responsible lane.

## Completion

The task is complete only when the integrated workspace—not individual worker reports—
meets every acceptance criterion. Report final commits/files, focused and repository-wide
results, live/packed evidence, skipped checks, remaining risk, and confirmation that no
unauthorized external action occurred.

## Quick checklist

- [ ] Approval, instructions, plan, baseline, and dirty state inspected
- [ ] Exact GPT-5.6 Sol medium workers; no silent substitution
- [ ] At most capacity-safe concurrent agents
- [ ] Exact, non-overlapping ownership assigned
- [ ] Shared files and existing owner edits reserved
- [ ] Prompts explain invariants, failures, tests, and forbidden shortcuts
- [ ] Actual worker diffs independently reviewed
- [ ] Logic challenged across boundaries, races, stale state, and cleanup
- [ ] Regressions scrutinized for false confidence
- [ ] Security/privacy prevention verified before effects
- [ ] Integrated build/package/live/release gates completed
- [ ] Evidence and ledger updated from verified truth
