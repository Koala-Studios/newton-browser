# Newton Browser defect ledger

Entries before BB-049 are archived extension-era history. Deleted extension/relay paths
are not current product surfaces, and their receipts do not close a direct-runtime gate.
Later entries track the owned-browser and modern stateless MCP implementation. Every
current defect remains pending until the frozen-tree final gate records its regression.

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
- Regression: the historical registry-metadata test required exact server/package name
  and version agreement. The current boundary gate instead proves public Registry metadata
  is absent until a separately approved direct-only publication.
- Evidence: official Registry issue #689 and the rejected 403/400 publisher responses
  retained in the historical task and GitHub Actions records.
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

> Superseded contract note: the current modern-only action parser rejects nested
> `target` objects entirely. `fill_form` now accepts only flat target fields, so the
> historical compatibility path described below no longer exists.

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
- Regression: the historical extension-readiness lifecycle test proved timer cancellation
  for ordinary and registration-race responses. That entire probe and test were deleted
  with the extension architecture.
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
- Regression/evidence: the historical disposable-profile probe confirmed the limitation;
  repository search then proved the private-probe activation path removed.
- Status: closed by the owned-browser architecture. Newton now owns an isolated Chromium
  process and browser-level private CDP transport, so it does not depend on MV3 debugger
  privileges or the discarded probe.

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

## BB-105 - Modern MCP parse errors used a legacy null request ID

- Found: 2026-08-12 during the modern-only schema audit.
- Minimal repro: send malformed JSON or an invalid request whose ID cannot be recovered;
  the response serialized `"id":null`.
- Root cause: the initialization-era response helper modeled every error as having a
  JSON-RPC ID and used null as a placeholder. MCP `2026-07-28` makes an unknown error ID
  absent, and its unsupported-version data has only `supported` and `requested`.
- Fix: make error IDs optional, omit unavailable IDs, and emit the exact `-32022` data
  shape without a product compatibility alias.
- Regression/evidence: modern stdio and contract regressions assert omitted IDs and the
  exact unsupported-version object; the final integrated gate remains pending.
- Status: implemented; final gate pending.

## BB-106 - Release candidate hashing rejected intentional tracked deletions

- Found: 2026-08-12 while freezing the extension/legacy deletion tree.
- Minimal repro: run the complete release gate with a tracked extension-era file deleted;
  `git ls-files` includes the path and the digest routine aborts on `lstat` ENOENT.
- Root cause: candidate inventory correctly included tracked deletions, but the digest
  had no canonical representation for their absence.
- Fix: hash each missing tracked path as an explicit `deleted` record while retaining
  strict failure for every other filesystem error and unchanged pre/post comparison.
- Regression/evidence: the deletion-heavy final candidate must complete three passes with
  one stable digest and `sourceUnchanged:true`; final evidence remains pending.
- Status: implemented; final gate pending.

## BB-107 - Identity CLI and MCP resolved different profile stores

- Found: 2026-08-12 during the no-compatibility configuration audit.
- Minimal repro: set `NEWTON_BROWSER_PROFILE_STORE_DIR`, create or list an identity through
  the CLI, then select it through MCP. MCP used the override while CLI silently used the
  default config directory. On a clean machine, `identity create` could also fail before
  `setup` because its config parent did not exist.
- Root cause: direct host, identity dispatcher, and login utility each assembled the
  profile-store path independently, and only MCP initialized the config directory.
- Fix: one strict resolver now serves MCP and every identity utility; overrides must be
  absolute, bounded, non-root paths, and first use creates only the exact config directory.
- Regression/evidence: configuration regressions cover shared resolution, invalid roots,
  and first-use creation; final integrated and packed gates remain pending.
- Status: implemented; final gate pending.

## BB-108 - Full concurrency diagnostics were not session-addressable

- Found: 2026-08-12 while reviewing multi-session usability.
- Minimal repro: start two sessions and request `browser.status` with `detail:"full"`;
  queue diagnostics were anonymous, so an operator or agent could not identify which
  already-public session owned a running or queued command.
- Root cause: privacy hardening removed the session key together with private process and
  profile identifiers even though session IDs are the public application handle.
- Fix: key each bounded diagnostic by its public session ID and keep process, target,
  identity, profile, proxy, and lease facts excluded.
- Regression/evidence: host and live-concurrency regressions select the exact session
  diagnostic; final integrated and live gates remain pending.
- Status: implemented; final gate pending.

## BB-109 - Real-site failure receipts preceded cleanup

- Found: 2026-08-12 while reviewing the final seven-site matrix.
- Minimal repro: let a production-site workflow fail, then make host cleanup reject. The
  harness had already emitted the site failure receipt and swallowed the later cleanup
  error, leaving the owned temp root without reporting cleanup uncertainty.
- Root cause: failure output lived in `catch` while authoritative cleanup lived in
  `finally`.
- Fix: retain the bounded failure, complete host/root cleanup first, let cleanup failure
  supersede the site error, and emit one final receipt with cleanup/root-removal facts.
- Regression/evidence: the static live contract requires post-finally emission and bounded
  cleanup facts; final Chrome/Edge real-site gates remain pending.
- Status: implemented; final gate pending.

## BB-110 - Primary live harnesses could print success before final cleanup

- Found: 2026-08-12 while reconciling final acceptance receipts.
- Minimal repro: let direct-runtime, setup, or hard-crash workflow assertions pass, then
  fail host close or owned-temp removal. A success JSON line was already visible even
  though the process later failed or retained residue.
- Root cause: workflow evidence was emitted inside `try`; cleanup was deferred to
  `finally` and was partly swallowed.
- Fix: retain the candidate receipt, perform authoritative cleanup, let cleanup failure
  supersede workflow success, and emit one bounded final receipt afterward.
- Regression/evidence: the static live contract requires post-finally cleanup facts for
  all three primary harnesses; final live and packed gates remain pending.
- Status: implemented; final gate pending.

## BB-111 - Packed verification invoked a removed CLI alias

- Found: 2026-08-12 during the final no-compatibility source audit.
- Minimal repro: run the packed utility matrix after deleting `config print`; the harness
  still invoked that retired alias and could not prove the actual install workflow.
- Root cause: the product CLI was simplified before its packed consumer was migrated.
- Fix: invoke only `install generic` and verify that it emits the exact real Node
  executable and packed entry path without `npx`.
- Regression/evidence: the packed gate must install and exercise the exact tarball.
- Status: implemented; final gate pending.

## BB-112 - Allowed-origin limits disagreed across host and runtime

- Found: 2026-08-12 during an exact contract-cap audit.
- Minimal repro: start a session with one primary plus 31 distinct secondary origins. The
  host admitted 32 normalized origins while the runtime rejected 31 secondary entries.
- Root cause: one layer counted the full canonical set and the other documented the
  secondary list without defining their relationship.
- Fix: permit at most 31 secondary origins and at most 32 total normalized origins, with
  the primary included exactly once; every origin is bounded to 512 characters.
- Regression/evidence: host and runtime boundary cases cover the exact maximum and the
  first rejected input.
- Status: implemented; final gate pending.

## BB-113 - Startup rollback released an identity before closing its proxy

- Found: 2026-08-12 during owned-runtime failure-order review.
- Minimal repro: make Chromium startup fail after proxy and identity acquisition. Rollback
  released the identity lease while the session proxy still existed.
- Root cause: the failure transaction did not reverse acquisition order.
- Fix: close the proxy before releasing the identity lease and retain cleanup uncertainty
  if either exact stage cannot be confirmed.
- Regression/evidence: an injected startup failure records proxy closure while the lease
  is still active, then proves the identity can be reacquired only afterward.
- Status: implemented; final gate pending.

## BB-114 - Lost cleanup acknowledgements could report false uncertainty

- Found: 2026-08-12 during MCP cleanup idempotency review.
- Minimal repro: let session or stop-all cleanup complete, then lose the response. A retry
  saw an error even though the authoritative session inventory was already empty.
- Root cause: the MCP wrapper trusted the transport error without reconciling current host
  state.
- Fix: after a cleanup error, return idempotent success only when the exact session is
  absent or the complete inventory is empty; otherwise preserve cleanup uncertainty.
- Regression/evidence: stop and stop-all acknowledgement-loss cases cover both outcomes.
- Status: implemented; final gate pending.

## BB-115 - Sensitive screenshot zones accepted malformed element references

