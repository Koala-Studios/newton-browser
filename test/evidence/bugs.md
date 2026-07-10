# Browser Bridge Defect Ledger

All defects below have deterministic regression coverage. Fix commits are recorded as "ledger commit" until the first implementation/evidence commit lands; a later evidence update will replace that label with the exact hash.

## BB-001 — Core declaration build missing type import

- Minimal repro: run `pnpm build:core` after extraction.
- Root cause: `transport.ts` referenced `BrowserFloorDecision` without importing it; runtime type stripping hid the declaration-build failure.
- Fix: import the type explicitly.
- Regression: `pnpm build:core` and `packages/core` declaration output.
- Fix commit: ledger commit.
- Status: closed.

## BB-002 — Driver build depended on caller cwd

- Minimal repro: run the driver build through `pnpm --filter @browser-bridge/driver build`.
- Root cause: the copy script derived paths from `process.cwd()`, but filtered workspace scripts execute from the package directory.
- Fix: derive repository paths from `import.meta.url`.
- Regression: `pnpm build`.
- Fix commit: ledger commit.
- Status: closed.

## BB-003 — Upgrade socket used an obsolete concrete type

- Minimal repro: compile the MCP server against current Node 24 type definitions.
- Root cause: HTTP upgrade sockets were declared as `net.Socket` although the API contract supplies a `Duplex`.
- Fix: type the stream to the methods actually used.
- Regression: `pnpm typecheck` and `pnpm build:mcp`.
- Fix commit: ledger commit.
- Status: closed.

## BB-004 — Owned tabs stole operator focus

- Minimal repro: call `createOwnedTab` and inspect the `chrome.tabs.create` input.
- Root cause: the copied implementation set `active: true` to support trusted input, contradicting the owned-tab product invariant.
- Fix: create owned tabs inactive; CDP remains attached directly to the tab.
- Regression: `packages/driver/test/chrome-tabs-port.test.js`.
- Fix commit: ledger commit.
- Status: closed pending live Chrome confirmation.

## BB-005 — Read-only session could bind outside its origin grant after focus change

- Minimal repro: keep an unbound current-tab session granted to one origin, switch focus to another origin, then run external-session reconciliation.
- Root cause: current-tab binding accepted the current active tab without reconciling its live origin, and origin was optional at MCP start.
- Fix: mandatory exact origin, live-origin attachment readiness, bind-time grant check, and per-command live-origin check.
- Regression: `packages/driver/test/controller.test.ts` (focused-tab escape) and `apps/mcp-server/test/host.test.ts` (mandatory origin/readiness).
- Fix commit: ledger commit.
- Status: closed.

## BB-006 — Fixed port and bespoke WebSocket framing failed concurrent/large traffic

- Minimal repro: start a second host on the fixed port or send a frame above 65,535 bytes.
- Root cause: one fixed listener plus a handwritten parser with a 16-bit payload ceiling and no authentication.
- Fix: bounded port-range binding, `ws`, HMAC challenge-response, direct pending-session metadata, queue/result bounds, typed collision/disconnect errors, and no wildcard health CORS.
- Regression: `apps/mcp-server/test/host.test.ts` multi-host, auth, and >64 KiB cases.
- Fix commit: ledger commit.
- Status: closed for deterministic host coverage; real extension multi-host proof remains a release gate.

## BB-007 — Packed executable still imported workspace core

- Minimal repro: install the tarball in a clean directory and run `--version`.
- Root cause: esbuild's broad package-external setting excluded the workspace core from the intended self-contained bundle.
- Fix: externalize only `ws`; assert compiled output contains no core package import.
- Regression: `scripts/verify-boundary.mjs` plus both packed clean-install smokes.
- Fix commit: ledger commit.
- Status: closed.

## BB-008 — Bundled executable ran an inner entrypoint first

- Minimal repro: run the bundled bin with a fixed test port and probe health.
- Root cause: both `mcp-server.ts` and `index.ts` had direct-execution guards; bundling made the inner guard true and it awaited forever before the CLI entrypoint.
- Fix: make `index.ts` the sole executable boundary.
- Regression: `scripts/smoke/packed-stdio.mjs` fixed-port health and full matrix.
- Fix commit: ledger commit.
- Status: closed.

## BB-009 — Malformed JSON-line input changed response framing

- Minimal repro: send `{not-json}\n` after JSON-line initialization.
- Root cause: the parser advanced the buffer before parsing, so the error handler could no longer infer JSON-line mode and emitted a Content-Length frame.
- Fix: parse before consuming the line.
- Regression: `scripts/smoke/packed-stdio.mjs` malformed-frame assertion.
- Fix commit: ledger commit.
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
- Fix commit: ledger commit.
- Status: closed.

## BB-012 — Original package bin was raw TypeScript

- Minimal repro: pack the copied package and invoke its bin from `node_modules`.
- Root cause: the bin pointed to `src/index.ts`, which installed-package Node does not type-strip.
- Fix: self-contained compiled ESM bin at `dist/index.js` with a package file allowlist.
- Regression: boundary check, tar listing, and both clean-install stdio matrices.
- Fix commit: ledger commit.
- Status: closed.
