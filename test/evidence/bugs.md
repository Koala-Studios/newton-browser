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

## BB-004 — Owned tabs stole operator focus

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

- Minimal repro: launch Codex CLI 0.144.0 with the 0.1.0 packed server.
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