- Found: 2026-08-12 during schema/runtime parity review.
- Minimal repro: pass an arbitrary string as `sensitiveZones[].ref`; JSON schema admitted
  it before the runtime eventually failed to resolve it.
- Root cause: the screenshot sub-schema did not reuse the canonical composite-ref grammar.
- Fix: export one composite-ref pattern and enforce it in core parsing and the public MCP
  schema.
- Regression/evidence: contract tests reject malformed zone refs at admission.
- Status: implemented; final gate pending.

## BB-116 - Blank stdio lines were silently accepted as compatibility input

- Found: 2026-08-12 during strict modern-transport review.
- Minimal repro: write an empty line to Newton stdin. The transport ignored it instead of
  emitting a JSON parse error.
- Root cause: the new line parser retained a permissive behavior from prior framing code.
- Fix: treat every complete line as one JSON value; an empty line produces `-32700` with
  no fabricated request ID.
- Regression/evidence: the modern stdio suite includes an empty-line parse-error case.
- Status: implemented; final gate pending.

## BB-117 - Packed checks could consult the network and operator npm settings

- Found: 2026-08-12 during hermetic packaging review.
- Minimal repro: run a packed verification with an empty cache or audit-enabled npm
  configuration; install could access the registry or emit unrelated audit behavior.
- Root cause: exact local tarball installs did not explicitly disable online preference,
  audit, and funding operations.
- Fix: use offline, no-audit, and no-fund flags for every source and packed live install.
- Regression/evidence: the packed gates run solely from the built tarball and local cache.
- Status: implemented; final gate pending.

## BB-118 - An unused native image dependency expanded install and release risk

- Found: 2026-08-12 during dependency-to-source reachability review.
- Minimal repro: search all production and test imports for `sharp`; no code used it, but
  package installation still resolved and installed its native dependency graph.
- Root cause: trusted raster masking had moved to the bundled implementation without
  pruning its earlier development dependency.
- Fix: remove `sharp` and regenerate the lockfile without changing runtime behavior.
- Regression/evidence: the final install, build, test, masking, and packed gates prove the
  dependency is unnecessary.
- Status: implemented; final gate pending.

## BB-119 - Live QA retained a second browser-family selector

- Found: 2026-08-12 during the final environment-surface audit.
- Minimal repro: omit `NEWTON_BROWSER_QA_BROWSER` but set the production
  `NEWTON_BROWSER_BROWSER` variable; some live fixtures silently selected that family.
- Root cause: the live helper retained a fallback from the migration period, coupling
  test selection to product configuration.
- Fix: accept only `NEWTON_BROWSER_QA_BROWSER` for live QA and default it to Chrome. The
  release orchestrator passes it explicitly for every family.
- Regression/evidence: the direct live contract rejects the retired fallback and proves
  the packed stage is separately wired once in the complete gate.
- Status: implemented; final gate pending.

## BB-120 - The breaking direct-only candidate reused an incompatible published version

- Found: 2026-08-12 during final package-identity review.
- Minimal repro: build the migration tree and inspect its package, CLI, MCP server-info,
  and artifact name; each reported `0.4.5`, the same version as the published MV3 product.
- Root cause: architecture work changed implementation and contracts without advancing
  the package identity.
- Fix: advance every workspace package, CLI/MCP diagnostic, active document, skill, test,
  and packed-live artifact expectation to `0.5.0`. Historical pinned reports retain their
  original versions.
- Regression/evidence: the final packed catalog and exact-tarball gates must agree on
  `0.5.0` and reject stale artifact names.
- Status: implemented; final gate pending.

## BB-121 - Direct hosts reloaded policy from the process-global config directory

- Found: 2026-08-12 during the final config-lifetime audit.
- Minimal repro: create an isolated/default host with a non-default config directory and
  dispatch an action that depends on one of its `hostPolicies`; the floor gate reloaded
  the operator-global config instead of using the host's selected configuration.
- Root cause: policy loading remained hidden inside each floor evaluation after browser
  selection and profile storage had moved to explicit host composition.
- Fix: load policy once from the host's exact config directory, deep-clone and freeze it
  at host construction, and pass that immutable snapshot to every pre-queue and resolved
  target evaluation.
- Regression/evidence: a direct-host regression mutates the caller's source manifest
  after construction and proves the original configured boundary is still authoritative.
- Status: implemented; final gate pending.

## BB-122 - Public additional-origin input ambiguously accepted the primary origin

- Found: 2026-08-12 while reconciling the public schema, live harnesses, docs, and skill.
- Minimal repro: start a session with `origin:https://example.com` and repeat that value in
  `allowedOrigins`; admission silently deduplicated it even though the field is documented
  as additional grants and the 31-item bound applies only to those grants.
- Root cause: migration-era callers supplied a full allowlist while the compact public
  contract had already moved to primary-plus-additional semantics.
- Fix: `allowedOrigins` is now strictly zero to 31 additional exact origins, may be empty,
  rejects the primary and duplicates, and is expanded to the full private allowlist only
  after public validation. Identity login follows the same rule.
- Regression/evidence: MCP schema/admission, identity-login, live fixture, containment,
  frame, and real-site call sites use the one strict contract.
- Status: implemented; final gate pending.

## BB-123 - Linux proved package shape but not the packed browser runtime

- Found: 2026-08-12 during cross-platform release-proof reconciliation.
- Minimal repro: inspect the Linux Chrome runner: it ran `pack:check`, source live, and
  real-site QA, but never installed the produced tarball and drove its browser runtime.
- Root cause: package-structure verification was mistaken for packed-runtime behavioral
  parity in the no-extension migration.
- Fix: after source and real-site success, install and run the exact `0.5.0` tarball
  through the Linux Chrome owned-process workflow and record a separate bounded status.
- Regression/evidence: the Linux runner contract requires the packed stage and the final
  receipt distinguishes source-live from packed-live status.
- Status: implemented; final gate pending.

## BB-124 - Token gate retained an injectable counter and heuristic fallback

- Found: 2026-08-12 during the final environment/fallback audit.
- Minimal repro: omit or break the token counter; the budget helper returned a UTF-8 byte
  estimate, and an environment variable could replace the pinned tokenizer used by QA.
- Root cause: early evaluation scaffolding supported counter injection and deferred
  heuristic reporting before Newton pinned `js-tiktoken`.
- Fix: release measurement always uses the pinned `o200k_base` counter; missing, throwing,
  or non-finite counters fail closed in the lower-level helper. The external counter-file
  override and heuristic token fallback are removed.
- Regression/evidence: token-budget tests cover the exact counter and all fail-closed
  invalid-counter cases; the agent-cost receipt identifies the pinned dependency.
- Status: implemented; final gate pending.

## BB-125 - Empty vendor-policy merge machinery allowed ambiguous host manifests

- Found: 2026-08-12 during dead-export and config-merge review.
- Minimal repro: define two host manifests containing the same origin. Selection used the
  first match, while an empty compiled-in default list and merge map implied a vendor
  override model Newton does not ship.
- Root cause: future default-policy scaffolding survived after the product adopted a
  strictly operator-authored configuration.
- Fix: delete the default-policy export and merge path, return only validated operator
  manifests, and reject any origin appearing in more than one manifest.
- Regression/evidence: config tests cover overlapping origins and the default remains an
  explicit empty operator policy set with the generic structural floor still active.
- Status: implemented; final gate pending.

## BB-126 - Runtime and packed smoke duplicated the package version literal

- Found: 2026-08-12 during unused-export and release-identity review.
- Minimal repro: advance `apps/mcp-server/package.json` without editing the CLI constant
  and packed harness; server metadata, help, and artifact lookup can disagree.
- Root cause: the migration treated three package-version strings as independent config.
- Fix: the runtime reads and validates the adjacent shipped package manifest, and the
  packed harness derives both tarball name and client metadata from that same manifest.
  Internal core/driver workspace packages are explicitly private.
- Regression/evidence: CLI, discovery, package, and packed-runtime gates all compare one
  authoritative application package version.
- Status: implemented; final gate pending.

## BB-127 - Release publication verified only an unpinned Linux runner

- Found: 2026-08-12 during release-workflow composition review.
- Minimal repro: dispatch the release workflow. It ran three Ubuntu passes and could
  publish without Windows Chrome/Edge proof or the pinned Linux Chrome container.
