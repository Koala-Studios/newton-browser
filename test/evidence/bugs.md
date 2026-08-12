# Historical extension-era defect ledger

> Archived defect history. Deleted extension/relay paths are not current product surfaces;
> their pass receipts do not close any direct-runtime completion gate.

## BB-048 — Observer focus redundantly mutated an already-active tab

- Minimal repro: retain an owned session for human review, then call the authenticated
  observer focus endpoint while its exact Chrome tab is already active. Chrome rejects
  the unnecessary update with `tabs_cannot_be_edited_right_now_user_may_be_dragging_a_tab_`.
- Root cause: `focusTab` always called `tabs.update({ active: true })`, even when the
  exact target was already active, and focused the window before attempting the tab
  mutation.
- Fix: skip activation for an already-active target, activate before focusing its
  window when activation is needed, and accept a concurrent activation race only when
  a fresh read proves that the exact target became active.
- Regression: focused tab-port tests cover already-active focus, concurrent activation,
  and preservation of genuine focus failures.
- Status: 0.4.5 release gates passed three consecutive times; deployed live-session
  proof pending.

## BB-047 — Approval pauses expired the authenticated persistent host

- Minimal repro: start a persistent MCP host for an approval-gated worker, disconnect
  its MCP client, wait longer than one hour, then resume the worker. The daemon exits
  at the hard one-hour clamp and the running extension no longer owns that host.
- Root cause: `NEWTON_BROWSER_DAEMON_IDLE_MS` was clamped to one hour even though the
  caller explicitly owns daemon cleanup and a human approval pause can legitimately
  exceed one hour.
- Fix: allow an explicit idle window up to 30 days while retaining the 10-second floor,
  one-minute default, empty-session requirement, and explicit shutdown semantics.
- Regression: `persistent MCP idle bounds preserve approval-gated worker continuity`
  verifies the default, floor, seven-day accepted value, and 30-day ceiling.
- Status: 0.4.4 release gates passed three consecutive times; deployed worker proof pending.

All defects below have deterministic regression coverage. Foundation defects BB-001 through BB-009 and BB-011 through BB-012 were fixed in `94de2f0`; BB-006 received its final bounds/fragmentation closure in `0fd3bc8`.

## BB-046 — Global executable symlink bypassed the compiled entrypoint

- Minimal repro: install the 0.4.2 tarball globally, then run `newton-browser --version`
  or `newton-browser --daemon-socket /tmp/newton-browser.sock`; both exit zero without
  output or a socket.
- Root cause: the compiled entrypoint compared `import.meta.url` with the unresolved
  global-bin symlink in `process.argv[1]`, so the main-module guard evaluated false.
- Fix: resolve the executable path through `realpathSync` before comparing URLs.
- Regression: `pack:check` runs the packed entry through a symlinked package path and
  requires the exact package version; deployed Linux QA must also observe a real daemon socket.
- Status: 0.4.3 release gates passed three consecutive times; deployed runtime evidence pending.

## BB-001 — Core declaration build missing type import

- Minimal repro: run `pnpm build:core` after extraction.
- Root cause: `transport.ts` referenced `BrowserFloorDecision` without importing it; runtime type stripping hid the declaration-build failure.
- Fix: import the type explicitly.
- Regression: `pnpm build:core` and `packages/core` declaration output.
- Fix commit: `94de2f0`.
- Status: closed.

## BB-002 — Driver build depended on caller cwd

- Minimal repro: run the driver build through `pnpm --filter @browser-bridge/driver build`.
- Root cause: the copy script derived paths from `process.cwd()`, but filtered workspace scripts execute from the package directory.
- Fix: derive repository paths from `import.meta.url`.
- Regression: `pnpm build`.
- Fix commit: `94de2f0`.
- Status: closed.

## BB-003 — Upgrade socket used an obsolete concrete type

- Minimal repro: compile the MCP server against current Node 24 type definitions.
- Root cause: HTTP upgrade sockets were declared as `net.Socket` although the API contract supplies a `Duplex`.
- Fix: type the stream to the methods actually used.
- Regression: `pnpm typecheck` and `pnpm build:mcp`.
- Fix commit: `94de2f0`.
- Status: closed.

## BB-004 — Owned tabs stole user focus

- Minimal repro: call `createOwnedTab` and inspect the `chrome.tabs.create` input.
- Root cause: the copied implementation set `active: true` to support trusted input, contradicting the owned-tab product invariant.
- Fix: create owned tabs inactive; CDP remains attached directly to the tab.
- Regression: `packages/driver/test/chrome-tabs-port.test.js`.
- Fix commit: `94de2f0`.
- Status: closed; live Chrome and Edge owned-tab focus isolation proved by QA-B6-012 and QA-B6-014.

## BB-005 — Read-only session could bind outside its origin grant after focus change

- Minimal repro: keep an unbound current-tab session granted to one origin, switch focus to another origin, then run external-session reconciliation.
- Root cause: current-tab binding accepted the current active tab without reconciling its live origin, and origin was optional at MCP start.
- Fix: mandatory exact origin, live-origin attachment readiness, bind-time grant check, and per-command live-origin check.
- Regression: `packages/driver/test/controller.test.ts` (focused-tab escape) and `apps/mcp-server/test/host.test.ts` (mandatory origin/readiness).
- Fix commit: `94de2f0`.
- Status: closed.

## BB-006 — Fixed port and bespoke WebSocket framing failed concurrent/large traffic

- Minimal repro: start a second host on the fixed port or send a frame above 65,535 bytes.
- Root cause: one fixed listener plus a handwritten parser with a 16-bit payload ceiling and no authentication.
- Fix: bounded port-range binding, `ws`, HMAC challenge-response, direct pending-session metadata, queue/result bounds, typed collision/disconnect errors, and no wildcard health CORS.
- Regression: `apps/mcp-server/test/host.test.ts` multi-host, auth, and >64 KiB cases.
- Fix commit: `94de2f0`, completed by `0fd3bc8`.
- Status: closed; deterministic coverage plus packed multi-host and real simultaneous-browser ownership evidence passed.

## BB-007 — Packed executable still imported workspace core

- Minimal repro: install the tarball in a clean directory and run `--version`.
- Root cause: esbuild's broad package-external setting excluded the workspace core from the intended self-contained bundle.
- Fix: externalize only `ws`; assert compiled output contains no core package import.
- Regression: `scripts/verify-boundary.mjs` plus both packed clean-install smokes.
- Fix commit: `94de2f0`.
- Status: closed.

## BB-008 — Bundled executable ran an inner entrypoint first

- Minimal repro: run the bundled bin with a fixed test port and probe health.
- Root cause: both `mcp-server.ts` and `index.ts` had direct-execution guards; bundling made the inner guard true and it awaited forever before the CLI entrypoint.
- Fix: make `index.ts` the sole executable boundary.
- Regression: `scripts/smoke/packed-stdio.mjs` fixed-port health and full matrix.
- Fix commit: `94de2f0`.
- Status: closed.

## BB-009 — Malformed JSON-line input changed response framing

- Minimal repro: send `{not-json}\n` after JSON-line initialization.
- Root cause: the parser advanced the buffer before parsing, so the error handler could no longer infer JSON-line mode and emitted a Content-Length frame.
- Fix: parse before consuming the line.
- Regression: `scripts/smoke/packed-stdio.mjs` malformed-frame assertion.
- Fix commit: `94de2f0`.
- Status: closed.

## BB-010 — Clean-install harness walked to a parent package root

- Minimal repro: run `npm install <tarball>` in an empty child directory without its own package manifest.
- Root cause: npm selected the existing parent prefix, so the test was not isolated.
- Fix: immediately uninstall the accidental package, verify it absent, initialize manifests in each temp root, and repeat both installs.
- Regression: QA-B2-002/003 procedure.
- Fix commit: evidence only.
- Status: closed.

## BB-011 — TypeScript parameter property failed Node strip-only source tests

- Minimal repro: import `mcp-server.ts` directly with Node's native TypeScript stripping.
- Root cause: constructor parameter properties require transformation and are unsupported in strip-only mode.
- Fix: declare fields explicitly and assign them in the constructor.
- Regression: `apps/mcp-server/test/host.test.ts` under `node --test`.
- Fix commit: `94de2f0`.
- Status: closed.

## BB-012 — Original package bin was raw TypeScript

- Minimal repro: pack the copied package and invoke its bin from `node_modules`.
- Root cause: the bin pointed to `src/index.ts`, which installed-package Node does not type-strip.
- Fix: self-contained compiled ESM bin at `dist/index.js` with a package file allowlist.
- Regression: boundary check, tar listing, and both clean-install stdio matrices.
- Fix commit: `94de2f0`.
- Status: closed.

## BB-013 — Hidden file inputs were absent from observations

- Minimal repro: observe a page whose only file input is `display:none`.
- Root cause: the AX observation path intentionally discarded non-laid-out nodes, leaving no fresh ref for the hidden-input contract.
- Fix: append exact DOM-discovered file inputs to observations, retaining a stable backend-node ref while omitting a bbox for hidden inputs.
- Regression: `packages/driver/test/driver.test.js` hidden file-input observation and fresh-ref enforcement.
- Fix commit: `e25893a`.
- Status: closed; live Chrome and Edge file-input acceptance proved by QA-B6-012.

## BB-014 — Extension ZIP writer emitted a signed external-attributes value

- Minimal repro: run the first deterministic ZIP build with a Unix mode shifted into the high 16 bits.
- Root cause: JavaScript bitwise shift produced a signed 32-bit number, which `Buffer.writeUInt32LE` rejects.
- Fix: convert the shifted mode to unsigned before writing the central-directory record.
- Regression: deterministic rebuild plus archive listing in `pnpm smoke:matrix`.
- Fix commit: `56e169b`.
- Status: closed.

## BB-015 — Filtered package command did not accept the pack destination

- Minimal repro: invoke the first `pnpm --filter ... pack --pack-destination` harness.
- Root cause: the filtered recursive command path forwarded an unsupported recursive option to this pnpm version.
- Fix: execute `pnpm pack` from the package directory and inspect the resulting exact artifact.
- Regression: `pnpm pack:check`.
- Fix commit: `56e169b`.
- Status: closed.

