# Spark packet 02 delivery notes

Work completed in `C:\Users\<user>\.codex\worktrees\421a\newton-browser`.

## Files written

- `packages/driver/src/text-edit-range.ts` (packet-01 correction + behavior unchanged)
- `apps/mcp-server/src/native-artifacts.ts` (new immutable artifact builder)
- `docs/implementation/SPARK_02_DELIVERY.md`

## Packet 01 corrections applied to `text-edit-range.ts`

- Guarded null/non-object `edit` before dereferencing `match`/`replacement`.
- Added explicit runtime type checks for all optional fields before any string inspection.
- Added pre-scan string-size validation (`value`, `match`, `replacement`, `prefix`, `suffix`) before Unicode well-formedness scans.
- Kept malformed Unicode handling as `invalid_arguments`.
- Enforced over-cap input size to `work_limit`:
  - `value` > 65,536
  - `match` > 4,096
  - `replacement` > 65,536
  - `prefix`/`suffix` > 4,096
- Kept empty match, malformed types, Unicode/occurrence as `invalid_arguments`.
- Kept overlapping enumeration, boundary checks, and occurrence behavior unchanged.
- Removed accidental `Object.freeze` on primitive `expected` string.
- Preserved existing `not_found`/`ambiguous` selection outcomes.

## New module: `apps/mcp-server/src/native-artifacts.ts`

Exports:

- `buildNativeRuntime(root, entry, runtime, runtimeName)`
- `buildNativeLauncher(root, sourceBytes, launcherName)`

Implementation notes:

- Validates enum names for `runtimeName` / `launcherName` and directory/root/canonical invariants before filesystem work.
- `buildNativeRuntime`
  - Validates and creates `builds`, verifies existing digest directories immutably (`build.json`, `native-host.js`, runtime binary).
- `buildNativeLauncher`
  - Validates source byte cap.
  - Verifies immutable `launchers/<digest>` entries via `launcher.json` and binary digest.
  - Runs SEA build via `execFile(process.execPath, ["--build-sea", config])` with:
    - child env scrubbed of `NODE_OPTIONS` and `NODE_PATH`
    - bounded `timeout` (120000)
    - bounded `maxBuffer` (1MiB)
  - Enforces Node >= 25.5 for new SEA builds.
- Linux-only post-build chmod (`0700`) is applied to copied runtime and launcher artifacts.
- Launcher metadata verification is compatible with existing format: checks `sourceDigest` and `binaryDigest` only.
- Stage ownership cleanup is limited to stage-specific `inode/dev` and expected filenames.
- Uses `hashNativeFile` from `native-runtime-build.ts`; no new dependencies.
- Preserves required error names:
  - `native_directory_invalid`
  - `native_installation_changed`
  - `native_launcher_changed`
  - `native_stage_changed`
  - `native_file_invalid`
  - `native_launcher_build_requires_node_25_5`

## Integration handoff for Astra

- Existing behavior remains untouched: this packet introduces a new immutable builder only.
- No integration imports/wires were changed.
- Remaining instruction for follow-up:
  - `ensureNativeRuntimeBuild` and `ensureLauncher` should be migrated to delegate to this module (or removed/replaced) in the next phase.