- Root cause: cross-platform live evidence was documented as a separate requirement but
  not represented as a dependency of the publish job.
- Fix: release verification is now a Windows/Linux matrix with three unchanged-candidate
  passes per platform, Windows Chrome+Edge coverage, a pinned Linux CFT container run, and
  bounded receipts whose exact tarball hashes must match before the approval-gated publish
  job runs. Linux headful CI executes under Xvfb.
- Regression/evidence: workflow and Linux-harness contract tests cover the required stages;
  the first real workflow run remains pending the frozen candidate.
- Status: implemented; final gate pending.

## BB-128 - Platform config defaults could escape an isolated home

- Found: 2026-08-12 during config-root environment review.
- Minimal repro: on macOS pass an isolated `HOME` without an explicit Newton config
  override; config resolution used `os.homedir()` and could touch the operator's real
  application-support directory. Windows without `LOCALAPPDATA` similarly fell into a
  Unix-style fallback.
- Root cause: platform defaults mixed process-global home discovery with the supplied
  environment used by packed and clean-user checks.
- Fix: derive one home from the supplied `HOME`/`USERPROFILE` environment, then apply the
  exact Windows, macOS, or XDG platform path; explicit Newton config still wins.
- Regression/evidence: a platform-aware config test proves an isolated supplied home is
  authoritative.
- Status: implemented; final gate pending.

## BB-129 - Production browser launch retained a raw-TypeScript guardian fallback

- Found: 2026-08-12 during alternate-runtime-path review.
- Minimal repro: launch from source without a compiled adjacent guardian; Chromium startup
  silently spawned `browser-guardian.ts` through Node's strip-types flag.
- Root cause: development bring-up support survived after the build and packed artifact
  made the guardian a required compiled runtime file.
- Fix: resolve only the adjacent bundled guardian or the exact workspace `dist` guardian;
  missing compiled output fails startup. Production never selects raw TypeScript.
- Regression/evidence: the boundary gate rejects guardian source/strip-types fallback and
  packed/source live gates both require the compiled guardian.
- Status: implemented; final gate pending.

## BB-130 - Default host read browser and policy configuration from different snapshots

- Found: 2026-08-12 during final configuration-composition review.
- Minimal repro: replace `config.json` between default-host browser selection and host-policy
  loading; one host can combine a browser choice from the old file with authorization rules
  from the new file. Setup could also preserve malformed policy data while changing browser.
- Root cause: browser preference and host policies had separate public loaders even though
  they are one authoritative direct-runtime configuration document.
- Fix: parse and validate both fields from one read, return one frozen configuration
  snapshot, compose the default host exclusively from it, and validate/canonicalize retained
  policy state before setup rewrites the browser preference.
- Regression/evidence: config tests cover the single frozen snapshot and prove setup refuses
  to carry an invalid policy field into a new configuration.
- Status: implemented; final gate pending.

## BB-131 - Core builds retained deleted compiled modules

- Found: 2026-08-12 while auditing generated extension-era and compatibility residue.
- Minimal repro: delete a core source module and run the former `tsc` build; its old `.js`,
  declaration, and maps remain under `packages/core/dist`, unlike the clean MCP and driver
  builds. The working tree still contained the retired `version-skew` output.
- Root cause: the core package invoked TypeScript directly without first replacing its owned
  output directory.
- Fix: all core builds now use one clean build script, driver builds invoke that same path,
  and the boundary gate rejects known retired core/driver compiled modules.
- Regression/evidence: the final build and boundary stages must leave only outputs derived
  from the current source inventory.
- Status: implemented; final gate pending.

## BB-132 - Release workflow did not bind its three passes to one candidate

- Found: 2026-08-12 during final publication-path scrutiny.
- Minimal repro: allow one release stage to create or modify a non-ignored file between
  pass one and pass two. Each individual pass can prove only its own before/after digest,
  while the workflow discarded those receipts and still counted three successes. Linux
  also placed its live receipts inside the workspace candidate inventory.
- Root cause: the workflow loop treated exit status as the complete multi-pass invariant
  and wrote a package-only receipt after the fact.
- Fix: a cross-platform verifier now requires a clean tagged tree, parses every complete
  release receipt, requires one identical platform candidate digest and artifact hash
  across all three passes, rechecks cleanliness, and records commit plus Git tree. Linux
  live receipts are mounted outside the workspace. Publication requires matching Windows
  and Linux commit, tree, version, and tarball hash.
- Regression/evidence: the release workflow has one verifier path on both platforms and
  the publish job validates both bounded platform receipts against its checked-out tag.
- Status: implemented; final gate pending.

## BB-133 - Setup duplicated config-directory ownership checks

- Found: 2026-08-12 during final helper and error-surface deduplication.
- Minimal repro: compare first-use MCP configuration with `setup`; the setup utility used
  a second directory creator and a unique retired error code rather than the config
  module's authoritative path/ownership validation.
- Root cause: setup was implemented before configuration and identity utilities were
  collapsed onto one resolver.
- Fix: setup now calls the shared strict config-directory initializer and maps any setup
  failure to its one public setup code; the duplicate helper and code are removed.
- Regression/evidence: shared config tests cover absolute/non-root/link/directory behavior,
  and the final setup/live gate exercises the same initializer.
- Status: implemented; final gate pending.

## BB-134 - Identity login retained a wider origin limit

- Found: 2026-08-12 during exact-origin constant reconciliation.
- Minimal repro: pass an identity-login origin longer than 512 characters; the operator
  utility admitted up to 2,048 while MCP, host, runtime, proxy authority, registry, and
  documentation all use the 512-character product bound.
- Root cause: identity login carried an early URL-input cap instead of the final grant cap.
- Fix: identity login now uses the same 512-character limit before any store or browser
  access; additional-origin count and duplicate rules were already shared semantically.
- Regression/evidence: the identity-login suite rejects an otherwise origin-shaped value
  above the single product bound.
- Status: implemented; final gate pending.

## BB-135 - Doctor referenced removed Node-version constants

- Found: 2026-08-12 during pre-freeze static symbol reconciliation.
- Minimal repro: compile `cli.ts` after package-version centralization; the doctor report
  still reads `MINIMUM_NODE_MAJOR` and `MINIMUM_NODE_RANGE`, but their literals had been
  removed without replacing those uses.
- Root cause: runtime version identity and doctor engine reporting were changed in
  separate edits before the integrated compile gate.
- Fix: one strict adjacent package-manifest parser now supplies version, Node range, and
  derived minimum major to every CLI/doctor use. Invalid manifests fail at startup.
- Regression/evidence: existing version/help/doctor/package tests and the final workspace
  typecheck exercise the one manifest-derived metadata path.
- Status: implemented; final gate pending.

## BB-136 - MCP and core typechecking allowed inexact optional/index access

- Found: 2026-08-12 during final compiler-policy reconciliation.
- Minimal repro: construct an optional configuration field explicitly as `undefined` or
  index a protocol/config collection without narrowing; the driver rejects these patterns,
  while the root MCP/core compiler previously admitted them.
- Root cause: strict driver conversion enabled the three stronger flags only in the driver
  package rather than the shared workspace contract.
- Fix: `noImplicitOverride`, `noUncheckedIndexedAccess`, and
  `exactOptionalPropertyTypes` are now workspace-wide requirements. The final typecheck is
  the regression gate for every production and script TypeScript source.
- Regression/evidence: final integrated typecheck must pass without suppressions; any
  surfaced violation is fixed at its boundary rather than weakening these flags.
- Status: implemented; final gate pending.

## BB-137 - Real-site QA leaked its owned root on pre-host failure

- Found: 2026-08-12 during the final live-orchestration review.
- Minimal repro: make direct-host construction fail after the runner creates its owned
  config/profile root but before assigning `host`. The `finally` block only authorized
  root removal after a successful host close, so this setup failure retained the root.
- Root cause: cleanup confirmation was coupled to host cleanup even when no host or
  browser process had ever been created.
- Fix: absence of a constructed host is now authoritative confirmation that no host
  cleanup is required, allowing the independently identity-bound owned root to be removed.
  A real host cleanup failure still retains the root and fails closed for retry/diagnosis.
- Regression/evidence: the final real-site QA gate must report `cleanupConfirmed: true`
  and `temporaryRootRemoved: true` on setup-failure injection as well as success.
- Status: implemented; final gate pending.

## BB-138 - Core redaction relied on unchecked tuple and optional-state casts

