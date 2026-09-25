# Spark packet 03 delivery notes

Work completed in `C:\Users\Frank\.codex\worktrees\421a\newton-browser`.

## Files written

- `apps/mcp-server/src/native-file.ts` (new)
- `apps/mcp-server/src/native-runtime-build.ts`
- `apps/mcp-server/src/native-artifacts.ts`
- `apps/mcp-server/src/native-install.ts`
- `apps/mcp-server/src/native-launcher.cjs`
- `docs/implementation/SPARK_03_DELIVERY.md`

## Packet 03 implementation completed

- Added `apps/mcp-server/src/native-file.ts` and moved `hashNativeFile` into this file unchanged.
- Rewired `native-runtime-build.ts` to keep a compatibility re-export of `hashNativeFile` and implemented a thin `ensureNativeRuntimeBuild(...)` that delegates to `buildNativeRuntime(...)` with immutable runtime selection (`node.exe` on Windows, `node` on Linux), rejecting unsupported platforms.
- Updated `native-artifacts.ts` to import `hashNativeFile` from `native-file.ts`; retained artifact behavior while hardening stage cleanup checks:
  - `removeStageFiles` now enforces `resolvedStage === path.resolve(stage)`.
  - `path.dirname(resolvedStage) === path.resolve(expectedParent)`.
  - `fs.realpath(expectedParent) === path.resolve(expectedParent)`.
- Updated `native-install.ts` for platform/family explicit selection:
  - `installNativeLocal(root, extensionId, options = {})` and `unregisterNativeLocal(root, extensionId, options = {})` accept `{ browser?: 'chrome' | 'edge' }` (default Chrome).
  - `installNativeLocal` now resolves family via `nativePlatformLayout`, validates `extensionId` immediately, builds immutable runtime and launcher via selected `layout.runtimeName` and `layout.launcherName`, publishes `launcher.json` and `manifest.json` and registers selected platform only.
  - Windows registration remains `reg.exe` flow; registry key now comes from layout.
  - Linux registration uses `publishLinuxNativeRegistration(root, registration.path)`.
  - Unregister keeps registry compatibility check on Windows and uses `removeLinuxNativeRegistration` on Linux, only for selected layout.
- `ensureNativeOwner`:
  - Kept Windows SID/icacls branch intact.
  - Added Linux ownership path:
    - mkdtemp under canonical parent.
    - `chmod 0700` before writing marker.
    - `installation.json` written as `wx0600`.
    - rename to root guarded by validation.
    - existing root must be canonical non-symlink, owned by current uid, with no group/other permission bits.
  - Added Linux marker parsing + `hashNativeFile` validation and ownership checks.
- `native-install.ts` now requires mode-checked connection directory creation (`0o700` and no symlinks, uid/permission validation on Linux).
- `native-install.ts` follow-up hardening applied after integration review:
  - `nativePlatformLayout` calls now use conditional property spread to omit optional `homeDirectory`/`configDirectory` when undefined.
  - `ensureNativeOwner` is private.
  - `native-install.ts` now uses a single directory validator (`ensureDirectory`) with explicit private/shared permission modes (`0077` for Newton-owned dirs, `0022` for user profile/config paths).
  - Linux revalidates root ownership/permissions after install-race before reading `installation.json`.
  - `connections` directory creation handles pre-existing directory via `EEXIST` and validates exact existing directory.
- `native-launcher.cjs` now:
  - rejects non-Windows/Linux platforms.
  - uses process-platform runtime selection (`node.exe` / `node`) for runtime verification and spawn.
  - preserves stable `root = dirname(process.execPath)/../..` and existing metadata schema checks (`version`, `entryDigest`, `runtimeDigest`) and inherited stdio.
  - preserves inherited env with `NODE_OPTIONS`/`NODE_PATH` removed.

## Remaining integration call sites noted (not modified here)

- CLI setup remains in `apps/mcp-server/src/cli.ts` and still carries the Windows-only setup gate plus option wiring not included in this packet.
- Engine and core registration callers remain unchanged as requested:
  - `packages/core/*`
  - `apps/mcp-server/src/engine-*.ts` entry points

## Untested in this packet

- Linux/SEA runtime launch path and installer fallback behavior on a Linux runtime.
- End-to-end CLI behavior for browser family options.