## BB-016 — Codex could not initialize the packed MCP server

- Minimal repro: launch Codex CLI 0.144.0 with the 0.3.0 packed server.
- Root cause: the supported protocol list skipped finalized revision `2025-06-18`, which current Codex requested.
- Fix: support and test all four relevant revisions: 2024-11-05, 2025-03-26, 2025-06-18, and 2025-11-25.
- Regression: source negotiation test, packed stdio matrix, and actual Codex initialization.
- Fix commit: `73218dc`.
- Status: closed.

## BB-017 — Noninteractive Codex cancelled QA MCP tools

- Minimal repro: run `codex exec` with an MCP server whose default tool approval mode still prompts.
- Root cause: noninteractive execution cannot answer an MCP approval prompt, so the client cancelled otherwise safe QA calls.
- Fix: the real-client harness sets `default_tools_approval_mode="approve"` for only the temporary QA server and only for that process; the Browser Bridge floor remains active.
- Regression: actual Codex reached typed `extension_disconnected` rather than tool cancellation.
- Fix commit: `73218dc`.
- Status: closed.

## BB-018 — Doctor reported pairing but omitted required diagnostics

- Minimal repro: run the original `--doctor` and inspect its JSON.
- Root cause: the utility created a pairing secret but did not check Node support, host-policy config, bounded loopback capacity/incumbents, protocol compatibility, extension connection state, or a typed next action.
- Fix: add a complete diagnostic report and a loopback-only HMAC-authenticated incumbent-status endpoint with no permissive CORS.
- Regression: `apps/mcp-server/test/cli.test.ts`, authenticated/denied endpoint tests, packed matrix, and isolated-user smoke.
- Fix commit: `a304a26`.
- Status: closed.

## BB-019 — Port collision exited before MCP could return a typed error

- Minimal repro: occupy the configured host port and launch the stdio executable.
- Root cause: startup awaited `listen()` before installing the MCP frame pump, so `host_collision` rejected the process instead of becoming a tool result.
- Fix: retain a degraded MCP session after a collision; initialize and tools/list work, while tool calls return typed `host_collision` and an actionable next step.
- Regression: occupied-port stdio process test verifies a clean exit after stdin closes.
- Fix commit: `a304a26`.
- Status: closed.

## BB-020 — Packed readiness probe orphaned its MCP child

- Minimal repro: run `pnpm smoke:extension-ready`, then inspect port 17321 after the probe exits.
- Root cause: terminating the `npx` wrapper did not terminate its spawned `browser-bridge-mcp` process on Windows.
- Fix: capture the exit listener before closing stdin and terminate the complete Windows process tree on the bounded fallback path.
- Regression: repeated readiness trials verify every next host can bind the same port; final 10/10 batch left no listener.
- Fix commit: `e2bd5f4`.
- Status: closed.

## BB-021 — Chrome pending navigation failed the owned-tab origin check

- Minimal repro: create an inactive owned Chrome tab and reconcile its origin immediately after `chrome.tabs.create`.
- Root cause: Chrome can expose the authorized destination in `pendingUrl` while `url` is still `about:blank`; the controller checked only `url` and closed the valid tab.
- Fix: prefer a valid `pendingUrl` origin, then fall back to `url`.
- Regression: `packages/driver/test/controller.test.ts` plus real Chrome session attachment.
- Fix commit: `e2bd5f4`.
- Status: closed.

## BB-022 — Root-only accessibility reads omitted same-origin iframes

- Minimal repro: observe the fixture containing same-origin and cross-origin frames.
- Root cause: `Accessibility.getFullAXTree` was called only for the root frame.
- Fix: enumerate the frame tree, request AX trees only for same-origin child branches, and use page-coordinate CDP quads for targeting.
- Regression: driver frame/filter/coordinate tests and repeated real Chrome batches; the cross-origin target remained absent.
- Fix commit: `48ce75e`.
- Status: closed.

## BB-023 — CDP page hit tests could disagree with ordinary DOM hit testing

- Minimal repro: resolve a main-frame target whose CDP location hit returns a neighboring or descendant node.
- Root cause: the frame-safe CDP hit test had no fallback to the previously proven DOM containment check.
- Fix: retain CDP page-coordinate hit testing first, then use the scoped runtime containment check when CDP does not prove the target.
- Regression: `packages/driver/test/driver.test.js` fallback ordering test and live main-frame clicks.
- Fix commit: `d752011`.
- Status: closed.

## BB-024 — Chrome delivered scroll without acknowledging the wheel command

- Minimal repro: run the full inactive-tab fixture sequence through hover and scroll.
- Root cause: `Input.dispatchMouseEvent(mouseWheel)` could change scroll state while its debugger callback never returned, causing a generic 20-second CDP timeout.
- Fix: bound wheel acknowledgement separately and reconcile the actual `window.scrollY` state before deciding the result.
- Regression: driver dropped-acknowledgement test and repeated real Chrome scroll phases.
- Fix commit: `c7c210a`.
- Status: closed.

## BB-025 — Inactive Chrome tabs intermittently dropped press/release input

- Minimal repro: keep using another Chrome tab while the owned fixture tab dispatches Increment and Network write clicks.
- Root cause: Chrome accepted pointer movement but dropped mouse-button and keyboard activation events for the inactive page. Fixture tracing repeatedly showed only `mousemove` at the correct target and coordinates.
- Fix: enable `Emulation.setFocusEmulationEnabled` for the attached debugger target and disable it on detach. This simulates a focused and active page without activating the visible tab.
- Regression: focused attach/detach test plus three consecutive full live Chrome batches (69/69 phases) while the user used other tabs.
- Fix commit: `d7adab1`.
- Status: closed.

## BB-026 — Live file-input assertion did not normalize accessible-name whitespace

- Minimal repro: observe Chrome's file input name `Creative assets ` and compare it literally with `Creative assets`.
- Root cause: the QA harness skipped the normalization already used by its general accessible-name checks.
- Fix: trim the browser-supplied name before selecting the file input.
- Regression: repeated live acceptance of PNG/JPEG/WebP/GIF/MP4/WebM with sanitized names and no submit.
- Fix commit: `32471ed`.
- Status: closed.

## BB-027 — Cold-start probe conflated tarball startup with MCP response latency

- Minimal repro: run ten fresh exact-tarball readiness probes against a cold npm cache.
- Root cause: initialization had the same 10-second response bound as an already-running MCP call, so `npx` extraction and startup could be aborted before initialize returned.
- Fix: give packed process initialization a distinct 30-second budget while retaining the 10-second per-status response bound.
- Regression: corrected 10/10 trial batch; min 1.925s, median 15.566s, mean 12.136s, max 22.082s.
- Fix commit: evidence batch commit following `d7adab1`.
- Status: closed.

## BB-028 — Claude stopped at diagnostic status before exercising readiness wait

- Minimal repro: launch Codex and Claude concurrently; the second host initially reports `extension_disconnected` before the extension's next discovery cycle.
- Root cause: the QA prompt treated `browser.status` as a terminal prerequisite even though `browser.session.start` owns the bounded cold-discovery wait.
- Fix: require both clients to call session start after one diagnostic status call and collect both client outcomes with `Promise.allSettled`.
- Regression: actual concurrent Codex 0.144.0 and Claude Code 2.1.201 completed and finalized separate packed sessions.
- Fix commit: evidence batch commit following `d7adab1`.
- Status: closed.

## BB-029 — Simultaneous Chrome and Edge could both control one session

- Minimal repro: keep the unpacked extension enabled in Chrome and Edge, start one host session, and let both service workers reconcile the broadcast session list.
- Root cause: the host authenticated multiple extension sockets but had no per-session owner. It broadcast session setup and commands to every subscribing socket, so both browsers could race to create/attach tabs and could execute the same command.
- Fix: each browser profile announces a stable local identity and browser family; the host atomically claims every session for exactly one eligible socket, routes commands/results only to that owner, denies standby mutation, fails in-flight work closed on owner loss, and clears browser-local tab identifiers before safe standby takeover. Optional `browserTarget` selects Chrome or Edge while leaving both extensions enabled.
- Regression: paired-host dual-browser tests prove exactly one claim, zero standby commands, denied standby attach, safe takeover, and explicit Edge selection. Two real simultaneous-browser suites proved `connectedBrowsers:["chrome","edge"]`, one session owner, 25/25 steps, real files, screenshots, sensitive-field blocks, and clean teardown in both explicit-Edge and default-auto modes.
- Fix commit: `2faf97a`.
- Status: closed.

## BB-030 — Extension reload created a duplicate owned tab

- Minimal repro: reload the selected Edge unpacked extension while a command is in flight, then let the new service worker reconcile the still-live host session.
- Root cause: owned binding records lived in `chrome.storage.session`, which survives worker suspension but is cleared by a full developer/update reload.
- Fix: persist the non-secret session/tab/group/origin binding in extension-local storage, reclaim a valid prior tab, and clean stale records/tabs after the host grace window.
- Regression: controller/extension tests plus real mid-command Edge reload reclaimed tab `159963340` exactly and completed a follow-up observation.
- Fix commit: `305bd51`.
- Status: closed.

## BB-031 — An allowed URL could redirect outside the origin grant

- Minimal repro: navigate to an allowed same-origin endpoint that returns a cross-origin redirect.
- Root cause: the controller checked the live origin before dispatch but not after the driver completed navigation.
- Fix: re-read the live tab origin after every action; return `origin_not_granted`, finalize, and stop the owned session if it escaped.
- Regression: controller redirect test and real `/redirect-cross` fixture session.
- Fix commit: `305bd51`.
- Status: closed.

## BB-032 — Ambiguous targets silently selected the first element