- Found: 2026-08-12 when the frozen candidate first ran the strengthened final compiler
  gate.
- Minimal repro: compile `redaction.ts` with unchecked indexed access and exact optional
  properties. Array destructuring could produce `undefined`, and a broad cast could assign
  the optional `BrowserWaitFor.state` type instead of a proven state literal.
- Root cause: both boundaries relied on assertions that were accepted by the prior weaker
  root compiler configuration.
- Fix: the four bounding-box entries are converted and narrowed individually, and wait
  state is accepted only through an explicit closed literal check before assignment.
- Regression/evidence: the workspace build/typecheck must pass with the stronger flags;
  existing adversarial redaction tests cover malformed boxes and wait payloads.
- Status: implemented; final gate pending.

## BB-139 - Driver retained stale error and cursor-paint compatibility symbols

- Found: 2026-08-12 when the frozen candidate advanced from core into the driver build.
- Minimal repro: compile the driver with unused-parameter errors. The constructor called
  a deleted `driverError` helper, while two empty cursor-paint methods and their calls
  remained after the page-effects overlay path was removed.
- Root cause: the direct-runtime collapse deleted the implementation owners without
  deleting every call-site symbol from the monolithic driver.
- Fix: the constructor uses the one typed driver-error helper, and the inert cursor-paint
  calls and methods are deleted rather than suppressed or renamed.
- Regression/evidence: driver build/typecheck and the boundary scan must pass with no
  cursor-paint symbol or retired page-effects adapter.
- Status: implemented; final gate pending.

## BB-140 - Host boundaries constructed explicit undefined option fields

- Found: 2026-08-12 during the first full workspace typecheck with exact optional
  properties enabled.
- Minimal repro: typecheck MCP host/runtime construction. Several adapters supplied
  `property: undefined` instead of omitting an optional field; action/result normalization
  repeated conversions that did not preserve narrowing; one internal host branch tested
  the already-expanded `fill_form` action even though its driver type excludes it.
- Root cause: the previous compiler accepted loose optional construction and let a
  host-expansion compatibility check survive below its only valid layer.
- Fix: optional adapter fields now use conditional construction, values are narrowed once
  before projection, the observation options type is exported at its real boundary, and
  the impossible driver-host `fill_form` guard is deleted. No flag was weakened.
- Regression/evidence: the root and strict driver typechecks pass together with exact
  optional properties, unchecked indexed access, unused-symbol errors, and no suppression.
- Status: implemented; final gate pending.

## BB-141 - Eval corpus retained removed action compatibility shapes

- Found: 2026-08-12 during the first frozen-candidate deterministic run.
- Minimal repro: load the checked-in eval catalog after removing compatibility parsing.
  Several tasks still used a standalone `browser.wait_for` tool or a nested `target`
  object instead of the one public `browser.act` action grammar.
- Root cause: production admission was collapsed before its offline evaluation corpus and
  replay helper were migrated to the same exact contract.
- Fix: the eval schema and replay path no longer admit or translate `browser.wait_for`,
  and every checked-in task uses `browser.act` with flat target fields.
- Regression/evidence: catalog loading, provider-free replay, malformed-task, and agent-cost
  tests exercise only the one public action shape.
- Status: implemented; final gate pending.

## BB-142 - Granted paused related targets were never resumed

- Found: 2026-08-12 while reconciling the related-target containment regressions.
- Minimal repro: attach a paused about:blank related page, then deliver an allowed
  `Target.targetInfoChanged` URL. Newton advanced its ticket to `waiting_document` but
  never issued `Runtime.runIfWaitingForDebugger`, leaving the target permanently paused.
- Root cause: the allowed transition updated only Newton's ticket state; the corresponding
  Chromium resume acknowledgement was present on initial setup paths but missing here.
- Fix: the exact held related session is resumed before its allowed Document settlement
  is awaited. Denied targets remain closed without resume.
- Regression/evidence: the focused driver regression requires the exact child-session
  resume command and still proves denied/uncertain targets fail closed.
- Status: implemented; final gate pending.

## BB-143 - Screenshot metadata retained untrusted page titles

- Found: 2026-08-12 when the screenshot redaction regression reached the frozen gate.
- Minimal repro: capture a screenshot on a page whose title contains a card or account
  label. Pixel data was removed from metadata, but the page-derived title remained.
- Root cause: screenshot normalization removed the image payload without applying the
  same content-free rule to adjacent page metadata.
- Fix: screenshot publication now removes both the encoded image and page title from
  metadata; only the separately validated image result and bounded safe facts remain.
- Regression/evidence: the adversarial screenshot test injects a sensitive title and
  asserts that it is absent from the MCP result.
- Status: implemented; final gate pending.

## BB-144 - Browser-page auto-attach rollback masked setup failures

- Found: 2026-08-12 after renaming the dedicated-process browser-page auto-attach stage.
- Minimal repro: make browser-session `Target.setAutoAttach` reject during attach. Rollback
  immediately attempted the matching disable command even though enable never succeeded;
  that second failure became `containment_fence_failed` and hid the exact setup code.
- Root cause: cleanup inferred relationship setup from the existence of a browser-control
  session rather than tracking acknowledgement of the auto-attach transition.
- Fix: the driver records browser-page auto-attach as active only after its enable ACK,
  disables it only in that state, and clears the state on detach or debugger loss.
- Regression/evidence: attach-stage, root-detach retry, and popup teardown tests cover both
  pre-ACK rollback and genuinely active cleanup paths.
- Status: implemented; final gate pending.

## BB-145 - Prevented actions were projected as successful MCP tool calls

- Found: 2026-08-12 during the final modern MCP contract run.
- Minimal repro: invoke `browser.act` for a causally prevented navigation. The action
  envelope correctly reports `ok:false`, but the surrounding MCP tool result omitted
  `isError:true`.
- Root cause: the tool-result wrapper treated every successfully transported action
  envelope as a successful tool call instead of preserving the action's authoritative
  `ok` bit.
- Fix: `browser.act` sets MCP `isError` whenever the canonical action result is not
  successful, without flattening or replacing the typed action outcome.
- Regression/evidence: the MCP contract test requires both `isError:true` and the exact
  prevented action envelope; Windows and Linux containment live suites pass.
- Status: implemented; pre-freeze matrix passed.

## BB-146 - Console and network admission constructed absent options as undefined

- Found: 2026-08-12 under the workspace exact-optional compiler contract.
- Minimal repro: call `browser.console` or `browser.network` without optional filters.
  Host construction supplied explicit `undefined` properties, which the strict action
  parser rejects even though the public request correctly omitted them.
- Root cause: MCP projection copied every schema field mechanically rather than adding
  optional fields only after narrowing.
- Fix: construct console/network actions conditionally and omit every absent property.
- Regression/evidence: focused MCP tests call both tools with no optional filters; full
  typecheck, deterministic, packed, and live matrices pass.
- Status: implemented; pre-freeze matrix passed.

## BB-147 - Connected QA retained removed targeting and observation assumptions

- Found: 2026-08-12 during the first complete modern-only live run.
- Minimal repro: run the frame, input, dialog, or containment harness after strict target
  admission and the 240-node cap landed. Harnesses still used partial role/name targets,
  requested 320 nodes, or required same-origin child provenance that the public contract
  intentionally does not duplicate.
- Root cause: production compatibility paths were deleted before all live acceptance
  callers were migrated to the one exact public contract.
- Fix: use strict role/name pairs, the public observation cap, null-safe names, bounded
  MCP error codes, and provenance assertions that distinguish same-process from OOPIF
  routes. No production compatibility parser was restored.
- Regression/evidence: static harness contracts plus Chrome, Edge, and pinned Linux CFT
  frame/input/dialog/containment runs pass.
- Status: implemented; pre-freeze matrix passed.

## BB-148 - Containment QA conflated zero-request enforcement with causal prevention

- Found: 2026-08-12 during connected popup and mutation acceptance.
- Minimal repro: a side effect can return a completed action while the launch-time proxy
  independently prevents the denied request; conversely a same-origin popup click can be
  intentionally rejected by the commit floor before any popup exists. The old harness
  required every zero-request case to say `prevented` and called floored popup actions
  allowed successes.
- Root cause: acceptance collapsed two independent security facts--action causality and
  network enforcement--and retained a product claim contradicted by the current floor.
