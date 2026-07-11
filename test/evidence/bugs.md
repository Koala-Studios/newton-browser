# Browser Bridge Defect Ledger

All defects below have deterministic regression coverage. Foundation defects BB-001 through BB-009 and BB-011 through BB-012 were fixed in `94de2f0`; BB-006 received its final bounds/fragmentation closure in `0fd3bc8`.

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
- Status: closed pending live Chrome confirmation.

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
- Status: closed for deterministic host coverage; real extension multi-host proof remains a release gate.

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
- Status: closed pending live Chrome confirmation.

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
- Status: closed. Live cross-browser evidence row still pending (extension loaded unpacked).

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
- Status: closed pending green CI.
