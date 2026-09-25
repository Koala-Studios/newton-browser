# Native installation and adapter update audit

## Scope and correction

This is a read-only audit of the current 421a files. No production files, browser state, or build outputs were changed. The earlier version of this note was stale: current `existing-connection.ts` is already a thin claim adapter over `connectNative`, current discovery performs live capability and inventory checks, and `default-engine-host.ts` resolves the owned executable lazily inside its owned connection function.

## Implemented current path

| Path and symbol | Current behavior | Evidence |
| --- | --- | --- |
| `apps/mcp-server/src/native-client.ts:17` `connectNative` | Validates the advertisement file and derives the only accepted endpoint from its directory and broker epoch; validates hello protocol, instance epoch, digest, and bounded capability names; correlates responses, forwards events, rejects pending work on disconnect, and applies read-only versus mutation timeout policy. | `native-client.ts:17-69` |
| `apps/mcp-server/src/existing-connection.ts:1` `discoverExistingBrowser` | Uses `connectNative`, requires `tab_claim`, `scoped_cdp`, and `tab_inventory`, performs a read-only `inventory` call, validates/bounds tab records, redacts title/URL, returns `connectionId` and hello `instanceId`, and closes the client. | `existing-connection.ts:1-25` |
| `apps/mcp-server/src/existing-connection.ts:27` `connectExistingTab` | Uses `connectNative(advertisement, expectedInstanceId)`, requires `tab_claim` and `scoped_cdp`, validates the claim token against hello epoch/generation/tab ID, forwards scoped CDP through the shared engine, filters events by the claim token, and releases on close. | `existing-connection.ts:27-50` |
| `apps/mcp-server/src/browser-runtime/default-engine-host.ts:10` `createDefaultEngineHost` | Builds configuration/store state without eagerly discovering the owned executable. The owned `connect` function resolves family and executable when a session starts. Existing mode wires both `discoverExistingBrowser` and `connectExistingTab`; an optional `connectionId` is checked against the advertisement-derived ID. | `default-engine-host.ts:10-43` |
| `apps/mcp-server/src/browser-runtime/engine-host.ts` `existingStatus`/`existingSetup` | Calls the configured live discovery callback and returns bounded inventory, instance identity, capability-derived readiness, and a precise unavailable error; setup reports `ready` or `not_ready` without installing or claiming. | `engine-host.ts` `existingStatus`, `existingSetup` |
| `apps/mcp-server/src/native-install.ts:10` `installNativeLocal` | Explicit Windows setup applies ACLs, copies native host and Node, builds or reuses a stable SEA launcher, writes the launcher digest and Native Messaging manifest, and registers the expected extension origin. | `native-install.ts:10-48` |
| `apps/mcp-server/src/adapter-installation.ts:8` `developmentAdapterInstallation` | Validates canonical current/staged directories, requires unchanged manifests, hashes worker builds, and atomically publishes the selected worker bytes. | `adapter-installation.ts:8-39` |
| `apps/mcp-server/src/adapter-update.ts:11` `updateAdapter` | Quiesces, publishes, reloads, waits for the expected digest/protocol/epoch bootstrap, smokes, and attempts the same proof for the previous digest on failure. | `adapter-update.ts:11-31` |

## Remaining production gaps

### Installation entrypoints

- `installNativeLocal` is an explicit Windows-only helper. It installs the native host registration and launcher, but it does not install or load `apps/tab-adapter` itself, persist the adapter directory or worker digest, or expose a cross-platform installation contract.
- `scripts/install-native-local.mjs:2` only re-exports the built helper. It is not an argument-parsing executable and assumes `apps/mcp-server/dist/native-install.js` already exists.
- The public CLI install path edits MCP client configuration (`install <codex|generic>`); it does not provide operator setup, status, update, rollback, or uninstall for the optional adapter/native host.
- The current SEA launcher layout is Windows-specific. A stable Linux launcher/registration path required by the P12 guidance is still absent; either implement it or explicitly narrow the claimed supported installation platforms.

