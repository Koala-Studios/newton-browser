# Session-engine implementation guide for Codex Spark

Date: 2026-09-07. F0–F4 now have an implemented replacement candidate, including a real
MCP start → fill → observe → stop vertical. Read the current
[foundation certificate](implementation/EXECUTION_LOG.md) before using the sketches below.
Baseline production code is `f2ae1ee` / 0.6.4; implementation is in the working tree.
The default public runtime has not been cut over and the full replacement is not released.

This is an execution manual for one `gpt-5.3-codex-spark` task. It replaces the high-level
roadmap as the order of implementation, while retaining the requirements in
[SESSION_ENGINE_DESIGN.md](SESSION_ENGINE_DESIGN.md) and [AGENTS.md](../AGENTS.md).
No task has been created or contacted by writing it. Do not delegate or message other tasks.

## Read this before handing work to Spark

**The critical foundations have been implemented here. Spark must preserve and extend
them, not recreate competing lifecycle, ref, source, or claim implementations.**

The candidate includes the command-lifecycle core, the page/ref identity core,
the shared-login source owner, and the extension's claim/IPC/update foundation. These are
small in API surface but difficult in failure behavior. A plausible-looking implementation
can pass happy-path tests and still misreport effects, replay actions, block every worker,
or release a profile/tab that remains in use.

| Foundation | Why it should be implemented here first | Spark's later role |
| --- | --- | --- |
| F0: executable contracts and independent test harness | Stops workers inventing competing success flags or tests that merely repeat their implementation | Implement adapters and actions against fixed contracts |
| F1: command context, queue, command record and independent stop | Cancellation, lost acknowledgements and late continuations are the most dangerous shared failure modes | Add action-specific execution and verification |
| F2: page directory, ref identity, route fencing and owned connection seam | One wrong document/session mapping contaminates every action and screenshot | Add bounded target queries and reader projections |
| F3: shared-login source lifecycle and asynchronous closure proof | Opaque copying is already possible; immutable publication, crashes and exact ownership are not solved | Integrate setup/CLI/status and scenario coverage |
| F4: extension claims, native transport and development update recovery | Must coordinate separate MCP processes without a daemon, profile-wide lock, or competing ownership | Add packaging, capability-specific adapters and conformance cases |

F0–F2 come first. Spark can then do the standalone action and reader packets. F3 must be
ready before its login integration packet. F4 must be ready before extension integration.
This is a dependency schedule, not a requirement to build every subsystem before any
useful Spark work starts. The foundation owner must also wire and run the first real
start → fill → useful state → stop path; empty classes and compiling interfaces do not
count as a foundation.

The detailed foundation instructions and code examples are in
[FOUNDATION.md](implementation/FOUNDATION.md). Those original sketches describe intent;
the certificate and actual exported types describe the implemented handoff. Start with
P00 verification and then the remaining integration/action/reader packets.

## How to use this guide

Read these documents in order:

1. This file: scope, non-negotiable rules, ownership and checkpoint protocol.
2. [FOUNDATION.md](implementation/FOUNDATION.md): exact contracts and foundation work.
3. [SPARK_PACKETS.md](implementation/SPARK_PACKETS.md): ordered assignments, files,
   algorithms, negative cases and cutover/deletion requirements.
4. [VERIFICATION.md](implementation/VERIFICATION.md): independent effect oracles,
   audit closure, real-site tasks, cost measurements and release acceptance.

For a packet, read its named existing files in full before editing. Source anchors use
symbol names because line numbers will move. Do not skim a function and copy its current
status logic: the audited implementation is precisely what is being replaced.

## Fixed product choices — do not reopen them

1. Default mode is standalone. A shared **Newton-owned** login source supplies separate
   writable identities and headless browser processes to workers. Never run competing
   browser processes on the same writable directory.
2. "Use my browser" and "use my current profile" select existing-browser mode. The model
   must not select that mode on its own because a login or tab is convenient. Natural
   language interpretation belongs in the caller guidance, not a heuristic in the server.
3. The extension is optional. Its absence, incompatibility or failure cannot stop normal
   standalone use. Explicit existing-mode requests fail clearly when unavailable; they
   never silently fall back to a different account context.
4. Different extension workers may mutate separate owned tabs concurrently. Enforce one
   owner per tab; do not add a mutex around the whole browser profile.
5. Add no Newton permission prompts, origin-grant workflow, pairing approval or approval
   engine. Ownership validation is infrastructure, not a prompt to the operator.
6. The same engine, resolver, reader and receipt semantics serve both connection modes.
   The extension contains transport and browser-local ownership, not browser automation logic.