- Fix: validate action outcomes against their exact causal class, always require denied
  application counters to remain zero, and label floored popup cases `not_started` rather
  than allowed. Granted non-popup frame and redirect flows still prove positive routing.
- Regression/evidence: deterministic outcome classification and the Chrome, Edge, and
  Linux containment counter matrices pass.
- Status: implemented; pre-freeze matrix passed.

## BB-149 - Real-site QA depended on consent and anti-automation landing pages

- Found: 2026-08-12 in public Windows Chrome/Edge QA.
- Minimal repro: YouTube redirects a clean isolated identity through a regional consent
  flow and Reddit can serve an automation challenge, making a read-only availability test
  measure account/challenge policy instead of Newton's browser control.
- Root cause: the suite chose volatile interactive landing pages for sites whose public
  logged-out access varies by region and automation policy.
- Fix: use the sites' public `robots.txt` endpoints for bounded text-mode reachability and
  keep full AX/action/screenshot coverage on RFC Editor, Wikipedia, Mercato di Bellina,
  W3C WAI, and Meta's public business ads surface. Receipts state the coverage mode; they
  do not imply authenticated access.
- Regression/evidence: all seven public sites pass Windows Chrome, Windows Edge, and
  pinned Linux CFT with zero session/identity residue.
- Status: implemented; pre-freeze matrix passed.

## BB-150 - The clean-tree release verifier could not launch pnpm on Windows

- Found: 2026-08-12 at the first immutable three-pass boundary.
- Minimal repro: invoke `node scripts/release-three-pass.mjs` on Windows with no inherited
  `npm_execpath`. The verifier directly spawned `pnpm.cmd`; Node 25 rejects that child
  process with `spawn EINVAL` before pass one begins.
- Root cause: the direct Node invocation path treated a Windows command shim as a native
  executable. The pnpm-invoked path was unaffected because it already ran pnpm's JavaScript
  entrypoint through `process.execPath`.
- Fix: one strict resolver now launches an exact regular pnpm JavaScript entrypoint through
  Node on Windows, retains the inherited exact entrypoint under pnpm, and uses the native
  command only on Unix.
- Regression/evidence: focused tests prove both launch paths and forbid a `.cmd` command;
  the direct-Node test explicitly suppresses the parent pnpm environment, and the final
  three-pass verifier is restarted from zero on the refrozen tree.
- Status: implemented; final immutable execution pending.

## BB-151 - Artifact reproducibility depended on repeated third-party site availability

- Found: 2026-08-12 during immutable pass two after an identical pass-one matrix.
- Minimal repro: run the complete release gate twice. Pass one reaches YouTube's public
  text endpoint; pass two times out there while Reddit, Mercato, W3C, Meta, both direct
  suites, cleanup, and the identical artifact remain healthy.
- Root cause: the three-pass artifact verifier reran every volatile public site, coupling
  Newton reproducibility to consent, challenge, routing, and availability policies owned
  by unrelated third parties.
- Fix: the seven-site matrix remains mandatory once on Windows Chrome, Windows Edge, and
  pinned Linux Chrome, with bounded failure and cleanup receipts. The three unchanged-tree
  repetitions cover deterministic checks, source direct-browser behavior, and the exact
  packed artifact only.
- Regression/evidence: release-wiring tests require real-site evidence to be declared
  separate and absent from the repeated script; the bounded preflight receipt records all
  three successful seven-site lanes.
- Status: implemented; final immutable execution pending.

## BB-152 - Windows CI rejected every root beneath its junction-backed temp directory

- Found: 2026-08-12 in pull-request Windows validation.
- Minimal repro: create a regular profile-store directory or hermetic eval root beneath a
  parent reached through a Windows junction. The leaf is a real directory, but its full
  canonical path differs from the lexical temp path, producing `profile_store_invalid` or
  `local write escaped hermetic root`.
- Root cause: leaf-link protection compared the complete lexical and canonical paths,
  thereby rejecting a safe operating-system ancestor reparse point as if the owned leaf
  itself were a link. Hermetic validation likewise mixed a lexical root with canonical
  report paths.
- Fix: require the leaf to remain a regular non-link directory whose canonical location is
  the exact basename under its canonical parent, store only that canonical root, and
  canonicalize the hermetic parent before creating descendants. A linked store leaf remains
  rejected.
- Regression/evidence: profile-store and eval tests create real Windows junction ancestors,
  prove normal operation and exact cleanup through them, and separately prove a linked
  store leaf is refused.
- Status: implemented; PR validation pending.

## BB-153 - Windows CI rejected safe files and cleanup beneath junction-backed ancestors

- Found: 2026-08-12 in the second pull-request Windows validation.
- Minimal repro: create a regular browser executable, opaque source profile, or guardian
  identity beneath the runner's junction-backed temp/workspace ancestor. Discovery and
  launch report the executable invalid, import reports the source invalid, and guardian
  cleanup leaves the otherwise proven identity behind.
- Root cause: the first junction correction covered profile-store and eval roots only.
  Three remaining boundaries still required the complete lexical path to equal its
  canonical path, conflating a trusted ancestor reparse point with a linked leaf.
- Fix: validate each leaf with `lstat`, canonicalize its parent, require the canonical
  leaf to be the exact basename beneath that parent, and retain existing file type,
  link-count, owner-marker, device/inode, and nonce checks. Opaque source facts are stored
  only with the canonical user-data root.
- Regression/evidence: browser discovery, Chromium launch, profile import, and guardian
  tests exercise real linked/junction ancestors; separate cases continue to reject
  linked executable, source, and store leaves. The identity CLI contract also requires
  closure verification against the canonical source root. The affected 38-test suite,
  complete 563-test suite, token budgets, and workspace strict typecheck pass locally.
- Status: implemented; PR validation pending.

## BB-154 - Linux validation retained Windows paths and racy socket/path assertions

- Found: 2026-08-12 while independently reproducing the pull-request Ubuntu test hang in
  a clean Node 24 Linux container.
- Minimal repro: run the complete test suite from `/work`. Two policy-proxy tests assert a
  remote client socket's `closed` property immediately after the server-owned proxy drain;
  one config test treats `C:/...` as absolute; and build parity searches for the unbounded
  substring `/work`, which matches ordinary `/worker` text in production output. The four
  failures leave failed-test network fixtures resident and make the Node process appear
  hung after printing its summary.
- Root cause: the tests mixed a server resource-ownership acknowledgement with the peer's
  later local close event, and embedded Windows/long-checkout assumptions in nominally
  cross-platform assertions.
- Fix: explicitly await the peer socket close event after authoritative proxy cleanup,
  construct config paths from the host temporary root, and require the workspace needle
  to end at a path separator.
- Regression/evidence: the exact full suite passes 563/563 with zero skips and exits
  normally in a clean Node 24 Linux container. GitHub's Windows, Ubuntu, and packed
  release lanes are required before merge.
- Status: implemented; PR validation pending.

## BB-155 - Driver parity builds raced concurrent core imports

- Found: 2026-08-12 during focused verification of the Linux CI corrections.
- Minimal repro: run the policy, config, and driver build-parity files in one Node test
  process. The parity test invokes two custom driver builds; each removes and rebuilds
  `packages/core/dist`, so a concurrent config import can fail with
  `ERR_MODULE_NOT_FOUND` during the deletion window.
- Root cause: the exported driver builder treated an isolated custom output build as a
  complete package build and mutated the shared core output every time.
- Fix: only the normal default-destination driver build refreshes core. Custom parity
  destinations compile against the already-built core and never mutate shared output.
- Regression/evidence: parity records the core entry's device, inode, and nanosecond
  modification time around both custom builds and requires all three to remain exact;
  the clean Linux full suite passes 563/563 with zero skips.
- Status: implemented; PR validation pending.

## BB-156 - First guarded release could not enter platform verification

- Found: 2026-08-12 in release workflow run `31656823021`; publication was skipped and
  neither GitHub Release nor npm package was created.
- Minimal repro: mount a runner-created `0700` Linux results root into the image's fixed
  UID 10001, or run the Windows three-pass verifier after setup-node exports an
  `npm_execpath` beneath its Node toolcache where pnpm is not installed.
- Root cause: the Linux workflow did not align container and mount ownership. The Windows
  resolver treated a stale inherited pnpm path as authoritative and never consulted the
  active `PNPM_HOME` installed by pnpm/action-setup.
