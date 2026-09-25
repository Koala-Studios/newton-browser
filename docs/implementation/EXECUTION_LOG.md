# Foundation execution log

> Status reconciliation, 2026-09-25: this file retains historical implementation/handoff evidence. Current facts and unresolved gates are in [PROGRESS_LEDGER.md](../PROGRESS_LEDGER.md). Default engine cutover and precise editing are now implemented; legacy deletion and full replacement release acceptance are not. Earlier three-pass or completion statements apply only to their narrower historical candidate. No worker instructions here override the current solo-only rule.


Baseline: `f2ae1ee` / 0.6.4. Execution authorized by the operator on 2026-09-07.
Existing audit/design/prototype edits and unrelated `release-verification-win32.json`
are preserved. Work is solo; no other task is contacted.

## Scope and state

| Packet | State | Evidence |
| --- | --- | --- |
| F0 contracts and independent oracles | implemented candidate | core contract tests; live independent field-value oracles |
| F1 execution, records and independent stop | implemented candidate | driver lifecycle tests; live MCP command deduplication |
| F2 page/ref ownership and owned adapter | implemented candidate | Chrome/Edge same-origin and cross-site iframe fill; Wikipedia search field |
| F3 shared source and async closure | implemented candidate | concurrent authenticated isolated browsers; actual publisher crashes; exact transaction recovery |
| F4 extension claims, native wire and update recovery | implemented candidate | packed native host; two independent MCP clients; live update and rollback |

The foundation integration uses the replacement engine through the MCP handler's injected
host seam. The public default cutover and remaining actions/readers belong to Spark's P01–P14;
no public old/new runtime selector or legacy fallback is to be added.

## Authoritative implementation map

- F0: `packages/core/src/command-contract.ts`, `command-json-schema.ts`,
  `receipt-encoding.ts`, `native-packets.ts`. Only `fill` and bounded sequences of fills
  are advertised by the candidate. Receipts separate dispatch, postcondition and observation
  facts. Budget accounting measures escaped UTF-8 MCP result content, not the enclosing
  JSON-RPC request ID envelope. Input text is not retained in command records.
- F1: `packages/driver/src/command-context.ts`, `command-store.ts`, `session-engine.ts`.
  `SessionEngine.submit(raw)` uses monotonic IDs and joins identical duplicates;
  `command(id, cancel?)` remains usable outside the serialized work queue;
  `observe(options)` joins that queue without consuming a mutation ID; `stop()` fences
  input and invokes connection-specific cleanup independently of blocked work.
  Queue admission fixes page identity and starts the deadline. Unreconciled input
  quarantines the session. A timed-out acknowledgement is never permission to replay.
- F2: `page-directory.ts`, `page-executor.ts`, `connection.ts` in the driver.
  The directory alone owns page/frame routes, document generations and public refs.
  A shared executor resolves, inspects, focuses, inserts native text, verifies and reads
  controls for both connections. Inspection is read-only; sensitive fields are refused
  before value access and rechecked after focus. Known frame attachment work is awaited
  under the command deadline. Unknown/incomplete frame scope is not reported as absence.
- Integration: `apps/mcp-server/src/browser-runtime/engine-host.ts`, `engine-mcp.ts`,
  `engine-candidate.ts`. The packed private candidate exports the real MCP handler and
  connection factories. Owned connections reuse the production guardian and private CDP.
  Explicit existing-tab connections detach on stop and preserve the user's browser.
- F3: `login-source.ts`, `profile-copy-worker.ts`, `profile-transaction-recovery.ts`,
  `async-closure.ts`, `process-table.ts` in `browser-runtime`. `LoginSource.open`,
  `clone`, `beginMaintenance`, `publish`, `cancelMaintenance`, `recoverPublication`,
  `collectRetired` are the integration API. Immutable published generations are never
  launched. Forked helpers copy only the existing opaque allowlist; worker copies never
  merge back. Source/store contention waits on filesystem transitions with bounded
  deadlines. Lease capabilities remain live until release succeeds. Exact crash recovery
  uses marked stages and bigint filesystem identity, not imprecise Windows inode numbers.
- F4: `apps/tab-adapter/src/claims.ts` and `worker.ts`; MCP `native-wire.ts`,
  `native-broker.ts`, `existing-connection.ts`, `native-install.ts`, `native-launcher.cjs`,
  `adapter-update.ts`, `adapter-installation.ts`. The browser-launched native host owns a
  private authenticated rendezvous, assigns client identities, and dies with its port.
  Claims reserve tabs before asynchronous debugger attachment. Disconnect, late detach
  and update races are fenced. Updates preserve manifest identity, atomically replace
  code, quiesce claims and prove the new digest; failed verification restores and proves
  the previous digest or returns explicit recovery-required state.

## Verification and evidence

Run root scripts: `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build:mcp`,
`pnpm pack:check`, `pnpm qa:foundation-engine`, `pnpm qa:foundation-source`,
`pnpm qa:foundation-tabs`. Set `NEWTON_BROWSER_FAMILY=edge` for the first two live suites
to exercise Edge. Do not rebuild dist while a live suite is launching its helpers.

Evidence lives in `test/evidence/foundation-engine-{chrome,edge}.json`,
`foundation-source-{chrome,edge}.json`, `foundation-tab-connection.json` and
`foundation-verification.json`. Engine checks use the actual MCP handler and independent
CDP field-value assertions, including same-origin/cross-site iframe fields and a public
Wikipedia search field. Source checks start workers concurrently, authenticate through
ordinary fixture HTTP, and kill actual publisher processes at four publication boundaries.
Tab checks unpack the artifact, install its real native host in a disposable setup, run
two independent clients, test same-tab conflict/stale epoch, and execute real reload and
rollback. Local timings are samples, not a ChatGPT parity benchmark.