- Minimal repro: expose two file inputs with the same accessible name or two DOM nodes matching one selector.
- Root cause: target resolvers used `find`/`querySelector`, turning ambiguity into an implicit first-match action.
- Fix: enumerate and reject multiple AX, selector, label, placeholder, test-id, and visible-text matches with typed `ambiguous`.
- Regression: driver ambiguity tests and two real `Ambiguous asset` file inputs.
- Fix commit: `305bd51`.
- Status: closed.

## BB-033 — A target could move after pointer entry but before press

- Minimal repro: move a button in its `mousemove` handler after the driver completed its stable-box check.
- Root cause: the driver hit-tested during actionability but did not revalidate the exact press point after dispatching pointer movement.
- Fix: perform a second containment hit-test after `mouseMoved` and return `stale_target` / `target_moved` without pressing when the target vacates the point.
- Regression: focused driver test and real Chrome/Edge moving-target phase.
- Fix commit: `305bd51`.
- Status: closed.

## BB-034 — General-purpose distribution retained identity-specific coupling

- Minimal repro: scan source, tests, documentation, evidence, and skill assets for personal, organization, or unrelated platform terminology; inspect the default host-policy collection.
- Root cause: extraction preserved a vendor-specific default host manifest and identity-specific examples even though the product boundary was intended to be general-purpose.
- Fix: ship no vendor-specific host-policy defaults, preserve the generic configurable policy engine and structural floor, neutralize examples and redaction identifiers, and strengthen the skill's routing, recovery, sign-in handoff, safety, and browser-choice rules.
- Regression: `scripts/verify-boundary.mjs` now rejects identity-specific coupling and product-name drift; the full standalone suite, build, packed install, and skill validator pass.
- Fix commit: `0fb12d7`.
- Status: closed.

## BB-035 — Observation redaction was never wired into the result path

- Minimal repro: run any `browser.observe`/`browser.act` that returns accessible values or `mode:"text"` page text containing a card/SSN sequence; observe the client-facing JSON.
- Root cause: `redactBrowserResult` (and the whole secret/PII redaction layer) was exported and unit-tested but never invoked in the live pipeline. The driver populated `node.value` from the accessibility tree and returned full page innerText raw; neither the extension nor the host called redaction, so sensitive values reached the MCP client (the model) unredacted. The driver comment claimed "secret-redacted host-side by redactBrowserResult" but no such call existed.
- Fix: wire `redactBrowserResult` into the host result path (`redactObservationResult` in `mcp-server.ts`) for `observation`, `observation_delta`, and `observation_text` results, before they reach the client. Guarded so non-observation control results (finalize acks, transport test shapes) pass through untouched. The host is the exfiltration boundary; the loopback relay stays same-machine/same-user.
- Regression: `apps/mcp-server/test/host.test.ts` — "observation results are secret-redacted before reaching the MCP client" and "mode:text observations mask card/SSN sequences before reaching the client" drive a real MCP tool call through a live fake extension and assert masking end to end.
- Status: closed; QA-LIVE-001 and the final packed release gate proved host-side redaction in the shipped path.

## BB-036 — Result redaction dropped the set_files changed.files delta

- Minimal repro: run a `set_files` action and read `result.changed.files` (exercised by `scripts/smoke/packed-stdio.mjs`).
- Root cause: wiring host-side redaction (BB-035) routed act results through `redactBrowserChanged`, which only preserved boolean/number/string delta values and silently dropped any array/object — so the `files` array (sanitized upload basenames) vanished, and `changed.files[0].filename` became undefined.
- Fix: `redactBrowserChanged` now preserves a `files` delta as `{ filename }` entries (basename only, redacted; absolute paths never surface).
- Regression: `packages/core/test/control-contract.test.ts` — "a set_files delta keeps sanitized filenames through result redaction"; plus the existing packed-stdio smoke assertion.
- Status: closed.

## BB-037 — CI/release gates typechecked before building core

- Minimal repro: clean checkout → `pnpm install --frozen-lockfile` → `pnpm typecheck` (or `pnpm pack:check`).
- Root cause: `@newton-browser/core` resolves its type declarations and runtime entry from `dist` (package `exports`/`types`), but the CI validation job, `release-check.mjs`, and `pack-check.mjs` all ran `typecheck`/`test`/`build:mcp` before the workspace (core) was built. It passed locally only because developers had a warm `dist`. The first real CI run surfaced it: typecheck failed with `TS2307: Cannot find module '@newton-browser/core'`, and `build:mcp` failed in esbuild resolving core.
- Fix: run `build` (and, in pack-check, `build:core`) before any step that consumes core's dist — CI validation order, `release-check.mjs` stage order, and `pack-check.mjs`.
- Regression: reproduced fix in a clean clone — build→lint→typecheck→test (128/128) and `pack:check` both green. The CI run on the fix commit is the live regression check.
- Status: closed (CI green on 7aa57d2).

## BB-038 — Packed gates resolved node's npm/npx CLI at a Windows-only path

- Minimal repro: run `pnpm pack:check` (or `release:check`) on Linux/macOS.
- Root cause: pack-check.mjs and the clean-user/matrix/multi-client/extension-readiness smoke scripts located node's bundled npm/npx as `<dirname(node)>/node_modules/npm/bin/*-cli.js`. That path is correct only on Windows (npm beside node.exe); on Linux/macOS node lives in `bin/` and npm in `../lib/node_modules/npm`, so the spawn failed with an ENOENT and the gate errored. It passed locally on Windows and only surfaced on Linux CI.
- Fix: a `nodeCli(name)` resolver in each script checks both the Windows and POSIX candidate locations and uses whichever exists.
- Regression: pack:check green on Windows after the change; Linux CI on the fix commit is the cross-platform regression check.
- Status: closed (CI green on 7aa57d2).

## BB-039 — Release matrix asserted npx tarball output was exactly the version

- Minimal repro: `pnpm smoke:matrix` on Linux CI (release:check stage).
- Root cause: the matrix smoke ran `npx --yes --package <tarball> newton-browser --version` and asserted stdout equalled the version. Some npm builds (Linux CI runner) intercept a bare `--version` as npx's own flag and never forward it to the bin, so stdout was empty (npx exited 0). It happened to forward correctly on the local Windows npm build. A CI diagnostic confirmed `stdout: ""`.
- Fix: exercise the packed bin through npx with `--print-config generic` (unambiguous, not an npx flag) and assert the emitted config is version-pinned; surface stdout on failure. pack:check remains the authoritative tarball-execution gate (it installs via npm and runs the bin via node, green on Linux Node 20/22/24).
- Regression: `smoke:matrix` green on Windows; Linux CI on the fix commit confirms.
- Status: closed (CI green on 7aa57d2).

## BB-040 — Release smoke read ZIPs with `tar`, which GNU tar rejects on Linux

- Minimal repro: `pnpm smoke:matrix` / `pnpm smoke:clean-user` on Linux (release:check).
- Root cause: matrix.mjs listed the extension ZIP with `tar -tf`, and clean-user.mjs extracted it with `tar -xf`. bsdtar (Windows/macOS) reads ZIPs, but GNU tar (Linux runner) does not — it fails with "This does not look like a tar archive". Passed locally on Windows.
- Fix: replace both with a dependency-free Node ZIP central-directory reader (`zipEntryNames`) and assert the expected entries are present. No external archive tool involved.
- Regression: both smokes green on Windows after the change; Linux CI on the fix commit confirms.
- Status: closed (CI green on 7aa57d2).

## BB-041 — Release ledger reintroduced an unrelated product name

- Minimal repro: commit the release-progress ledger containing the external plugin/cache note, then run `pnpm lint` or CI from a clean checkout.
- Root cause: the progress ledger recorded implementation history from an unrelated product repository. The standalone boundary correctly rejects that identity-specific term. The pre-commit local gate was run before the note became part of the committed-file scan, while CI evaluated the clean committed tree and failed consistently on Linux and Windows.
- Fix: remove the unrelated repository/cache note and describe only the standalone skill's authoritative distribution state.
- Regression: the existing `scripts/verify-boundary.mjs` committed-file scan deterministically reproduces the failure and passes after the note is removed; CI run 29157179006 is the failing evidence and the next main-branch CI run is the cross-platform closure check.
- Status: closed; CI run 29157320734 passed after the boundary correction.

## BB-042 — Stress RSS baseline included runtime warmup allocation

- Minimal repro: run the tagged `v0.4.0` release workflow on the hosted Linux Node 24 runner; the five-minute workload completed more than three million operations with zero cross-session results or deadlocks, but reported 111,284,224 bytes of RSS growth against the 100,663,296-byte ceiling.
- Root cause: the harness sampled its RSS baseline immediately after session setup, before exercising the steady-state dispatch path. JIT compilation, WebSocket/runtime initialization, and allocator arena growth during the first measured operations were therefore classified as five-minute retained growth. Repeated local release gates passed because their runtime/allocator warm state differed, making the baseline environment-sensitive rather than a stable leak measurement.
- Fix: exercise both workers for 30 seconds before forcing GC and recording the RSS baseline; keep the measured five-minute workload and the original 96 MiB ceiling unchanged. Report warmup operations and label the baseline explicitly.
- Regression: `test/fixtures/stress-warmup.test.ts` runs the real stress harness with short bounded phases and asserts that both workers execute warmup operations before a `post_warmup` RSS baseline and measured operations.
- Status: closed; protected release run 29159340143 measured 13,266,944 bytes of post-warmup RSS growth against the unchanged 96 MiB limit.

## BB-043 — Stress child timeout excluded the new warmup phase

- Minimal repro: run release workflow 29159033955 after BB-042; the stress child reaches the end of its five-minute measurement but `spawnSync` terminates it with `ETIMEDOUT` at 330 seconds.
- Root cause: `chaos.mjs` budgeted `measurement + 30 seconds`. BB-042 added a 30-second exercised warmup without adding it to the parent timeout, leaving no shutdown/reporting headroom.
- Fix: calculate the child timeout as `measurement + warmup + 30 seconds`, retaining the existing 120-second minimum for short diagnostic runs.
- Regression: `test/fixtures/stress-timing.test.ts` verifies default, configured, and short-run timeout budgets through the same exported calculator used by the chaos harness.
- Status: closed; protected release run 29159340143 completed the full warmup, measurement, reporting, and release workflow successfully.