- Fix: run the pinned Linux image as the exact host runner UID/GID, preserving non-root
  execution and a private runner-owned results directory. On Windows, use an existing
  exact inherited pnpm entrypoint when valid, otherwise resolve the exact regular
  `pnpm.cjs` adjacent to the active `PNPM_HOME`; explicit caller paths remain strict.
- Regression/evidence: workflow contract tests require UID/GID propagation and the pnpm
  resolver test reproduces the setup-node/pnpm-action directory layout with absent stale
  state. Explicit test inputs suppress both ambient pnpm paths so hosted-runner state
  cannot change fixture resolution. The corrected tagged workflow must pass both
  three-pass jobs before publication.
- Status: implemented; release verification pending.

## BB-157 - Windows live cleanup mixed two canonical path representations

- Found: 2026-08-12 in the corrected guarded release's first Windows pass, after all
  deterministic/package checks and real Chrome behavior succeeded.
- Minimal repro: run `direct-runtime-live.mjs` with `os.tmpdir()` expressed as a Windows
  8.3 path. The parent is captured with non-native `realpathSync`, while the owned child
  and cleanup check use `realpathSync.native`; exact parent comparison fails after the
  browser/session cleanup is already confirmed.
- Root cause: one ownership record mixed two Node canonicalization APIs.
- Fix: capture the temp parent with `realpathSync.native` just like creation and removal.
  No target, ownership, marker, device/inode, or deletion check is relaxed.
- Regression/evidence: the live-suite contract requires native canonicalization of the
  temp parent; the next tagged Windows release pass must prove real cleanup three times.
- Status: implemented; release verification pending.

## BB-158 - Operator login silently discarded exact-origin denial evidence

- Found: 2026-08-18 while reproducing an inert Google sign-in Next button with a
  persistent Newton identity and grants for `accounts.google.com`, `ads.google.com`, and
  `www.google.com`.
- Minimal repro: start `identity login`, enter the account personally, and activate Next.
  The policy proxy rejects ungranted destinations before an upstream connection, but the
  login command previously printed no reason or destination. A diagnostic run observed
  a denied `https://www.gstatic.com` attempt from the sign-in load; it also demonstrated
  why Newton must not guess a provider bundle, because Chrome background services
  independently attempted several unrelated Google API origins.
- Root cause: the proxy retained only aggregate reason counters. Its canonical parsed
  origin was discarded at the enforcement boundary, before CDP network diagnostics
  could observe the request.
- Fix: the proxy now emits each canonical denied origin once through a capped private
  callback. Only the operator `identity login` utility projects it as a typed
  `blocked_origin`/`origin_denied` JSON event. Paths, queries, headers, content, and
  credentials are never included; callback failure cannot change the 403 decision; and
  the live grant set is never widened.
- Regression/evidence: focused proxy tests prove exact-origin-only output, deduplication,
  zero upstream connections, callback-failure isolation, and no diagnostic field in the
  aggregate ledger. Login tests prove the closed receipt and duplicate suppression.
  Strict workspace typecheck, 29 focused tests, MCP build, and diff validation pass. A
  real contained Chrome run emitted the typed events and then confirmed process, proxy,
  and identity cleanup.
- Live confirmation: with `accounts.google.com`, `ads.google.com`, `www.google.com`, and
  `www.gstatic.com` granted, Google redirected the main frame to
  `https://accounts.google.ca/accounts/SetSID...`. Newton emitted the exact typed
  `blocked_origin`/`origin_denied` receipt for `https://accounts.google.ca`; the visible
  page showed `ERR_BLOCKED_BY_CLIENT` and `Connection failed (-111)`. This proves that
  failure was containment, not credentials or Cloud Identity licensing. Other Google
  service/font/analytics origins in the stream were not proven necessary and remain
  ungranted.
- Status: implemented and live-proven for exact-origin reporting. Navigation-versus-
  optional-background prioritization now uses a private CDP request classifier that adds
  only `main_frame_navigation`, `frame_navigation`, or `subresource` to a bounded receipt;
  the authenticated main-frame request event also records authoritative
  `ungranted_navigation` for the active action before a proxy-first failure can leave an
  inert, apparently successful click. Frame/subresource denials remain diagnostic-only.
  Public network entries retain only the closed request class and `origin_denied`
  decision. An operator approve/restart UI remains separate usability work. A
  provider-wide grant bundle is intentionally not a Newton default.

## BB-159 - Codex configuration could be switched to an unverified or protocol-disabled Newton build

- Found: 2026-08-18 after Codex was pointed from a working 0.4.5 package to the newer
  0.5.0 source entrypoint and then had to be reverted. Codex 0.147.0 had modern MCP
  support installed but its `mcp_2026_07_28` feature was disabled, and the server entry
  lacked `CODEX_MCP_PROTOCOL_VERSION=2026-07-28`, so Codex used its older protocol path
  and Newton's tools disappeared.
- Minimal repro: edit the Codex MCP table to any existing Newton entrypoint. The old
  installer validated only filesystem shape and wrote the table without starting the
  candidate or checking its tool catalog.
- Root cause: package version, client feature selection, protocol environment, and
  required tool discovery were not one installation transaction. An exact path prevented
  floating resolution but did not prove that Codex would invoke that binary with the
  protocol it implements. The first attempted verifier repeated the same mistake by
  testing the legacy `initialize` handshake; it was rejected during review and replaced.
- Fix: before a non-dry-run Codex install, Newton now launches the exact candidate with a
  bounded stateless `2026-07-28` discovery/tool-list exchange under a fresh isolated
  Newton configuration, requires the exact package version, all ten required
  `browser.*` tools, clean exit, and bounded output. Only a successful probe can reach
  the existing atomic config writer. The same write enables Codex's
  `mcp_2026_07_28` feature, pins `CODEX_MCP_PROTOCOL_VERSION` and
  `NEWTON_BROWSER_EXPECTED_VERSION`, and the server refuses a mismatched package at
  startup.
- Regression/evidence: installer tests cover complete modern discovery, exact version,
  complete tool catalog, protocol environment, feature activation, isolated probing,
  mismatch refusal, and verified atomic writes. The focused 39-test suite, strict
  typecheck, MCP build, and diff validation pass. The deterministic five-file 0.5.0
  artifact (`26b498047de3b1679e3f0af2cb8a9c0d020535021a7b2822e53bb8ae629946eb`)
  was installed to its versioned local directory; its live doctor confirmed private-CDP
  Chrome startup, containment-before-navigation, and cleanup. The active Codex table now
  resolves only that entrypoint, both version/protocol environment guards are present,
  `codex features list` reports `mcp_2026_07_28` true, and 20 already-running 0.4.5 MCP
  child processes were terminated with zero remaining.
- Status: superseded locally by immutable `0.5.1`. Its exact five-file artifact is
  installed under the versioned local root, Codex is transactionally pinned to that
  entrypoint and exact expected version, and installed `doctor --live` passed. Existing
  tasks retain their already-started 0.5.0 children until the application restarts; new
  tasks cannot accept those bytes as 0.5.1. Full release verification remains pending.

## BB-160 - Active MCP session was mistaken for an operator-visible browser

- Found: 2026-08-18 when an agent reported that Chrome was open solely because
  `browser.session.start` returned an active session, while the operator correctly saw no
  window.
- Root cause: production correctly defaults MCP sessions to headless Chromium and uses
  headful mode only for operator `identity login`, but the public tool description and
  operating skill did not state that distinction.
- Fix: the tool catalog now calls `browser.session.start` headless. README, MCP client,
  troubleshooting, and skill guidance explicitly forbid equating active state with a
  visible window and direct personal authentication to the separate headful login flow.
  No current-tab attachment or handoff surface was added.
- Regression/evidence: MCP contract/tool-catalog verification and skill validation must
  confirm the new description and absence of retired handoff/current-tab contracts.
- Status: implemented; MCP catalog, 576-test integrated suite, and connected direct-live
  suite pass on the 0.5.1 candidate.

## BB-161 - Persistent identity selection depended on conversational memory

- Found: 2026-08-18 after a signed-in identity worked across restarts only when an agent
  remembered and resupplied its opaque ID.
- Root cause: persistent identities and exclusive leases existed, but operator config
  contained no durable selection policy. Making one identity global would unnecessarily
  expose authenticated state to unrelated sites and serialize all concurrent sessions.
