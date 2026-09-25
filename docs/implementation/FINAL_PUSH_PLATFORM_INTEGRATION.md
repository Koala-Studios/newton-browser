# Platform integration ownership and acceptance

2026-09-08. Astra owns integration; Spark owns only the current packet's named files. Luna owns batch-01 tests and its findings file. Do not modify batch-01 core paths until findings are terminal and reviewed.

New modules are candidates, not verified platform support:
- `native-platform.ts`: pure Windows/Linux Chrome/Edge layout (Spark 01).
- `native-artifacts.ts`: immutable runtime/SEA launcher construction (Spark 02).
- `linux-native-registration.ts`: owned user-local manifest publication/removal (Astra).

Integration must subtract the old implementation:
1. Move hashNativeFile to a single independent helper if needed to avoid an import cycle, preserving all old callers via a temporary re-export only until consumers migrate.
2. Route ensureNativeRuntimeBuild through buildNativeRuntime with the current platform runtime name. Delete its duplicate construction implementation.
3. Replace native-install.ts::ensureLauncher with buildNativeLauncher, then delete the old builder.
4. Native launcher selects node.exe on Windows, node on Linux from the platform—not an arbitrary filename supplied by untrusted metadata. Verify the selected runtime digest; preserve stable root resolution from SEA executable path and private inherited stdio.
5. installNativeLocal gains an explicit browser family option defaulting to Chrome for existing callers. Select layout once. Preserve existing Windows Chrome HKCU behavior; Edge uses its own HKCU key. Linux publishes the owned manifest at the selected user-local registration path. No cross-family uninstall.
6. Linux installation root is current-uid-owned, mode0700, no symlink/path alias; installation marker is wx0600 with extensionId. Existing directories are validated, never silently chmodded into ownership. Maintain Windows SID/ACL path intact.
7. connections directory inherits private root restrictions; validate it rather than trusting recursive mkdir on an existing path. Linux socket lifecycle must remove only its exact socket/advertisement and bound shutdown acknowledgement.
8. CLI adapter setup accepts explicit --browser chrome|edge and removes its Windows-only gate only after runtime support is integrated. Setup output uses corresponding browser extension URL/instructions. Standalone setup remains registration-free.
9. Pack entrypoints remain unchanged unless artifact analysis proves a new entry is necessary. New helper modules should bundle into current entries. Do not add a daemon, install-time side effects, TCP listener or per-profile control engine.

Acceptance after the integrated batch: existing Windows installation/update/rollback receipts, Edge registration independence, actual Linux SEA launch/private IPC/registration/cleanup, symlinks/hardlinks/ownership changes, partial publish/build, concurrent setup, absent helper and standalone survival. A Windows test parameterized with 'linux' proves only path logic, not Linux execution. Preserve prior denied cleanup residues.

Outstanding platform facts: native installer currently requires Node >=25.5 for SEA creation although ordinary package runtime minimum is >=24. This needs an explicit capability/setup message and a real package strategy; do not silently raise the entire runtime requirement or auto-download a Node binary. The operator needs a truthful explanation if native setup cannot build with their runtime. Source-only tests cannot certify an installed helper's independence from the repository.