## BB-044 — Registry namespace casing disagreed with immutable npm ownership metadata

- Minimal repro: authenticate `mcp-publisher` with the public `Koala-Studios` organization membership and publish `io.github.koala-studios/newton-browser` from `newton-browser@0.4.0`; the Registry grants `io.github.Koala-Studios/*` and rejects the lowercase identifier. Changing only `server.json` then fails npm ownership validation because the published package contains the lowercase `mcpName`.
- Root cause: release metadata normalized the GitHub organization to lowercase, while the official Registry's open issue #689 documents case-sensitive GitHub namespace authorization using the account's canonical display casing. npm package contents are immutable after publication, so 0.4.0 cannot be corrected in place.
- Fix: release 0.4.1 with `io.github.Koala-Studios/newton-browser` in both `server.json` and npm package metadata, preserving the exact GitHub owner casing.
- Regression: `apps/mcp-server/test/registry-metadata.test.ts` and `scripts/verify-boundary.mjs` require exact server/package name and version agreement and derive the required namespace prefix from the canonical repository owner casing.
- Evidence: official Registry issue #689 and the rejected 403/400 publisher responses recorded in `test/evidence/discovery-ledger.md`.
- Status: closed; fixed in public npm 0.4.1 and verified in the active official Registry record.

## BB-045 — Partial release retries could not reconcile an existing GitHub Release

- Minimal repro: push `v0.4.1`; allow the protected workflow to pass all verification and create the GitHub Release, then let npm publication fail authorization. Re-running the job executes `gh release create` again before reaching the idempotent npm check.
- Root cause: npm publication was idempotent, but GitHub Release creation was not. The workflow also published from the workspace through pnpm instead of explicitly selecting the tarball already proved by `pack:check`.
- Fix: reconcile an existing release by editing its notes and uploading verified assets with `--clobber`; publish the exact versioned artifact through npm using an explicit `./artifacts/` filesystem path.
- Regression: `test/fixtures/release-workflow.test.ts` asserts the existing-release branch, clobber upload, and exact tarball publication path.
- Evidence: GitHub Actions run 29178530777 reproduced the partial release. Tag-targeted recovery run 29182201160 on commit `114be08` passed all 11 release stages, reconciled the existing v0.4.1 release assets, and correctly skipped npm because 0.4.1 was already public.
- Status: closed; the manual `workflow_dispatch` recovery path is verified on the affected v0.4.1 release.

## BB-049 — Same-session commands could execute concurrently

- Minimal repro: dispatch two mutating commands to one subscribed session before the first controller callback settles; the old relay sent both and the controller invoked both callbacks directly.
- Root cause: global pending limits existed, but neither relay nor controller had a per-session in-flight owner, FIFO queue, or closing barrier. The driver therefore shared command-local reconciliation state across overlapping mutations.
- Fix: add bounded per-session host queues and controller `SessionCommandPump` instances, preserve concurrency between distinct sessions, and make finalization close queued work before cleanup.
- Regression: `apps/mcp-server/test/host.test.ts` proves FIFO within a session, concurrency across sessions, item/byte caps, and terminal release of the next command; `packages/driver/test/controller.test.ts` and `packages/driver/test/session-command-pump.test.js` independently prove the same execution and finalize invariants; `scripts/smoke/stress.mjs` now fails on any same-session overlap.
- Evidence: root `pnpm test` on 2026-08-09 passed 279/279 runnable tests; a bounded stress run completed 1,674 measured operations with zero same-session overlaps, cross-session result leaks, or deadlocks.
- Status: source regression closed; packed/live AIP-01 release evidence remains pending.

## BB-050 — Command timeouts could not state whether retry was safe

- Minimal repro: time out one command while it is still queued and another after it has been sent; the former host path returned one generic timeout and deleted pending identity, so a caller could not distinguish a safe retry from a possibly executed mutation.
- Root cause: relay commands lacked epochs/sequences and the host had no sent-state ledger, late-result tombstone, or idempotency generation guard.
- Fix: return host-owned `sessionEpoch`, `sequence`, `outcome`, and `retrySafe`; retain bounded late-result identity; accept a late terminal result only for its exact generation; add the bounded per-session idempotency ledger and public `browser.act.idempotencyKey`.
- Regression: host tests cover queued `not_started`, sent `outcome_unknown`, late completion, stale epochs/sequences, dedupe/conflict/TTL/cap behavior, and the case where a late old generation attempts to overwrite a newer ledger entry. The public MCP regression proves duplicate dispatch occurs once and conflicting reuse is prevented.
- Status: source regression closed; packed/live AIP-01 release evidence remains pending.

## BB-051 — Owner replacement could preserve stale authority

- Minimal repro: attach two eligible browser clients to one logical session, replace or disconnect the owner, then submit a result from the former owner or reuse attachment state for a different logical identity.
- Root cause: owner transfer and attachment continuity were not fenced by the same session generation contract, so stale result authority and stale tab binding could outlive the owner that established them.
- Fix: fence result acceptance by owner plus epoch/sequence, retain attachment continuity only for the same logical owner identity, and clear it when identity changes.
- Regression: `apps/mcp-server/test/host.test.ts` proves atomic claiming, non-owner rejection, old-owner fencing, same-identity continuity, and different-identity binding removal.
- Status: source regression closed; lifecycle failure-matrix and live restart evidence continue under AIP-02.

## BB-052 — MCP sources bypassed the core package boundary

- Minimal repro: run `pnpm boundary:check` after the reviewed output/idempotency integration; it reports `MCP server contains a cross-package relative source escape`.
- Root cause: two implementation slices imported core source files by relative filesystem path instead of consuming the public `@newton-browser/core` export, making packed resolution depend on workspace layout.
- Fix: import redaction, protocol, and idempotency validation through the compiled core package entrypoint.
- Regression: the existing standalone boundary scanner rejects cross-package source escapes; `pnpm lint`, `pnpm typecheck`, and the complete source suite pass after correction.
- Status: closed before the affected integration slice was accepted.

## BB-053 — Equal command deadlines made a queue test scheduling-dependent

- Minimal repro: run the complete host suite under contention with the sent command and its queued successor both configured with a 120 ms deadline; the first timer can release and send the successor immediately before the successor's own timer fires.
- Root cause: the test assumed equal wall-clock deadlines prove the second command remained queued. The implementation legitimately transitioned it to sent state first, changing the honest result from `not_started` to `outcome_unknown`.
- Fix: make the queued command's independent deadline earlier than the running command's deadline (100 ms versus 150 ms), preserving the production timeout bounds and avoiding a sleep or widened timeout.
- Regression: the focused case and complete host/root suites pass deterministically with the queued command still unstarted at its deadline.
- Fix commit: `d89543b`.
- Status: closed.

## BB-054 — Fragmented input paths could emit incomplete keys and leave pressed state

- Minimal repro: use `press` with a chord or fail a click after `mousePressed`; the old driver emitted only `{type,key}` key events and had no owner that guaranteed a matching key/button release.
- Root cause: key, text, mouse, and wheel commands were implemented inline in separate driver methods with no shared descriptor table or pressed-state cleanup contract.
- Fix: route every CDP input event through `InputDispatcher`, use complete tested descriptors, use `Input.insertText` for printable Unicode, suppress char events for control/meta/alt chords, and release buttons/modifiers in `finally` without overwriting an already uncertain primary failure.
- Regression: `packages/driver/test/input-dispatcher.test.js` covers Unicode/newline text, named/function/printable descriptors, chords, wheel routing, failure cleanup, cleanup diagnostics, and state-driven idle.
- Fix commit: `db62f04`.
- Status: source regression closed; live key-event fixture evidence remains pending under AIP-05.

## BB-055 — Dialog and debugger recovery were not target-scoped or state-driven

- Minimal repro: open a dialog in one flattened child session while another target is receiving input, or detach the debugger during a target swap. The old driver kept one global dialog flag and the controller retried attachment after fixed 250/500/750 ms delays.
- Root cause: dialog correlation did not include target/session identity, input was not subscribed before dispatch, and renderer lifecycle was represented by booleans plus a timer loop.
- Fix: add bounded target-scoped dialog races, retain multiple pending dialogs safely, wait for dispatcher idle after handling, add the explicit renderer-liveness machine, classify discard/conflict/gone/unresponsive states, and retry attachment only from detach/tab events with a strict attempt cap. Current-tab recovery performs no focus/reload/navigation.
- Regression: input, liveness, driver, and controller tests prove cross-target isolation, cleanup after dialog races, event-driven reconciliation, conflict classification, discarded-tab classification, and no current-tab mutation.
- Fix commit: `db62f04`.
- Status: source regression closed; real dialog/discard/rebind evidence remains pending under AIP-05.

## BB-056 — Invalid selectors and text-only changes were misclassified

- Minimal repro: act or wait with selector `]`, or wait for a page that changes only a text node/input value. Selector errors were caught as target absence or a wait timeout, while settling compared URL and element counts that did not change.
- Root cause: `DOM.querySelectorAll`/Runtime exceptions were swallowed, and the settle fingerprint observed structure rather than the relevant document state.
- Fix: validate selectors before execution and preserve typed `invalid_selector`; settle on a document mutation/input revision plus bounded network-quiet state, with polling only for the actual state transition.
- Regression: driver and controller tests prove zero input dispatch for invalid syntax, preflight before a wait loop, exact error propagation, and a MutationObserver/input-based fingerprint with no element-count proxy.
- Fix commit: `db62f04`.
- Status: source regression closed; live asynchronous text/value fixture evidence remains pending under AIP-05/AIP-06.

## BB-057 — Extension builds omitted extracted driver runtime imports

