# Existing-browser entrypoint audit

## Audit scope

Static read-only audit of the current engine host, existing-tab transport, native host and broker, adapter build/update helpers, CLI, package scripts, and P11-P12 requirements. No browser, build, install, update, or runtime verification was run for this audit.

## Current entrypoints

| Concern | Current entrypoint | What it actually does |
| --- | --- | --- |
| Process launch | `apps/mcp-server/src/index.ts`: `handleUtilityCommand`, then `startNewtonBrowserMcpServer` | Dispatches utility CLI commands; otherwise starts the MCP stdio server. `apps/mcp-server/package.json` exposes packed `dist/index.js` as `newton-browser`. |
| Default host | `apps/mcp-server/src/mcp-server.ts`: `startNewtonBrowserMcpServer` -> `createDefaultEngineHost` | Uses the session engine by default. The legacy direct host remains reachable through the injected compatibility seam in `handleMcpMessage`. |
| Existing catalog | `apps/mcp-server/src/engine-mcp.ts`: catalog, `handleEngineMcp` | Publishes `browser.session.start` with explicit `{mode:"existing", target:{kind:"tab",tabId,instanceId}}`, plus `browser.existing.discover` and `browser.existing.setup`. Existing mode is not selected automatically. |
| Host status/setup | `apps/mcp-server/src/browser-runtime/engine-host.ts`: `existingStatus`, `existingSetup` | Reports `available` when a `connectExisting` callback was configured and returns `state:"ready"`; neither operation probes the native advertisement, performs hello, claims a tab, or reads inventory. |
| Existing host configuration | `apps/mcp-server/src/browser-runtime/default-engine-host.ts`: `createDefaultEngineHost` | Reads `NEWTON_BROWSER_NATIVE_ADVERTISEMENT`. If present, it wires `connectExistingTab`; the `connectionId` input is accepted but ignored by this closure. |
| Tab connection | `apps/mcp-server/src/existing-connection.ts`: `connectExistingTab` | Validates the advertisement file/token, opens the private socket, performs protocol-major/epoch hello validation, claims the requested tab, and returns an `EngineConnection` with scoped CDP requests, events, and release cleanup. |
| Native broker | `apps/mcp-server/src/native-broker.ts`: `startNativeBroker` | Owns the per-launch endpoint and advertisement, authenticates the token, limits peers and in-flight requests, and forwards framed requests/events between Native Messaging and the local socket. |
| Native host/launcher | `apps/mcp-server/src/native-host.ts`: top-level `startNativeBroker`; `apps/mcp-server/src/native-launcher.cjs`: immutable digest-checked child launch | The launcher resolves its installed root from `process.execPath`, verifies `launcher.json` and the selected build digest, then launches the bundled `native-host.js`. |
| Native installation | `apps/mcp-server/src/native-install.ts`: `installNativeLocal`; `scripts/install-native-local.mjs` | Explicit Windows-only setup. It copies the bundled host and Node runtime, builds a SEA launcher when absent, writes the digest manifest and Native Messaging manifest, and registers the per-user Chrome host. It is an exported helper, not a normal CLI subcommand. |
| Adapter build/setup | `scripts/build-tab-adapter.mjs`: `buildTabAdapter`; `apps/tab-adapter/setup.html` | Builds `apps/tab-adapter/src/worker.ts` to a caller-selected directory and copies the manifest/setup page. The setup page can report worker status and request quiesce/reload; it does not install the extension or register the native host. |
| Adapter update | `apps/mcp-server/src/adapter-installation.ts`: `developmentAdapterInstallation`; `apps/mcp-server/src/adapter-update.ts`: `updateAdapter` | Provides injected staged-code validation, atomic worker replacement, quiesce/reload/bootstrap digest checks, smoke, and rollback. The only current orchestration caller is `scripts/verify-tab-foundation.mjs`; no public CLI/MCP update command wires it. |
| Packed QA entrypoint | `scripts/verify-tab-foundation.mjs`, `scripts/foundation-tab-client.mjs` | Unpacks the package, installs a disposable native host, builds the adapter, starts clients, and exercises the private existing connection. This is the real foundation QA path, not a shipped operator entrypoint. |

## Capability classification

### Configured or status-only

- `browser.existing.discover` is a configuration report. `EngineHost.existingStatus()` infers availability from the presence of the `connectExisting` callback, which currently means the advertisement environment variable was present when `createDefaultEngineHost()` was constructed. It does not prove that the file, host registration, socket, extension, browser, or requested tab is usable.
- `browser.existing.setup` returns `state:"ready"` after the same callback check. It does not perform native hello, capability negotiation, inventory, or a harmless claim/release probe.
- The public CLI exposes owned-browser `setup --browser`, `doctor [--live]`, source/identity operations, and `install <codex|generic>`. It has no existing-adapter discovery, native-host install, extension setup, or worker-operated update command.
- `installNativeLocal` is Windows-only and requires Node 25.5+ when the SEA launcher is not already present, while the package minimum is Node 24. The P12 Linux stable-launcher requirement is not represented by this implementation.
- The adapter’s `inventory` request is implemented in `apps/tab-adapter/src/worker.ts` and bounds `chrome.tabs.query({})` to 128 entries, but no `EngineHost`, `engine-mcp`, or `connectExistingTab` API exposes it as a public existing-browser discovery result.