7. No public publishing, public remote, store submission or license change is included.
8. The first replacement release includes the completed proposed architecture and audited
   fixes, validated on real everyday online tasks. A partial slice is a development checkpoint.

## Worktree and baseline discipline

The current working tree contains important uncommitted documents and prototype code.
A new task that starts from the default Git branch may not receive any of them.

- Before a later handoff, make a reviewed local checkpoint containing the intended plan,
  foundation and evidence, or explicitly carry the current working tree into the checkout.
  Inspect the receiving checkout; never assume a link to this document transferred files.
- Preserve unrelated changes. In particular, `release-verification-win32.json` was already
  untracked before this audit. Do not overwrite, delete, certify or accidentally include it.
- Use `git status --short --branch` and `git diff --stat` before editing. Record the
  baseline commit and actual dirty paths in the execution log.
- Do not run `git reset --hard`, global clean/prune, broad browser kills, or recursive
  deletion of a guessed cache/profile directory. Closing all Chrome was authorized for
  the earlier probe if needed; production code must still enforce exact ownership.
- Do not add a framework, package, runtime dependency, service, database or daemon to
  organize the rewrite. Keep `packages/core`, `packages/driver`, and `apps/mcp-server`.

## File and responsibility map

All paths below are relative to the repository root. New paths are planned, not existing.
Keep driver source files flat: the present driver build and boundary checks expect flat
compiled output. Do not create nested driver source directories as an incidental refactor.

| Owner | Planned file(s) | Exclusive responsibility |
| --- | --- | --- |
| F0 | `packages/core/src/command-contract.ts`, `read-contract.ts`, existing action schema files | Public discriminated types, parsers and catalog contract |
| F1 | `packages/driver/src/command-context.ts`, `command-queue.ts`, `command-store.ts`, `session-engine.ts` | One deadline, input accounting, admission/serialization, result retention, canonical receipts |
| F2 | `packages/driver/src/connection.ts`, `page-directory.ts`, `owned-connection.ts` | Narrow connection API, page/frame/document identity and owned-CDP adapter |
| Spark P02 | `packages/driver/src/target-resolver.ts` | Fresh target facts, matching, ambiguity and actionability |
| Spark P03–P05 | `packages/driver/src/interaction-executor.ts`, existing `input-dispatcher.ts` | Typed action execution and action-local postconditions |
| Spark P06–P08 | `packages/driver/src/reader.ts`, `reader-records.ts`, `reader-document.ts`, `visual-reader.ts` | Useful scoped views, typed records, document continuation, visual evidence |
| F0/P09 | `apps/mcp-server/src/agent-output.ts`, `mcp-server.ts`, `mcp-contract.ts` | One redaction/budget encoder and a thin tool boundary |
| F3 | `apps/mcp-server/src/browser-runtime/login-source-store.ts`, `login-source-manager.ts`, `process-table.ts` | Source generation publication, cloning ownership, asynchronous process facts |
| F4 | `apps/mcp-server/src/browser-runtime/existing-connection.ts`, `native-wire.ts`, `native-host.ts`, `native-registration.ts` | Optional private transport and stable launch/registration |
| F4 | `apps/tab-adapter/src/background.ts`, `claims.ts`, `wire.ts`; dev-only updater sources | Browser-edge claims, scoped CDP, lifecycle and reload |
| P12/P14 | Existing build, pack, boundary and release scripts | Correctly package and verify the final topology |

These names establish ownership, not a request to create every file immediately. A module
with no real caller must not be added just to satisfy the table. Keep closely related code
together unless size or dependencies justify separation. Do not add an interface for every
private helper, generic dependency-injection container, plugin registry or event bus.

## The old paths that must go

| Existing path/symbol | Final disposition |
| --- | --- |
| `mcp-server.ts::runFillForm` | Delete; a batch is one engine queue item |
| `mcp-server.ts::agentActionEnvelope` outcome inference | Delete; encode the engine's receipt without reclassifying it |
| Host command outcome/idempotency/lifecycle copies in `direct-browser-host.ts` | Move to one engine/command store; retain only host provisioning and session lookup |
| `direct-session-runtime.ts` and `session-command-pump.ts` | Retire after engine integration; no second queue or deadline owner |
| `driver.ts::observeDelta` calls from every action | Delete; local verification plus requested useful read replaces them |
| `driver.ts::waitForSettle` and `settleShort` | Delete unconditional settle behavior; wait on relevant conditions |
| `target-registry.ts::resetObservationRefs` and competing page maps in `driver.ts` | Replace with one page directory and explicit public snapshot eviction |
| `driver.ts::select` page assignment/synthetic events | Replace with trusted input; never copy this implementation |
| Multiple node/text caps in `redaction.ts` and `agent-output.ts` | Replace with structural redaction plus one final text-byte budget |
| Synchronous subprocesses in profile/lease closure | Replace with the bounded asynchronous reader while preserving proof rules |
| Prototype .NET host and fixture extension | Never ship them as the production implementation |