- Minimal repro: build the extension after the command-pump/target-registry extraction, then resolve `driver.js` and `controller.js` relative imports from `apps/extension/dist`; the imported support modules are absent.
- Root cause: `scripts/build-extension.mjs` copied a historical fixed list containing only `driver.js`, `controller.js`, and `chrome-tabs-port.js`. Source tests imported directly from the workspace and therefore could not detect the packed module-closure break.
- Fix: copy every explicit driver runtime module and traverse the generated service worker's complete relative-import closure in the extension regression.
- Regression: `apps/extension/test/extension.test.ts` builds the standalone extension, asserts all support modules, and fails on any missing transitive relative import; the complete `pnpm build` and `pnpm test` pass.
- Fix commit: `db62f04`.
- Status: closed.

## BB-058 - Token-efficient projection existed only in isolated tests

- Minimal repro: call `browser.observe` after the initial projection foundation; the MCP server returned the original verbose redacted observation and `browser.act` repeated action status, decision, nested result, origin, and command metadata.
- Root cause: `agent-output.ts` and its fixture suite were implemented as pure prototypes but were never imported by the production MCP server, so their passing tests did not describe agent-visible output.
- Fix: route public observations through redaction, filtering, deterministic projection, and budget metadata; default to compact/no geometry; normalize action results; add compact status and optional observe-on-start; enrich the retained internal model rather than deleting evidence.
- Regression: MCP host tests exercise default compact output, explicit JSON compatibility, redaction, public outcome sequencing, strict schemas, and observe-on-start. Driver/projection tests cover AX state, provenance, same-origin links, hostile text escaping, and zero-write interactive discovery.
- Status: source regression closed; packed/client evidence remains pending under AIP-06/AIP-09.

## BB-059 - Pinned tokenizer counts were mislabeled as heuristic

- Minimal repro: run `node scripts/measure-agent-cost.mjs --json` with the pinned local counter. Counts were exact, but metadata origin `local` failed an `origin === "injected"` check, so every budget remained deferred.
- Root cause: exactness was inferred from the counter's provenance label instead of the measurement method; function-valued counter metadata was also excluded by an object-only guard.
- Fix: classify exact measurements by `method === "token_counter"`, accept bounded metadata on function counters, and measure the serialized public MCP envelopes plus the live tool catalog with pinned `js-tiktoken@1.0.21` `o200k_base`.
- Regression: the budget script reports zero failures/deferred cases with catalog 1,369, compact 347, lean JSON 376, fill 32, click 32, and workflow 688 tokens against the approved ceilings.
- Status: closed.

## BB-060 - Malformed actions could survive catalog/runtime drift

- Minimal repro: send an unknown kind, misspelled property, malformed composite ref, invalid enum, or nested unknown field to `browser.act` and inspect whether a bridge command is emitted.
- Root cause: action parsing and the published schema were separately maintained and permissive normalization could repair or reinterpret invalid input.
- Fix: generate the public variant/required metadata and strict runtime allowlists from the same canonical tables; reject invalid input as `invalid_arguments` before floor or bridge dispatch.
- Regression: parity covers every action kind and focused host tests prove representative invalid payloads emit no bridge command.
- Status: source regression closed; packed initialization/contract proof pending under AIP-07/AIP-09.

## BB-061 - Encoded response bodies could bypass text redaction

- Minimal repro: return a legacy or compromised network result with `body.base64Encoded:true` and secret-bearing `data`; text-oriented redaction previously treated the encoded value as ordinary text.
- Root cause: the public body shape allowed encoded payloads without a mandatory decode/MIME decision, and the host boundary did not independently refuse opaque legacy shapes.
- Fix: the driver returns only supported UTF-8 text; base64, binary, malformed, compressed, and ungranted bodies are null with a typed disposition and allowlisted digest metadata. The host repeats the refusal for legacy/compromised payloads.
- Regression: the checked-in opaque-body fixture and driver/core tests prove raw payload absence; allowed text still receives card/identifier masking.
- Status: source regression closed; packed network proof pending under AIP-07/AIP-09.

## BB-062 - Screenshot mask application was ambiguous

- Minimal repro: request a screenshot and infer from an omitted field whether no policy existed, masking succeeded, or configured masking failed.
- Root cause: mask application had no mandatory public disposition and the masking helper did not propagate failure to capture.
- Fix: every screenshot returns a typed mask disposition; configured zones must return successful mask application before capture, otherwise `mask_application_failed` aborts the screenshot.
- Regression: driver tests cover no configuration, applied masks, and mask failure; core redaction covers all three public dispositions and a safe default.
- Status: source regression closed; live screenshot evidence pending under AIP-07/AIP-09.

## BB-063 - Default screenshot generation violated the new strict action contract

- Minimal repro: call packed `browser.screenshot` without `device`; the host generated an action containing the property `device: undefined`, and strict parsing rejected it before image capture.
- Root cause: the dedicated-tool adapter materialized an absent optional field instead of omitting it. Focused action tests did not exercise the dedicated screenshot tool's default adapter.
- Fix: conditionally add `device` only for the two accepted values and extend both host and installed-tarball screenshot regressions.
- Regression: the host test proves the relayed default screenshot action has no `device` key and returns explicit mask metadata; `pnpm pack:check` proves installed image/file delivery.
- Status: closed.

## BB-064 - Legacy body shapes were not opaque by default

- Minimal repro: pass host redaction a network body with secret-bearing `data` but no explicit `encoding`, or with `encoding:"utf-8"` and a binary MIME type.
- Root cause: the host refused known non-UTF-8 encodings but treated missing encoding/MIME decisions as text, leaving a compromised or older extension shape an unsafe fail-open path.
- Fix: textual eligibility now requires both explicit `encoding:"utf-8"` and an allowlisted text/JSON/XML/JavaScript/form MIME type; every other body is null.
- Regression: core privacy tests cover missing encoding and binary MIME in addition to the checked-in opaque-body corpus.
- Status: closed.

## BB-065 - fill_form validated nested targets but parsed the wrong object

- Minimal repro: parse `{kind:"fill_form",fields:[{target:{role:"textbox",name:"Email"},value:"Ada"}]}`; validation accepted the nested target, then parsing looked for target fields on the enclosing field and discarded the entry.
- Root cause: `parseFormFields` called `parseBrowserTarget(input)` instead of `parseBrowserTarget(input.target)`.
- Fix: parse the validated nested target, reject mixed nested/shorthand strategies and empty values, and reject ambiguous target objects instead of silently selecting by priority.
- Regression: canonical action tests prove nested target preservation and reject mixed strategies, empty sensitive zones, and empty field values.
- Status: closed.

## BB-066 - Type-only initialization changed the public action-signal shape

- Minimal repro: run the compiled driver test that records navigation, network-write, dialog, download, and new-target signals after the first strict TypeScript pass.
- Root cause: the migration initialized every optional signal to `false` or `null` to satisfy an overly strict internal type, so spreading the signal window added a new `containmentPrevention:null` field and false-valued fields that the JavaScript runtime had omitted.
- Fix: model signals as optional facts and preserve the original empty-object initialization; TypeScript still checks every supported key.
- Regression: `driver records dialog, download, new-target, navigation, and network-write signals` compares the exact public shape from compiled output and failed before the correction.
- Status: closed.

## BB-067 - Created-tab identifiers were trusted through type assertions

- Minimal repro: make the Chrome tabs adapter or controller tabs port return a created tab without a numeric ID. The initial TypeScript draft asserted the ID and could reach update, grouping, host creation, or debugger setup with `undefined`.
- Root cause: compile-time non-null/type assertions replaced runtime narrowing at an external Chrome/adapter boundary.
- Fix: require a nonnegative safe-integer tab ID immediately after creation/selection and before registering cleanup or performing any downstream effect; model the real Chrome `tabs.update` API as required.
- Regression: Chrome-port and controller tests inject missing IDs and assert rejection plus zero update, group, host-create, driver-create, cleanup, or publication effects.
- Status: closed.

## BB-068 - Strict eval validation rejected deferred semantic targets

- Minimal repro: load the checked-in semantic-ref task after strict browser-action parsing
  became canonical. A target-required click is validated before replay resolves its
  `semanticRef`, producing `click requires a target` and preventing the task from loading.
- Root cause: the eval schema applied final core action validation before the replay stage
  that is explicitly responsible for semantic target resolution.
- Fix: permit a missing target only when the same validated step contains a non-empty
  `semanticRef`; validate all other action fields with a temporary valid composite ref,
  remove that placeholder, and inject only the actually resolved ref during replay.
- Regression: the complete checked-in catalog, ambiguity cases, and
  observe-to-semantic-action sequence pass in `test/evals/replay.test.mjs`.
- Status: closed.

## BB-069 - Live acceptance drafts contradicted the public output contract

- Minimal repro: run the input/dialog live harness. Session start passes a page URL with a
  path/query where the API requires an exact origin; frame/input observations then request
  the compact default while attempting to read JSON `nodes`.
- Root cause: worker drafts were written against internal driver-shaped results rather than
  the strict public MCP start and projection contract.
- Fix: start with the normalized origin, navigate explicitly to the fixture URL, and request
  `format:"json"` for every live assertion that consumes nodes or frame metadata. Fixture
  contracts import compiled driver output rather than TypeScript source.
- Regression: all live scripts pass syntax/boundary/type gates, the deterministic fixture
  suite passes, and strict MCP origin/projection regressions remain in the root suite.
- Status: closed before live evidence was claimed.

## BB-070 - Excluded-frame provenance was dropped by agent output projection

- Minimal repro: project a redacted driver observation containing an ungranted OOPIF in
  `excludedFrames` through either compact or JSON agent output. The driver/core preserved
  the facts, but the MCP projection omitted them.
- Root cause: the Plan-06 projector allowlisted node/base fields without adding the
  Plan-03 excluded-frame metadata.
- Fix: normalize at most 64 entries containing bounded frame ID, redacted origin, and
  reason, and carry the same host-redacted array in compact and JSON projections.
- Regression: `compact and JSON observations preserve bounded excluded-frame provenance`
  fails on the prior projector and passes after correction; the live frame-churn harness
  consumes the JSON form.
- Status: closed at source/packed projection level; connected OOPIF evidence remains open.

## BB-071 - Release gate mistook active client hosts for leaked processes