### Real callable and proven transport

- `connectExistingTab` has a real native handshake path: advertisement validation, authenticated connect, `hello`/`connected` handling, protocol-major and instance-epoch checks, claim, scoped command forwarding, event forwarding, and release on close.
- `apps/mcp-server/src/native-broker.ts`, `apps/mcp-server/src/native-wire.ts`, `apps/mcp-server/src/native-host.ts`, `apps/tab-adapter/src/worker.ts`, and `apps/tab-adapter/src/claims.ts` form a real private Native Messaging plus local IPC path. The worker sends a digest and capability list in hello, authenticates per-broker connection identity, claims tabs, and fences stale owners.
- `test/evidence/foundation-tab-connection.json` and the `astra-adapter-v9b`/`astra-adapter-headed-v9` evidence report packed native hello, private IPC, two independent clients, tab claims, scoped input, stop preserving the browser, and update/rollback smoke. This proves the foundation QA path, not public discover/setup semantics or complete P11 parity.
- `test/tab-foundation.test.mjs` proves deterministic claim races, stale epochs, concurrent different-tab commands, native framing, and update rollback logic. It does not prove packed public existing-mode discovery, inventory, popup/OOPIF parity, or two separately launched MCP processes through the public catalog.

## Transport mechanics to extract once

| Duplicated responsibility | Current copies | Recommended boundary |
| --- | --- | --- |
| Native framing and packet assembly | `packages/core/src/native-packets.ts`, `apps/mcp-server/src/native-wire.ts`, and `apps/tab-adapter/src/worker.ts` | Keep one shared codec/typed packet contract in core. Keep platform stream adapters thin; do not duplicate frame limits, reassembly, or invalid-frame behavior in each endpoint. |
| Handshake, request correlation, peer limits, loss, and event forwarding | `connectExistingTab` owns pending IDs/timers; `native-broker` owns authenticated peers and in-flight limits; the adapter worker owns connection/owner maps and request dispatch | Extract one protocol state machine for hello, connection identity, request/response correlation, close, capability negotiation, and generation fencing. Native socket, Chrome Native Messaging port, and test transport should only provide I/O callbacks. |
| Quiesce/reload/bootstrap recovery | `adapter-update.ts`, `adapter-installation.ts`, `apps/tab-adapter/src/worker.ts`, `setup.html`, and `verify-tab-foundation.mjs` each participate in update lifecycle decisions | Keep one production update coordinator and one adapter-side control contract. QA should drive that coordinator instead of reimplementing sequencing or treating reload acknowledgement as bootstrap proof. |

## Missing wiring and completion-proof tests

- Wire `browser.existing.discover` to a bounded live capability/inventory probe, or rename it as configuration status. The response must distinguish configured, native-host reachable, extension hello complete, and inventory available.
- Make `browser.existing.setup` perform explicit operator-authorized setup validation or remove it from the public catalog. A `ready` result must require the expected extension identity, protocol major, digest/capabilities, and a harmless claim/release or equivalent proof.
- Add the public packed path from adapter/native installation to `NEWTON_BROWSER_NATIVE_ADVERTISEMENT`; prove that standalone startup never performs registration and that uninstall removes only owned files/registrations.
- Add a public worker-operated update entrypoint around `updateAdapter`, including staged manifest validation, unchanged extension identity/permissions, quiescence, expected digest after reconnect, failed smoke rollback, failed rollback recovery-required state, and native-host path-change detection.
- Add capability negotiation to `EngineHost.start` and initial state. Current `capabilities` are a static list and do not represent existing adapter hello capabilities or precise existing-mode differences.
- Prove the public existing-mode path with two independently launched MCP processes: same-tab claim race, different-tab concurrency, stale token/generation replay, popup and recursive OOPIF routes, browser/user-tab preservation on stop, native peer loss, extension reload, and browser exit.
- Prove public inventory and target selection without profile/history scanning: bounded tab records, fresh instance identity, exact claim, and refusal to expose unrelated tabs.
- Add packed Windows and Linux launcher/install acceptance, followed by an unchanged development checkout deletion test. Current `installNativeLocal` rejects non-Windows platforms and the adapter build output is not included in the MCP package allowlist.

## P11-P12 disposition

The repository contains a functional foundation candidate and a strong disposable packed QA path, but P11 is only partially wired: public existing discovery/setup are status stubs, and complete public connection/stop/update/concurrency acceptance is absent. P12 is also partial: build and pack scripts include the native entries, but extension installation/update are helper-plus-QA flows, Linux packaging is absent, and artifact/update acceptance is not exposed through the public worker-driven path. These are integration gaps, not reasons to add a second browser engine or a daemon.