## Remaining work and limits — read before P01

1. The default CLI now uses the session engine with no runtime selector or silent fallback.
   The old direct implementation remains only as an injected compatibility/test seam and
   operator-only setup utility; its deletion is intentionally tracked separately.
2. The session engine now covers fill, type, clear, click, select, press, scroll, navigation,
   history, waits, sequences, bounded document reads, screenshots, coordinate clicks,
   structured records/deltas, and rooted multi-frame selector search. Remaining risk is
   broader everyday-page and popup regression coverage, not an unverified action receipt.
3. Source init/status/login-publish/refresh/recover UX is wired through `cli.ts`. Source
   authentication remains reported as unknown; copying is not a promise that every site's
   session remains valid. Recovery removes only proven owned marked stages.
4. Native setup is explicit Windows local setup, never an install hook. The initial SEA
   launcher build requires Node 25.5+ (tested 25.9); ordinary package minimum remains 24.
   The installer now rejects that missing build capability before registration. Broader
   platform/browser installation, packaged launcher delivery and setup UX remain work.
5. No personal profile or installed extension was changed for these checks. Tests use
   disposable identities. Dev-only extension loading switches must not enter production
   owned-browser startup. The extension remains optional; standalone has no extension
   installation dependency.
6. This is foundation verification, not release approval. Full everyday-page QA, all audit
   regressions and three consecutive packed `pnpm release:check` passes remain release
   gates. Do not mark the original audit's old-runtime defects fixed solely from this
   candidate's tests.

Two failed earlier test directories remain in the operator temp directory (suffixes
`8FEhMX` and `iEVuse`). Their test browser processes and native registrations were removed.
Automatic approval review rejected recursive residue cleanup as “blocked by policy”; no
alternate deletion method was used. The unrelated `release-verification-win32.json` was
not modified.

## Spark and Luna adversarial closure

The original adversarial review remains preserved at `C:\DEV\newton-browser\docs\implementation\LUNA_ADVERSARIAL_REVIEW.md` and was not modified. The implementation candidate and independent evidence for its concrete repros are now:

| Finding | Closure | Source and evidence |
| --- | --- | --- |
| Release and real-site gates used the retired direct host | Fixed. Release invokes the packed real-site suite; the suite launches the packed MCP entrypoint over stdio and records `legacyHost: false`. | `scripts/release-complete-local.mjs`, `scripts/smoke/packed-real-sites-live.mjs`, `test/direct-live-config.test.mjs` |
| Native select accepted disabled options | Fixed. Disabled and duplicate matches are rejected and selected value is verified. | `packages/driver/src/page-executor.ts`, `test/engine-regressions/luna-adversarial.test.mjs`, `test/evidence/luna-engine-regression.json` |
| Covered click reported success | Fixed. Hit proof uses the current layout and returns `target_moved` before dispatch when covered. | `packages/driver/src/page-executor.ts`, `test/engine-regressions/luna-adversarial.test.mjs` |
| Wait states returned false success or rejected hidden targets | Fixed. Waits use deadline-bound polling with explicit attached, detached, visible, hidden, checked, unchecked and value semantics. | `packages/driver/src/page-executor.ts`, `test/engine-regressions/luna-adversarial.test.mjs` |
| Back and forward used nonexistent Page methods | Fixed. History uses `Page.getNavigationHistory` and `Page.navigateToHistoryEntry`, with boundary and commit verification. | `packages/driver/src/page-executor.ts`, `test/engine-regressions/luna-adversarial.test.mjs` |
| Empty fill and selection-aware type were incorrect | Fixed. Empty fill deletes the selection; type computes and verifies the selection replacement. | `packages/driver/src/page-executor.ts`, `test/engine-regressions/luna-adversarial.test.mjs` |
| Document output could exceed the final serialized budget | Fixed. Extraction, cache bytes, escaped UTF-8 wrapper sizing and packed Wikipedia document reads are bounded. | `packages/driver/src/page-executor.ts`, `apps/mcp-server/src/engine-mcp.ts`, `scripts/smoke/packed-real-sites-live.mjs` |
| Major packets were absent | Implemented in the current candidate: multi-frame selector search, structured records/deltas, capture-bound `click_at`, source maintenance UX, and public existing-adapter discover/setup status. Popup/page lifecycle is handled through auto-attach and the public page directory. | `packages/driver/src/target-resolver.ts`, `packages/driver/src/session-engine.ts`, `packages/core/src/command-contract.ts`, `apps/mcp-server/src/cli.ts`, `apps/mcp-server/src/engine-mcp.ts` |
| Execution log was stale | Updated with this closure table and current packed evidence. | `docs/implementation/EXECUTION_LOG.md` |

The retired direct runtime source remains in the repository as an injected compatibility/test seam used by the foundation suite and operator-only setup utilities. It is not selected by the shipped default MCP server, the packed catalog, or release acceptance; complete deletion of that compatibility seam is still a separate migration and is not claimed here.

Packed acceptance was completed three consecutive times on Windows for Chrome and Edge. Each pass ran 514 tests, packed catalog validation, packed public-site QA, and packed direct smoke with artifact SHA-256 `8c8c78bb76bb34b3795077910d89f70af93176a01d5c13c025300a1741751be8`. Receipt: `test/evidence/packed-release-three-pass.json`.