- Found: 2026-08-09 during the first final three-pass release attempt.
- Minimal repro: start Newton MCP hosts from existing Codex tasks on ports in `17321..17340`, then run `pnpm release:check`.
- Root cause: the final port guard required the entire bounded default range to be empty, even when listeners predated the release process and belonged to active local clients.
- Fix: snapshot occupied default ports before the first release stage and reject only ports that become newly occupied during the run.
- Regression: `test/release-port-guard.test.mjs` preserves an existing baseline while detecting and sorting genuinely new listeners.
- Status: closed; final three-pass release proof restarted from the corrected guard.

## BB-072 - Successful readiness responses left timeout handles alive

- Found: 2026-08-09 during the final bounded live-readiness probe.
- Minimal repro: set `NEWTON_BROWSER_EXTENSION_PROBE_MS=10000` and run `pnpm smoke:extension-ready` against a disconnected extension; the script prints its result near 11 seconds but remains alive until the initialize request's 30-second timeout fires.
- Root cause: successful MCP responses won `Promise.race`, but the losing timeout promises were never cancelled; response arrival between the initial map check and waiter registration was also vulnerable to a lost wakeup.
- Fix: use a shared response waiter that registers one cancellable timer, removes it on success, cleans its map entry on either outcome, and rechecks the response map after registration.
- Regression: `test/extension-readiness-lifecycle.test.mjs` proves timer cancellation for ordinary and registration-race responses; the real disconnected probe exits promptly after emitting its bounded result.
- Status: closed.

## BB-073 - Live eval selected inconsistent browsers and a busy fixed port

- Found: 2026-08-09 during the connected-browser completion audit.
- Minimal repro: run `pnpm eval:live` with only Chrome connected while port 17321 belongs to another local MCP task. The first harness targets Edge by default and every harness requests the occupied port even though the host supports bounded discovery.
- Root cause: older QA scripts interpreted an absent `NEWTON_BROWSER_QA_OWNER` as Edge, newer scripts inherited `browserTarget:auto`, and each wrapper converted an absent port override into literal 17321.
- Fix: one strict live configuration resolver defaults to Chrome, accepts an explicit Chrome/Edge owner, rejects ambiguous `auto`, and leaves the port undefined so the host scans its bounded loopback range. Every audit live harness now records the selected family and actual port.
- Regression: `test/live-smoke-config.test.mjs` covers target precedence, ambiguity rejection, automatic port selection, exact bounds, and malformed overrides.
- Status: closed at source level; connected Chrome/Edge execution remains pending.

## BB-074 - Concurrency acceptance dispatched before page readiness

- Found: 2026-08-09 during the connected Chrome acceptance run.
- Minimal repro: create two owned sessions, wait only for controller binding, and immediately fill `Search records`; a navigation/renderer transition can interrupt target evidence resolution and surface as `floor_evaluation_failed` before input dispatch.
- Root cause: `waitForSessionReady` proves the extension/controller binding, not that the destination document has reached the fixture's observable ready state. The live harness conflated those two transitions.
- Fix: wait concurrently in both sessions for the exact `fixture-ready` marker, then use the returned command sequences as the baselines for FIFO and cross-session assertions.
- Regression: `test/live-smoke-config.test.mjs` proves the helper dispatches a bounded marker wait for every session, returns exact sequence baselines, and rejects non-verified readiness without sleeps.
- Status: closed at harness level; connected Chrome rerun pending.

## BB-075 - OOPIF frame identity was not reconciled across process swaps

- Found: 2026-08-09 after the readiness-corrected connected Chrome concurrency run surfaced `frame_conflict` on the first command.
- Minimal repro: observe an OOPIF first as a frame in the parent session, then attach Chromium's flattened iframe target where `TargetInfo.targetId`, the embedding `Page.Frame.id`, and the child root `Page.Frame.id` share one identity. A process swap may additionally emit `Page.frameDetached(reason: "swap")`, detach the old target session, and reattach the same identity.
- Root cause: the registry treated every frame owner change and frame-detach event as terminal. It also copied document-root and cross-target CDP parents into the registry's intra-target frame graph. Chromium's OOPIF boundary is a constrained ownership transition, while a swap is a nonterminal transition whose old refs still must remain permanently fenced.
- Fix: track the main document frame separately; omit only document-root/cross-target parent edges; reconcile ownership only when exact iframe topology proves the same-identity OOPIF boundary; keep child ownership when a late parent observation arrives; and model a bounded one-use swap state that retires refs, suspends the old target session, counts against capacity, and permits only the exact reattachment. Normal removal, unrelated owners, ambiguous topology, and stale refs remain fail-closed.
- Regression: the registry and driver suites cover parent-first and child-first same-identity event orders, cross-target parents, swap/detach/reattach, permanent old-ref fencing, unknown and terminal detach behavior, unrelated-target rejection, and target/frame cap accounting.
- Status: closed at source level; rebuilt extension and connected Chrome rerun pending.

## BB-076 - Evidence-resolution failures were mislabeled as floor failures

- Found: 2026-08-09 while adding bounded diagnostics for the connected Chrome frame conflict.
- Minimal repro: make `driver.resolveEvidence` throw a typed target-registry error before the host floor evaluator runs; the controller returned `floor_evaluation_failed`, hiding both the failing stage and the retry-relevant category.
- Root cause: one `try/catch` enclosed target resolution and floor evaluation even though they are different trust and failure boundaries.
- Fix: resolve driver evidence outside the evaluator catch; preserve only recognized typed driver/target failures, map unexpected resolution exceptions to `evidence_resolution_failed`, and reserve `floor_evaluation_failed` for exceptions from the local structural evaluator itself. Internal registry diagnostics never alter the stable public `frame_conflict` code.
- Regression: `BridgeRuntime keeps internal frame-conflict diagnostics out of the public error contract` proves trusted and hostile detail stay private; the untyped-error, evaluator-stage, and existing invalid-selector regressions prove the failure boundaries remain distinct without exposing page/CDP text.
- Status: closed at source level; rebuilt extension and connected Chrome diagnostic rerun pending.

## BB-077 - Worker-restart acceptance could reload before command dispatch

- Found: 2026-08-09 during final acceptance-harness scrutiny.
- Minimal repro: start `live-worker-restart.mjs` and react immediately when its state file reports `reload_now`; the script published that phase before calling `bridge.dispatch`, so the service worker could reload before any command was in flight.
- Root cause: the human synchronization signal and the system state transition were ordered by source intent rather than by observable host state.
- Fix: start the long command, wait without sleeps until the host's bounded command metrics prove the next command entered the sent phase, and only then publish `reload_now`.
- Regression: `worker restart handshake waits until the host reports the command sent` proves both the state-driven success path and bounded failure path.
- Status: closed at harness level; connected MV3 restart run pending.

## BB-078 - Live readiness failures could echo unbounded page-derived results

- Found: 2026-08-09 during final live-harness trust-boundary review.
- Minimal repro: return a non-verified readiness result containing a large or sensitive `observation_text`; the helper serialized the entire result into its thrown error and optional state receipt.
- Root cause: a diagnostic path treated a full browser result as trusted bounded metadata.
- Fix: retain only `ok`, bounded `errorCode`, bounded `actionStatus`, and numeric `sequence` in readiness failure diagnostics.
- Regression: `live session readiness rejects a non-verified page state` includes page-derived secret text and proves it is absent from the error.
- Status: closed at source level; connected live runs pending.

## BB-079 - OOPIF swap tombstones could resurrect or detach the wrong generation

- Found: 2026-08-09 during independent post-integration state-machine review.
- Minimal repro: begin a same-identity frame swap, then deliver a normal frame removal, a delayed old-session target detach, a cross-origin exact reattach, or an attach while the hosted target is still pending. The initial swap model could retain a consumable swap alongside a terminal tombstone, detach the new generation, reject a valid origin transition, or terminalize pending topology.
- Root cause: nonterminal swap state did not retain enough exact generation/session topology and normal detach paths did not atomically consume it. Capacity accounting and lifecycle identity were therefore checked independently instead of as one state transition.
- Fix: terminal removal converts swap state to exactly one tombstone; suspended targets retain a private prior session and require a fresh reattach session; target detach is session-qualified; exact immutable topology permits a new canonical origin; pending hosted subtrees suspend nonterminally; all swapping state counts against existing caps and is absent from public metadata.
- Regression: registry and driver cases cover swap→remove→reattach rejection, repeated removal, exact cap totals, stale detach before/after frame consumption, same-session rejection, cross-origin granted/ungranted replacements, and pending hosted subtrees.
- Status: closed at source level; connected Chrome OOPIF churn rerun pending.

## BB-080 - Delayed target detach could desynchronize containment hold ownership

- Found: 2026-08-09 during orchestrator review of BB-079's session-qualified registry fix.
- Minimal repro: replace an ungranted same-ID OOPIF with a new ungranted session, then deliver the old session's delayed `Target.detachedFromTarget`; the registry kept the new target, but the driver unconditionally deleted its new hold. Conversely, an ungranted-to-granted replacement could retain the old hold.
- Root cause: target-registry ownership was generation/session-qualified while `heldTargets` remained keyed and mutated only by target ID.
- Fix: remove a hold on detach only when the event session matches that hold (or no session identity exists), and clear the exact stale hold when a replacement is granted and resumed.
- Regression: driver tests cover delayed detach before and after replacement frame consumption, preserve the new held record/session, and prove an allowed replacement clears an old hold.
- Status: closed at source level; connected containment/frame churn rerun pending.

## BB-081 - Ordinary MV3 target hooks cannot guarantee a popup's zero first request

- Found: 2026-08-09 during the connected Linux Chrome containment matrix.
- Minimal repro: in a disposable isolated Chrome for Testing profile, start a restricted
  session and activate `window.open(deniedUrl, "_blank", "noopener")`. Ordinary
  `chrome.debugger` rejects `Target.attachToBrowserTarget`; a private tab-root
  `Target.setAutoAttach` probe is accepted but the action completes and the exact denied
  destination document endpoint records one application request.