### Installed digest and capability binding

- `native-install.ts` hashes the bundled `native-host.js` and stores that digest in `launcher.json`. This proves the launcher is running the installed native host, not that the connected adapter worker is the expected installed worker build.
- `connectNative` validates the hello digest format and `existing-connection.ts` validates required runtime capabilities, but no installation manifest supplies an expected adapter digest or required capability policy to `connectNative`/`EngineHost`.
- The discovery result correctly exposes hello instance identity and bounded inventory, but it does not expose a durable installed adapter identity/digest relationship that an operator can compare across reloads or updates.

### Cross-reload binding and recovery

- `updateAdapter` correctly treats a lost reload reply as non-proof and waits for a fresh bootstrap with the requested digest, protocol major, non-empty epoch, and smoke. This is a sound coordinator contract.
- The coordinator is still injected development machinery; no public installation/update entrypoint connects it to the installed adapter directory, native host, `connectNative`, or a durable last-good state.
- A reload necessarily changes the adapter hello epoch. Existing sessions must reject stale `instanceId` values and rediscover before a new explicit start; the current runtime checks this through `connectNative(expectedInstanceId)`, but the installation/update path does not persist or publish the new expected identity.
- If new bootstrap and rollback bootstrap both fail, `adapter_bootstrap_recovery_required` is explicit, but there is no persisted recovery record or operator command to resume recovery without reconstructing the injected control object.
- Stop/close and reconnect must preserve the existing browser and release only the worker's claims. Any implementation that treats native disconnect as permission to reattach or replay the last input would violate the existing-browser boundary.

## Smallest coherent implementation recommendation

1. Keep `native-client.ts` as the single transport owner; retain `existing-connection.ts` only as the discovery/claim adapter, as it is now.
2. Add one owned installation manifest containing native host path, adapter path, extension ID, browser family, protocol major, expected worker digest, and last-known adapter instance identity. Validate exact ownership before setup, update, uninstall, or startup.
3. Add an explicit operator-only setup/status/update command that composes adapter installation with native-host installation. Standalone startup must not install or register anything.
4. Pass the installed worker digest and required capability set into the live hello check. Keep discovery live and bounded, but make readiness distinguish configured, reachable, hello-complete, and compatible.
5. Reuse `updateAdapter` as the only update coordinator. Wrap it with staged artifact ownership and persistence, reconnect through `connectNative` after reload, require expected digest plus required capabilities and smoke, then persist the new instance identity. Preserve `adapter_bootstrap_recovery_required` when rollback cannot be proven.
6. Add the claimed Linux launcher/registration path or document the supported-platform limit before calling P12 complete.

## Tests required to prove the remaining work

- Installation ownership: packed setup works without a repository checkout; native host and adapter paths, manifests, and registrations are exact and owned; tampering or another installation cannot be removed.
- Digest binding: a valid hello with an unexpected worker digest or missing required capability is rejected before discovery readiness or tab claim; the native-host digest and adapter-worker digest are checked independently.
- Reload identity: adapter reload loses the old connection, a new hello with the expected digest is accepted, the new epoch is published, and stale `instanceId`/claim generations are rejected.
- Update recovery: busy update, partial stage, changed manifest, failed smoke, failed rollback smoke, unavailable bootstrap, and native-host path changes preserve the documented last-good/recovery-required state.
- Public wiring: the shipped operator command reaches setup/status/update, while normal standalone startup remains usable with no adapter installation or native registration.
- Platform acceptance: stable launcher and Native Messaging registration work on every claimed platform.

## Finding

The current runtime connection path is implemented more completely than the earlier audit stated: live discovery, required capability checks, bounded inventory, claim-token validation, and lazy owned-browser discovery are present. The remaining production work is installation/update integration: public operator entrypoints, durable adapter digest and instance binding, cross-reload persistence/recovery, and the missing Linux launcher path. Prototype/foundation success proves transport mechanics, not those installed-product guarantees.