Keep the owned runtime, guardian, profile-store validation, private pipe transport,
input-release mechanics and raster-mask logic unless a specific failing contract requires
change. A refactor is not a license to delete safety or cleanup behavior that already works.

An intermediate development checkout may contain unused old source while migration is
in progress. Each migrated action must have only one reachable runtime path. Record the
temporary residue and its deletion packet. At final cutover there is no old/new mode,
compatibility proxy, legacy fallback or unsupported action secretly routed to `driver.ts`.

## Strict worker rules

- Implement one packet at a time. Do not combine an action change with an unrelated
  schema, queue, packaging or profile refactor.
- Stay inside the packet's write paths. If a defect in a foundation blocks the packet,
  produce its deterministic failing case and exact contract mismatch. Do not invent a
  workaround in the leaf module or modify the shared contract silently.
- No `any`, `Record<string, unknown>` outcome bags, `as unknown as`, `@ts-ignore`, optional
  chaining that turns missing evidence into success, or catch-and-return-empty at semantic
  boundaries. CDP's dynamic edge may remain narrowly typed and validated at consumption.
- Preserve the current strict TypeScript settings. Source executed directly with Node's
  type stripping cannot use parameter properties, enums or other syntax requiring a
  transpilation transform. Test the actual execution path, not only `tsc --noEmit`.
- No `Promise.race` as a substitute for cancellation. No releasing the session lane while
  old executor code can dispatch another input.
- No sleeps to make a page ready. No global network-idle wait, forced focus emulation,
  disabled animations, interception, injected page observer or synthetic DOM events.
- No full AX read for an already-bound target unless a named fallback is necessary and
  measured. No geometry loop over every discovered node by default.
- No hidden cookie/storage inspection, token parsing, profile merge, personal-profile
  copy, clipboard access or authentication synchronization service.
- No changing expected results to accommodate wrong behavior, skipping critical tests,
  accepting any nonempty page as QA, or calling a preexisting release receipt current.
- No fallback to raw page JavaScript, shell, network APIs or another browser product to
  complete an acceptance task that the replacement failed. Record the failure.
- A successful local field value check is not a successful remote save. Say exactly
  which condition was checked.

## Checkpoint protocol for a small-context worker

Create `docs/implementation/EXECUTION_LOG.md` only when execution begins. It is not a
second architecture specification. Update it after each integrated packet with:

```text
Packet: P03
State: implemented / verified / blocked-by-contract-defect
Baseline and changed files: exact paths
Behavior now working: concrete trigger and observed result
Old path removed: exact symbol/path
Tests run: exact commands and exit codes
Live evidence: exact receipt paths, browser build, effect oracle
Known gaps: concrete failures, never "needs polish"
Next packet and prerequisites: exact IDs
```

On resume, read the log, this index and the next packet. Verify Git state and completed
evidence; do not redo the entire audit or announce earlier work as newly completed.

Foundation review is a technical correctness dependency. It is not a recurring user
permission prompt. Once the relevant foundation exists and passes its gates, continue
through the authorized packets without asking the operator after each file or test.

## Suggested later Spark task prompt

This is a prompt to use when a separate task is explicitly created later. Do not send it
to another task as part of writing this plan.

> Work in the supplied Newton Browser checkout using `docs/IMPLEMENTATION_GUIDE.md`.
> Implement its Spark packets in order, preserving the approved design and unrelated
> changes. Read the execution log and verify that each packet's foundation prerequisites
> exist and pass before starting it. Do not design or bypass missing foundations. Do not
> delegate, message other tasks, publish, or change the license. Use the exact receipt,
> ownership, deadline, reader and lifecycle contracts. For each packet, implement its
> behavior, remove its superseded runtime path, run the named negative and live checks,
> and update the execution log with evidence. Continue through ready packets without
> requesting routine approval. If a foundation is missing or defective, record the exact
> failing prerequisite and continue only independent ready work. Never report the first
> release complete until the full verification document passes with no critical gaps.

The next useful work here is F0–F2, beginning with executable contract and regression
oracles. This plan intentionally does not disguise that substantial prerequisite as
something a weaker worker can safely improvise from prose.