- Fix: add bounded operator-only `identityBindings`, each mapping one exact primary origin
  to one existing opaque identity. `identity bind`, `identity bindings`, and `identity
  unbind` manage them atomically. A binding applies only when a session omits
  `identityId`; an explicit ID wins, unrelated origins remain ephemeral, and the existing
  exclusive lease rejects concurrent reuse. Bound identities cannot be deleted until
  unbound. Bindings never widen the network grant.
- Regression/evidence: config tests cover strict shape, exact-origin matching, atomic
  preservation, replacement, removal, malformed values, and duplicate rejection. Host
  tests cover bound reuse, unrelated ephemeral isolation, browser-family selection,
  lease contention, and malformed binding rejection. Spawned CLI tests prove durable
  bind/list/unbind behavior. The installed 0.5.1 CLI bound the operator identity to the
  exact `accounts.google.com` and `ads.google.com` primary origins; unrelated origins
  remain ephemeral.
- Status: implemented and locally configured; application restart proof remains.

## BB-162 - Installed Newton Browser skill published removed 0.4.5 contracts

- Found: 2026-08-18 in the active Newton plugin cache. It instructed agents to use
  removed `instanceLabel`, `browser.session.finalize`, screenshot file/inline delivery,
  and 0.4.5 references while Codex was running Newton Browser 0.5.0.
- Root cause: the Newton Browser repository skill had moved to the modern contract, but
  the Newton plugin marketplace source and installed cache retained an older snapshot.
- Fix: synchronize the authoritative skill, both Newton plugin source copies, and the
  installed plugin cache to the compact 0.5.1 contract, including modern stateless MCP,
  ten tools, headless MCP sessions, headful operator login, exact-origin denial handling,
  and origin-scoped identity bindings.
- Regression/evidence: the skill validator passes for authoritative, marketplace, and
  installed copies; a cross-copy scan finds no removed contract tokens. The next plugin
  package refresh must retain the synchronized files rather than regenerating the stale
  snapshot.
- Status: source and installed cache synchronized and validator-clean; next plugin
  package/version refresh remains pending.

## BB-163 - Same-version local candidates could conceal stale installed bytes

- Found: 2026-08-18 after the installed 0.5.0 entrypoint and the corrected candidate
  reported the same package version while their compiled bytes differed.
- Root cause: the expected-version startup guard correctly rejected other versions, but
  semver had not advanced after material post-candidate remediation. A same-version
  overwrite would defeat the operator's ability to distinguish the two builds.
- Fix: advance the corrected candidate and every current contract reference to 0.5.1,
  build one deterministic five-file tarball, install it to a new versioned directory,
  and use the verified installer to pin Codex to that exact local entrypoint with
  `NEWTON_BROWSER_EXPECTED_VERSION=0.5.1`.
- Regression/evidence: build, strict typecheck, 576/576 tests, agent-cost limits, source
  Chrome direct-live (eight stages), seven public real-site surfaces including YouTube,
  Reddit, Mercato di Bellina, and Meta Ads, packed Chrome and Edge
  action/containment/cleanup,
  exact artifact SHA-256
  `4a214db96511c499daee1c7cf682f88413626e08290318bb655346d066e657c5`,
  transactional Codex probe/write, and installed live doctor all pass.
- Status: implemented locally. A Codex restart is required to retire active task-owned
  0.5.0 server children and load 0.5.1; Linux and three unchanged-tree release passes
  remain release gates, not local-usability blockers.

## BB-164 - Bound identities still required agents to repeat redirect grants

- Found: 2026-08-18 when a visible account flow redirected from the configured primary
  origin to a regional account origin and then to a separate account-management origin.
  The identity was already bound, but every worker still had to remember the opaque ID
  and reconstruct the approved redirect list. The browser displayed an opaque blocked
  page while the useful origin diagnostic existed only in the utility stream.
- Root cause: identity selection and network authorization were separate one-run inputs.
  Configuration could select a persistent identity but had no exact-primary-origin grant
  policy, and a prevented MCP action discarded the driver's authoritative main-frame
  denied-origin fact at the public result boundary.
- Fix: add bounded operator-owned `originGrants`, merge the matching reviewed origins
  automatically into MCP and visible-login sessions, and allow `identity login --origin`
  to select the bound identity without its opaque ID. A causally prevented main-frame
  navigation now returns only canonical `blockedOrigin` plus
  `requestClass:"main_frame_navigation"`; subresources and background requests cannot
  fabricate that signal, and no newly requested origin authorizes itself.
- Regression/evidence: strict config/CLI/host/login/driver/redaction/MCP tests cover
  matching, nonmatching, malformed, overflow, privacy, and propagation behavior. The
  complete 0.5.2 candidate passes build, typecheck, boundary validation, 583/583 tests,
  token budgets, eight-stage Windows Chrome direct-live, seven public production sites,
  and exact-packed Chrome and Edge action/containment/cleanup. Its five-file package is
  132,794 bytes with SHA-256
  `db83357367ba7bd47627cbd21ae5424d9eee1efcef9a233fd00972bf1afe6943`.
- Status: implemented, Windows-verified, and installed as immutable 0.5.2. Codex is pinned
  to that exact version; both primary policies are written, installed live doctor passes,
  and ID-less visible login proved automatic binding plus six exact grants before clean
  shutdown. One application restart remains to replace task-owned 0.5.1 MCP children.

## BB-165 - Newton's network boundary broke normal browser behavior systemically

- Found: 2026-08-18 through 2026-08-19 during visible Google account/login flows and
  public-site rendering. Valid regional redirects produced `ERR_BLOCKED_BY_CLIENT` and
  connection error `-111`; pages briefly signed in and then reverted; required styles,
  fonts, images, APIs, frames, and icon fonts were missing; controls could appear inert.
- Root cause: the product treated a modern browser session as a small exact-origin
  allowlist. The launch-time proxy, CDP Fetch interception, popup/worker denial machinery,
  and network-disabling Chromium flags rejected normal browser dependencies by design.
  Provider-specific grant bundles could only chase symptoms and would remain incomplete.
  Persistent page instrumentation and screenshot script/animation freezing added a
  separate fidelity risk even when network requests succeeded.
- Fix: remove the policy proxy, origin grants/config/CLI, Fetch interception, request
  denial, blocked-origin metadata, popup containment tickets, and network-altering launch
  flags. Use Chromium's normal network stack. Remove focus emulation, persistent mutation
  observers, and screenshot script/animation freezing. Keep isolated process/profile
  ownership, private CDP, guardian cleanup, trusted input, action verification, the
  credential/payment safety floor, and post-capture raster masking.
- Regression/evidence: public schemas reject the removed fields; build artifacts omit the
  removed modules; the real-site matrix requires usable video, community, commerce,
  advertising, reference, accessibility, and standards pages and rejects browser-generated
  blocked pages, connection failures, and raw icon ligatures. Deterministic, packed,
  Chrome/Edge, and three consecutive unchanged-tree release checks pass. The clean-profile
  community surface remains an honest external-site negative rather than an allowlist or
  product workaround.
- Status: implementation, documentation, and release gates complete. This entry
  supersedes BB-158 through BB-164 as current product behavior. Those entries remain
  historical records of the retired 0.5.1/0.5.2 architecture.

## BB-166 - Generic wait and selector assumptions broke dynamic production pages

- Found: 2026-08-19 while running the normal-network candidate against real video and
  commerce pages. `wait_for` could time out on an attached but non-visible element;
  responsive desktop/mobile duplicates made an otherwise exact selector ambiguous; and
  focus/scroll-driven rerenders could retire a selected input before a fill dispatched.
- Root cause: one visibility predicate was reused for every selector wait state, selector
  targeting counted hidden DOM duplicates as actionable ambiguity, and fill retained one
  backend node across pre-input focus and geometry preparation.
- Fix: model attached and visible separately; evaluate checked, unchecked, and value
  states against the resolved element; choose a selector only when exactly one visible
  match exists; and permit a bounded exact selector/semantic refresh only before any
  input is dispatched. Explicit stale refs are never healed automatically.
- Regression/evidence: deterministic tests cover every wait state, visible-vs-hidden
  duplicates, focus replacement, and scroll replacement. The real commerce search/fill
  and trusted-mask flow passes in Chrome after a retry-safe fresh observation, while the
  full Chrome and Edge seven-stage direct suites remain green.
- Status: fixed and verified in the 0.6.0 candidate.

