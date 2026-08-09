# Browser Bridge Defect Ledger

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