- Root cause: browser-target `Target.autoAttachRelated` is unavailable to an ordinary MV3
  debugger client, while tab-root autoattach covers the attached target tree and does not
  provide relationship-scoped pre-navigation control of a top-level noopener popup.
- Resolution: the private probe met its predeclared rollback criterion and was removed.
  Production keeps the closed `browser_control_attach_failed` setup outcome instead of
  silently weakening containment. Plan 04 is split into owner-selectable Plan 04A
  (extension-only narrowed popup boundary) and Plan 04B (isolated Newton-owned browser with
  browser-level CDP).
- Regression/evidence: bounded receipt
  `test/evidence/aip04-root-autoattach-probe.json`; post-rollback driver, controller,
  extension, build, typecheck, pack, and token gates pass; repository search finds no
  private-probe activation symbol.
- Status: platform limitation confirmed; product-boundary decision pending.

## BB-082 - Packed doctor could read or create the user's real Newton config

- Found: 2026-08-09 during the current-tree release-checkpoint pre-audit.
- Minimal repro: run `pnpm pack:check` without `NEWTON_BROWSER_CONFIG_DIR`. Its packed
  `--doctor` invocation inherited the user environment, so configuration discovery
  could read or create the real per-user `pairing.json`.
- Root cause: the spaced-path install was temporary, but packed utility subprocesses did
  not receive an isolated home/config environment. The clean-user and matrix smokes had
  isolation independently, which hid this gap in the pack stage.
- Fix: create one validated pack-check-owned temporary root; overlay `HOME`, `USERPROFILE`,
  `LOCALAPPDATA`, `APPDATA`, `XDG_CONFIG_HOME`, and `NEWTON_BROWSER_CONFIG_DIR` for every
  packed subprocess; verify doctor reports the exact isolated directory; and refuse unsafe
  recursive cleanup targets.
- Regression: `test/pack-check-config-isolation.test.mjs` proves a hostile real-config
  sentinel remains unchanged, writes land only under the isolated root, exact cleanup
  succeeds, and unrelated/same-prefix replacement targets are rejected.
- Status: closed; focused 2/2 and packed install/doctor/stdio checks pass with
  `isolatedConfig:true`.

## BB-083 - Input key evidence could exceed the observation budget

- Found: 2026-08-10 during the final direct live matrix.
- Minimal repro: type a multi-event key sequence in the input fixture, then request the
  key-log node through a bounded accessibility observation.
- Root cause: the fixture serialized its complete growing key-event history.
- Fix: retain only unique bounded key and event-type categories.
- Regression: the input fixture contract rejects full-history serialization; Windows
  Chrome/Edge and Linux Chrome input live stages pass.
- Status: closed.

## BB-084 - Direct invalid-selector actions bypassed typed preflight

- Found: 2026-08-10 during the direct dialog live stage.
- Minimal repro: issue a direct action with selector `]`; the raw CDP failure surfaced as
  `direct_debugger_command_failed` instead of `invalid_selector`.
- Root cause: the extension controller performed action preflight, but the collapsed
  direct session command pump called the driver action directly.
- Fix: direct sessions invoke the driver's preflight before execution; selector syntax is
  checked through `Runtime.evaluate` exception details and normalized to the existing
  closed code.
- Regression: direct-session tests prove rejected preflight performs no execution; driver
  tests prove typed selector classification; all three dialog live stages pass.
- Status: closed.

## BB-085 - Packed extension reconnect could miss its initial session snapshot

- Found: 2026-08-10 during Linux packed QA.
- Minimal repro: reconnect the packed fake extension and immediately stop its attached
  session; request 29 could wait forever.
- Root cause: the durable `sessions_changed` handler was installed after `client_ready`,
  while the host emits readiness and the session snapshot back-to-back.
- Fix: install the durable handler before sending `client_hello`.
- Regression: the ordering is asserted statically and repeated packed checks pass.
- Status: closed.

## BB-086 - Docker Desktop seccomp blocked Chrome's Linux sandbox

- Found: 2026-08-10 during the Linux direct live matrix.
- Minimal repro: launch Chrome for Testing from the non-root runner under Docker Desktop's
  default seccomp profile; Chrome exits with `No usable sandbox` before CDP readiness.
- Root cause: the container profile blocks the user-namespace operation used by Chrome's
  sandbox. The archive's sandbox helper also needed canonical root ownership/mode.
- Fix: build the image with a root-owned mode-4755 `chrome_sandbox` and run the disposable
  QA container with `seccomp=unconfined`; Newton does not add `--no-sandbox`.
- Regression: runner tests assert both requirements; the final Linux direct run reaches
  every independent live stage.
- Status: closed for the documented Docker Desktop runner.

## BB-087 - Packed direct live browser discovery was Windows-only

- Found: 2026-08-10 in the Linux packed direct stage.
- Minimal repro: run the exact tarball inside the Linux CFT image; the harness returned
  `direct_browser_unavailable` despite `/usr/bin/google-chrome` being valid.
- Root cause: the smoke harness duplicated Windows executable paths instead of using the
  product's deterministic discovery implementation.
- Fix: use the shared cross-platform browser discovery function.
- Regression: static contract coverage plus packed Chrome, Edge, and Linux runs pass.
- Status: closed.

## BB-088 - Worker prevention was incorrectly treated as temporally attributable

- Found: 2026-08-10 in the final direct containment matrix.
- Minimal repro: click the fixture control that launches a worker request to an ungranted
  origin. The policy proxy records zero destination application requests, but the action
  result reports `completed` instead of `prevented`.
- Root cause: proxy prevention is process/session scoped while worker launch and request
  settlement are asynchronous; there is no exact command-scoped worker ticket. Timing or
  ledger-sequence inference can misattribute a late denial to the next command and was
  rejected.
- Superseding fix: remove the proxy command fence. The proxy enforces and counts the
  denial but cannot author an action outcome. Only an exact main-document decision or a
  command-scoped related-target ticket may return `prevented`; otherwise the UI action's
  own verified/uncertain outcome is preserved.
- Regression/evidence: deterministic proxy/host regressions prove no temporal API or
  cross-command poisoning; Windows Chrome and Edge complete containment matrices prove
  exact zero-request enforcement with honest asynchronous action outcomes.
- Status: closed on Windows; current-tree Linux rerun remains a release-matrix task.

## BB-089 - Temporal containment attribution poisoned unrelated real-site actions

- Found: 2026-08-11 during independent audit and Chrome/Edge real-site QA.
- Minimal repro: load a production HTTPS page with unrelated denied background traffic,
  then issue a read-only wait, scroll/navigation key, or open a search control. The
  overlapping action can inherit the background request's prevention and fail even when
  its own UI effect succeeds.
- Root cause: driver and policy-proxy prevention slots used temporal overlap as causal
  attribution. Fetch interception has no proof that an arbitrary request was initiated by
  the current trusted input.
- Fix: remove temporal command attribution from the proxy and direct host. Main-frame
  Document interception and exact related-target tickets remain the only causal
  prevention evidence. HTTPS CONNECT denials remain aggregate and require explicit
  grants rather than guessed resource classes.
- Regression/evidence: `QA-REAL-SITES-002`; three consecutive Chrome and one Edge
  public-site batches preserve useful media/commerce/business-console interactions without temporal
  background-request poisoning.
- Status: closed.

## BB-090 - Packed MCP included a development JavaScript source map

- Found: 2026-08-11 during independent audit.
- Minimal repro: build and pack the MCP, list the tarball, and inspect
  `package/dist/index.js.map`; the pack checker did not reject `.js.map`.
- Root cause: MCP build enabled esbuild source maps and the forbidden-file expression
  rejected `.map.ts`, not `.js.map`.
- Fix: production MCP build disables source maps and pack validation rejects every `.map`.
- Regression/evidence: `pack:check` passes with only compiled guardian/runtime JavaScript,
  package metadata, and README; no `.map` entry is present.
- Status: closed.

## BB-091 - Synthetic fixtures overstated direct-runtime usability

- Found: 2026-08-11 in the requested real-site Chrome/Edge matrix.
- Minimal repro: run `pnpm eval:real-sites` against the four fixed public media,
  discussion, commerce, and business sites encoded by the QA harness.
- Root cause: the prior direct matrix used controlled localhost fixtures and did not cover
  anti-bot/interstitial behavior or production accessibility/control discovery.
- Result after hardening: media interaction, commerce search fill/submit/post-navigation
  observation, and the logged-out business-console shell pass in Chrome and Edge. The discussion site consistently
  exposes fewer than three useful accessibility nodes. All sessions and owned resources
  clean up.
- Status: closed for the owner-approved unauthenticated release scope. Reddit remains an
  explicit external block classification; authenticated Meta is an optional operator
  workflow and is not a release gate under Decision 43.

## BB-092 - Hard MCP-host termination could orphan Chromium and its identity lease

- Found: 2026-08-11 during independent lifecycle review.
- Minimal repro: start a direct owned session, terminate the MCP process without running
  shutdown handlers, then inspect the detached Chromium process and identity lease.
- Root cause: Chromium was detached and all cleanup authority lived in the process that
  had just been killed.
- Fix: launch production Chromium through a separate IPC guardian with exact process-tree
  ownership and a marker/dev/ino/nonce-bound cleanup plan. Add explicit stale-lease
  recovery that refuses a live recorded PID.
- Regression/evidence: deterministic guardian disconnect/exact-cleanup tests and current
  Chrome/Edge forced-host-loss stages prove browser-tree termination and ephemeral
  identity removal. Windows temp-root cleanup awaits the exact bounded handle release.
- Status: closed on Windows; current-tree Linux rerun remains a release-matrix task.

## BB-093 - Direct sessions ignored bridge-compatible command deadlines

- Found: 2026-08-11 during independent contract review.
- Minimal repro: dispatch a queued or already-running direct command with a deadline;
  the host rejected timeout options instead of preserving `not_started` versus
  `outcome_unknown` semantics.