## BB-167 - Agent guidance allowed a stale worktree browser to impersonate 0.6.0

- Found: 2026-08-19 when a visible Facebook login page rendered without its normal CSS
  despite the immutable 0.6.0 package using ordinary Chromium networking.
- Minimal repro: a Codex task invoked a worktree `apps/mcp-server/dist/index.js` directly
  with retired `--allow-origin` arguments. Its Chrome process contained the retired local
  proxy, background/component/sync disabling, site-process, and QUIC switches.
- Root cause: the skill described the correct 0.6.0 behavior but did not prohibit agents
  from substituting a source checkout, Codex worktree, global CLI, or older package for
  the configured immutable entrypoint. The advertised 0.3.17 cache was also empty while
  the fallback 0.3.13 cache retained 0.5.2 instructions.
- Fix: require every CLI workflow to use the exact entrypoint configured in
  `[mcp_servers.newton-browser]`, require version 0.6.0 before visible login, and forbid
  worktree/global/npx/older entrypoints plus all retired grant arguments. Synchronize the
  source skill and both installed cache versions.
- Regression/evidence: the skill contract test asserts the immutable-entrypoint rule and
  retired-option prohibition. The stale process tree was closed; a replacement visible
  login launched from the installed 0.6.0 package with no proxy or retired network flags.
- Status: fixed; installed skill caches synchronized byte-for-byte.

## BB-168 - Post-action network traffic was falsely reported as prevention

- Found: 2026-08-19 in two independent authenticated workflows: Google Ads account
  onboarding and Meta Developers application authorization.
- Minimal repro: dispatch a trusted click whose normal SPA behavior emits a POST. The
  driver sent mouse-down/up, observed the POST, returned `blocked`, and the host converted
  the already-dispatched action to `outcome:prevented,retrySafe:true`. Workers stopped the
  session, retried login, or changed control planes even though Newton had not prevented
  anything.
- Root cause: `isNetworkWrite` treated every non-GET/HEAD/OPTIONS request as a business
  write; post-action reconciliation confused observation with prevention; and the host
  accepted any driver `blocked` status as proof that no input had run.
- Fix: remove network-write action signals and every `post_action_*` blocking path. Keep
  network metadata in `browser.network`; directly observable navigation/dialog/download/
  target facts may verify a delivered action but never block it. A driver-level blocked
  result after admission is now `outcome_unknown,retrySafe:false`. Visible identity login
  treats operator window exit as normal completion only after exact runtime and lease
  cleanup succeeds. Agent guidance requires same-session observation before retry,
  teardown, or another authentication request.
- Regression/evidence: deterministic driver tests cover POST and GET traffic without
  action failure, host tests reject post-admission prevention, and identity-login tests
  require cleanup-confirmed window-close completion. The frozen 0.6.1 candidate passes
  471 deterministic tests plus the full Chrome and Edge source-live and exact-packed
  runtime matrices. Public-site QA covers video, commerce, advertising, reference,
  accessibility, and standards surfaces; Reddit remains a bounded external-site content
  negative rather than a Newton prevention or rendering failure.
- Status: fixed and verified in the 0.6.1 release candidate.

## BB-169 - Same-document ref retention permanently exhausted long-lived agent sessions

- Found: 2026-08-19 in an authenticated Meta Ads Manager draft after 95 serialized
  commands. `browser.observe` failed with `max_refs_exceeded`; a semantic click could not
  resolve a target, and a coordinate click dispatched but its post-action observation hit
  the same cap and truthfully returned `outcome_unknown`.
- Minimal repro: keep one document epoch alive while successive SPA snapshots expose more
  than 1,024 distinct backend nodes. The registry counts every active and terminal ref
  created since the document commit, although only the newest observation is useful.
- Root cause: `refIndex` was refreshed per observation but `TargetRegistry.refs` and
  `deadRefs` were only cleared by a top-level document commit. Invisible and filtered
  candidates were also registered before being discarded from output, consuming capacity
  without ever giving the agent a usable ref.
- Fix: start every interactive observation with a bounded ref cycle reset; retain only refs
  emitted by the current snapshot; discard invisible, filtered, duplicate, and otherwise
  non-emitted candidates. Missing old refs remain fail-closed as `stale_target`, stable
  surviving nodes recreate the same deterministic ref, and text observations remain
  ref-free so they can verify an uncertain result without altering the interactive cycle.
- Regression/evidence: deterministic registry tests cover active/terminal release,
  stale-old-ref behavior, and candidate discard. Driver tests run changing SPA snapshots
  through a deliberately tiny ref cap, prove stable current refs and bounded counts, and
  prove text observation preserves the current ref. The complete suite passes 475/475.
  Chrome and Edge each replace 260 controls through four same-document generations,
  observe 250 nodes per cycle, continue cross-origin navigation, and clean to zero residue.
  Exact-packed Chrome and Edge pass from the deterministic 117,455-byte artifact with
  SHA-256 `f936f3363d410817ffb9e6323f5990ec2d7f88f7b540b0aa81a295e1cd0ed549`.
- Status: fixed and verified in the 0.6.2 release candidate.

## BB-170 - A session-owned authentication tab stranded control on the opener

- Found: 2026-08-20 in an authenticated Google Ads manager-link flow on 0.6.2. Preview
  opened a separate `Confirm it's you` page. The confirmation click returned
  `input_release_unacknowledged`; Newton kept observing the opener, Chrome displayed
  `Debugger paused in another tab`, and a coordinate click on that browser-chrome banner
  timed out and poisoned the opener as `renderer_unresponsive`. The manager-link Send
  action was never dispatched.
- Root cause: browser-session page auto-attach intercepted the provisional `about:blank`
  popup and ran setup/activation before Chromium performed the opener-requested
  navigation. That could strand the provisional page behind Chrome's debugger banner.
  The driver also had no active-page context, so implicit page commands stayed on the
  opener, and cross-session target delivery could occur after the click's first action
  signal window. Browser chrome is not part of a page target, so a coordinate click could
  never repair that state.
- Fix: replace browser-session page auto-attach with browser target discovery. Record an
  exact provisional target without attaching, configuring, or activating it. Only after
  the same target commits to an HTTP(S) URL and its opener belongs to this Newton session
  does Newton attach, configure, activate, and build its fresh page registry. Implicit
  page-domain CDP and trusted input route through the active page session; exact post-input
  snapshots reconcile a committed target that crosses the action-signal boundary. Closing
  the secondary restores/rebuilds the opener. An explicitly attached waiting page is
  resumed before setup. Setup failure closes the exact incoming page and capacity remains
  bounded.
- Regression/evidence: deterministic tests prove zero attach/setup/activation commands for
  a provisional blank target, commit-gated activation, implicit-vs-browser CDP routing,
  resume-before-enable ordering, active-page registry isolation, inactive event rejection,
  exact opener restoration, setup-failure close, and click fence/settle/reconciliation
  ordering. Real Chrome and Edge each open, observe, and click a secondary page, close it,
  verify the opener through the same MCP session, continue cross-origin navigation, and
  clean to zero residue.
- Status: fixed and source/Chrome/Edge/exact-packed verified in the 0.6.3 candidate; final
  consecutive release receipts are the remaining external gate.

## BB-171 - Windows Edge relaunch discarded inherited private CDP pipe handles

- Found: 2026-08-20 while running the BB-170 live matrix in Edge. The owned runtime failed
  at `protocol_readiness` with no browser stderr or profile/policy error, while Chrome
  passed the identical private-pipe flow.
- Root cause: Windows Edge can relaunch through its compatibility layer and lose inherited
  file descriptors, including Newton's private CDP pipe. Microsoft's Playwright Chromium
  launcher documents the same Edge behavior and uses
  `--edge-skip-compat-layer-relaunch` to keep the original process and descriptors.
- Fix: add that one family-specific switch only for Edge on Windows. Chrome and non-Windows
  Edge launch arguments remain unchanged; Newton did not add TCP debugging or a fallback
  control plane.
- Regression/evidence: launch-argument tests prove the flag is present only for Windows
  Edge. A real installed Edge then passes process readiness, private CDP, secondary-page
  control, opener restoration, cross-origin navigation, exact shutdown, and temp cleanup.
- Status: fixed and source/Chrome/Edge/exact-packed verified in the 0.6.3 candidate; final
  consecutive release receipts are the remaining external gate.