- Root cause: the direct session pump had FIFO and caps but no per-entry deadline state.
- Fix: add bounded timers to queue entries. Queued expiry removes the command; running
  expiry rejects the caller but keeps FIFO occupied until the executor settles. Expose a
  bounded top-level `browser.act.timeoutMs` and retain the 60-second default.
- Regression/evidence: pump/direct-host deadline regressions, complete root discovery,
  and current Chrome/Edge direct matrices pass.
- Status: closed.

## BB-094 - Production CDP event bursts terminally overflowed the default queue

- Found: 2026-08-11 during repeated commerce-storefront search QA.
- Minimal repro: open the selected public commerce storefront, fill its search control, and press Enter.
  Network/Target events can exceed 256 while a request-stage Fetch acknowledgement is
  in flight; the pipe terminates with `cdp_event_queue_overflow`, and the action returns
  `containment_fence_failed`.
- Root cause: the private transport default used only one quarter of its already-audited
  hard queue ceiling. Synthetic fixtures never generated the production event burst.
- Fix: use the existing bounded 1,024-event ceiling as the default. Retain terminal
  overflow behavior, per-message byte caps, and explicit lower-cap regression injection.
  Owned-runtime Fetch request IDs that vanish before acknowledgement defer to the
  launch-time proxy and never fabricate a driver prevention; extension mode stays
  fail-closed.
- Regression/evidence: pipe/WebSocket overflow tests retain explicit small caps; driver
  request-churn regressions pass; three consecutive Chrome storefront workflows and one
  Edge workflow pass, followed by a complete Edge 9/9 direct matrix.
- Status: closed.

## BB-095 - Direct host reported incomplete driver statuses as completed

- Found: 2026-08-11 during trusted-mask commerce QA.
- Minimal repro: make a direct driver action return `stale_target`, `not_found`,
  `ambiguous`, or `timed_out`; the host emitted `ok:true,outcome:completed`.
- Root cause: direct-host dispatch mapped every non-containment driver delta through the
  success constructor and treated status as diagnostic only.
- Fix: map pre-dispatch targeting failures to retry-safe `not_started`, wait-only timeout
  to `not_started`, post-dispatch timeout/failure to non-retryable `outcome_unknown`, and
  blocked/approval results to `prevented`. Preserve only verified and
  `dispatched_unverified` action deltas as completed.
- Regression/evidence: direct-host status matrix covers all incomplete classes; the
  deterministic gate passes 598 tests with zero failures.
- Status: closed.

## BB-096 - Sensitive-zone masking could not bind an exact observed ref

- Found: 2026-08-11 on the real Mercato search page.
- Minimal repro: mask the visible search field with its form selector; multiple matching
  responsive inputs correctly produce `ambiguous`, while the public mask schema cannot
  accept the already-observed exact ref.
- Root cause: sensitive zones supported selector/name/label only, losing the strongest
  stable targeting primitive used by ordinary actions.
- Fix: add one exact `ref` alternative to protocol, strict runtime schema, public MCP
  schema, eval schema, redaction, and driver target resolution. Multiple discriminators
  remain invalid and stale refs remain fail-closed.
- Regression/evidence: strict parser/schema tests plus Windows Chrome/Edge and Linux
  Mercato exact-ref trusted masked PNG receipts pass.
- Status: closed.

## BB-097 - Containment evidence rejected an honest post-action prevention code

- Found: 2026-08-11 during the pinned Linux direct matrix.
- Minimal repro: the restricted fetch fixture returns
  `outcome:prevented,errorCode:post_action_network_write` with destination count zero;
  the live classifier emits `action_other` and fails the gate.
- Root cause: the evidence allowlist recognized request-stage containment codes but not
  the closed post-action network/dialog reconciliation codes.
- Fix: admit only the exact closed reconciliation codes and retain zero-request server
  counters as the independent effect proof. Bounded diagnostic facts never copy raw
  result/page fields.
- Regression/evidence: containment classifier regression, full local containment matrix,
  and Linux run `linux-cft-b31c63a63adfb7f00677` pass.
- Status: closed.

## BB-098 - Closed Windows Chrome profiles were rejected by a persistent database LOCK file

- Found: 2026-08-11 during the operator-authorized Chrome Default import.
- Minimal repro: close every Chrome process and prepare a normal long-lived Default
  profile containing its zero-byte `LOCK` database artifact.
- Root cause: the importer treated a profile-subtree database `LOCK` as browser-liveness
  evidence even though Chromium retains that file while closed.
- Fix: rely on the independent all-family process-table proof plus user-data-level
  `Singleton*` indicators; do not classify profile database lock files as active-browser
  ownership.
- Regression/evidence: the focused profile-store suite imports a closed fixture with a
  persistent `LOCK`, while `SingletonLock` and failed closure evidence remain rejected.
- Status: closed.

## BB-099 - The production Windows source-closure verifier could never prove closure

- Found: 2026-08-11 during the operator-authorized Chrome Default import.
- Minimal repro: run the default Windows closure verifier with Chrome stopped. Windows
  contributes PID 0, and unrelated process command lines may contain line breaks; either
  condition made the entire bounded snapshot invalid.
- Root cause: the provider included the System Idle Process and collected command lines
  even though Windows family detection is executable-based.
- Fix: filter PID 0 at the CIM provider boundary and collect only PID, name, and executable
  path. Injected malformed process evidence remains fail-closed.
- Regression/evidence: default Windows verification now reaches the real all-Chrome
  process decision; focused hostile-provider tests remain green.
- Status: closed.

## BB-100 - Failed imported-profile QA emitted stale cleanup state and leaked temp roots

- Found: 2026-08-11 when the authorized profile proved logged out on Meta.
- Minimal repro: fail authenticated QA after a successful opaque import. The harness wrote
  its receipt before `finally`, silently swallowed cleanup errors, and gated root removal
  on a stale flag; three owner-marked empty temp roots accumulated.
- Root cause: failure reporting preceded the cleanup transaction and early import failures
  had no root-removal path.
- Fix: emit exactly once after identity deletion/root cleanup, prioritize a bounded cleanup
  failure, remove owned roots after pre-import failures, and include only closed auth/site
  status categories. The three prior direct-child owner-marked roots were identity-checked
  and removed.
- Regression/evidence: repeated authenticated-QA failures now report
  `identityRemoved:true,cleanupConfirmed:true`; zero profile-import temp roots remain.
- Status: closed.

## BB-101 - Live page-input QA invoked Chrome's reserved F12 shortcut

- Found: 2026-08-11 in final release pass 1/3.
- Minimal repro: dispatch F12 to the page fixture, then resolve and click the same semantic
  input before the Control+Shift+P chord. Chrome may open/focus DevTools, and the page
  action correctly returns `stale_target`.
- Root cause: the live harness conflated descriptor fidelity with a browser-reserved
  accelerator. F12 descriptor shape was already covered deterministically.
- Fix: retain deterministic F12/F24 descriptor tests and use non-reserved F2 for the real
  page-level function-key lifecycle.
- Regression/evidence: static live-contract test rejects F12 in the smoke while requiring
  the deterministic F12 descriptor test; focused Chrome input smoke passes before the
  release sequence restarts.
- Status: closed.

## BB-102 - Identical release trees could produce different npm tarball bytes

- Found: 2026-08-11 after the first corrected three-pass release sequence.
- Minimal repro: run the complete release gate three times from candidate SHA-256
  `5d526eea…f3aa2`; passes 1-2 produced artifact `dfad098d…c6d6f`, while pass 3
  produced `93556727…85bbf` at the same 133,103-byte size.
- Root cause: the release delegated archive construction to `pnpm pack` and neither
  controlled all tar/gzip metadata nor compared independent rebuild bytes.
- Fix: build the five-file package with a reviewed deterministic USTAR encoder, fixed
  order/modes/UID/GID/mtime, canonical LF text, zeroed host-neutral gzip metadata, and an
  exact allowlist. Existing install/catalog/live gates still consume the resulting tgz.
- Regression/evidence: source mtime changes produce byte-identical archives; two immediate
  full pack checks both produce 132,631 bytes with SHA-256
  `4f8e1910c74eef3b1de5873034e35c6b5490d5f014435dfcf30dbf90dbe7bae6`.
- Status: closed; final release sequence restarted from 0/3.

## BB-103 - YouTube QA treated one transient zero-node AX snapshot as terminal

- Found: 2026-08-11 in the deterministic-archive release sequence, Windows Edge real-site
  stage.
- Minimal repro: navigate an isolated Edge identity to YouTube, wait for the visible body,
  and take one accessibility observation. A dynamic shell transition can yield zero nodes
  even though bounded text, page input, document readiness, and screenshot paths work.
- Root cause: the YouTube workflow required accessibility nodes even though its PageDown
  action is untargeted and the production-site harness already had a bounded text fallback.
- Fix: require useful accessibility or bounded text evidence before PageDown, then retain
  the post-action visible-body and in-memory screenshot proof. No retry or sleep was added.
- Regression/evidence: static real-site contract requires the shared accessibility/text
  evidence path; focused Edge real-site QA must pass before release restarts.
- Status: closed.

## BB-104 - Containment live QA ignored the retryable cleanup contract

- Found: 2026-08-12 in final release pass 1 after the denied popup-form request was
  prevented and its destination counter remained zero.
- Minimal repro: run the sequential popup containment matrix until Windows reports one
  session stop as `direct_cleanup_uncertain`; the harness immediately asserted
  `stopped:true` and failed instead of retrying the exact cleanup transaction.
- Root cause: the containment harness predated the direct host's explicit retryable
  cleanup outcome. The real-site harness honored that contract, but containment teardown
  still treated its first uncertain acknowledgement as terminal.
- Fix: retry `browser.session.stop` exactly once and immediately only when the host returns
  `direct_cleanup_uncertain`, then retain the existing stopped-state and zero-residue
  assertions. No browser action is replayed, and no sleep or timeout widening is added.
- Regression/evidence: the static live-contract test requires the closed-code retry path;
  three consecutive complete Chrome containment matrices pass with every denied
  destination counter at zero and every session teardown clean.
- Status: closed; final release sequence restarted from 0/3.
