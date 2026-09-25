# Spark packet 02 — immutable native artifacts

Work only in `C:\Users\Frank\.codex\worktrees\421a\newton-browser`. Same model and no-subagent policy as packet 01. Luna owns tests/builds and no messages to other tasks. No testing, builds, browser launches or integration imports in existing files.

Allowed writes:
- `packages/driver/src/text-edit-range.ts` (review corrections below)
- NEW `apps/mcp-server/src/native-artifacts.ts`
- `docs/implementation/SPARK_02_DELIVERY.md`

First correct packet 01: guard null/non-object edit before dereferencing; validate all types and string size caps before Unicode scans so malicious oversized input is not scanned. Empty match/malformed types/Unicode/occurrence use invalid_arguments; excessive string sizes use work_limit per packet. Do not Object.freeze a primitive string. Keep exact overlapping/context/occurrence semantics unchanged.

## New artifact builder

This replaces duplicated Windows-specific build internals when Astra integrates it. For now leave old files untouched while Luna tests. Read `native-runtime-build.ts` and `native-install.ts::ensureLauncher` carefully. Reuse `hashNativeFile` from native-runtime-build.ts; do not copy that hash implementation.

Export exactly:

```ts
export async function buildNativeRuntime(root:string, entry:Buffer, runtime:string,
  runtimeName:'node.exe'|'node'):Promise<{digest:string;directory:string}>;
export async function buildNativeLauncher(root:string, sourceBytes:Buffer,
  launcherName:'native-launcher.exe'|'native-launcher'):Promise<string>;
```

No module-import effects. Validate the two filename enums at runtime before filesystem work. This is artifact building, not browser registration. No reg.exe/PowerShell/icacls/browser/HTTP/IPC in this module. No new dependency.

Runtime implementation:
1. Validate root absolute/canonical existing regular directory, reject symlink/path escape. Create/validate `builds` directly under it.
2. Cap entry <=4MiB. Digest remains SHA256(entry), so existing Windows build directory compatibility is retained.
3. Existing digest directory is verified, never rewritten. Verify regular directory, `build.json` <=4096, version1, entryDigest, runtimeDigest SHA256; runtime file name is selected from the enum. Verify host entry <=4MiB and actual copied runtime digest. Reject malformed/incomplete existing builds; no repair-overwrite.
4. For missing build: hash source runtime via hashNativeFile; create owned mkdtemp stage under builds, remember dev/ino; write host entry wx0600; copy runtime to enum filename; chmod runtime0700 on Linux (preserve Windows behavior); hash copied runtime and compare source digest; write build.json wx0600. Keep metadata compatible `{version:1,entryDigest,runtimeDigest}`.
5. Rename atomically to digest directory. Only expected destination-exists races can be resolved by verifying the existing winner. All unrelated errors propagate.
6. Cleanup only the exact stage proven by dev/ino and expected location; remove only known staged files then rmdir, never recursive deletion or shared-directory cleanup. Do not touch winner on failure.

Launcher implementation:
1. Cap source <=4MiB. Digest source, create/validate `launchers`, immutable `launchers/<sourceDigest>/<launcherName>`.
2. Existing launcher validates regular directory, bounded metadata `launcher.json`, sourceDigest and actual binaryDigest. Never overwrite live launcher files.
3. Check Node >=25.5 before a new SEA build; explicit error native_launcher_build_requires_node_25_5. Use current process.execPath and execFile promisified, not shell strings.
4. Owned staging directory with source launcher.cjs, sea.json, enum binary name. SEA config matches existing: main, output, disableExperimentalSEAWarning:true, useCodeCache:false,useSnapshot:false. Run `--build-sea` with windowsHide:true, a bounded timeout (120 seconds) and bounded maxBuffer (1MiB). This is an actual child-process failure bound, not browser timing tuning. Remove NODE_OPTIONS/NODE_PATH from build child environment. No visible window.
5. chmod Linux executable0700; verify binary hash; write metadata `{sourceDigest,binaryDigest}`; delete source/config; atomic rename and verify existing winner on known race.
6. Cleanup uses exact stage ownership and only known filenames as above, including on failed SEA child. Preserve errors and never silently treat a partial build as success.

Keep code short and readable. Shared internal directory/stage helpers are appropriate if they remove duplication and enforce the exact same invariant; no generic filesystem transaction framework. Preserve expected error names native_directory_invalid/native_installation_changed/native_launcher_changed/native_stage_changed/native_file_invalid. Do not include file contents or untrusted subprocess output in custom errors.

Delivery: exact exports/files, review against each rule, remaining integration instructions (old ensureNativeRuntimeBuild delegates to this builder or is moved, old ensureLauncher deleted when wired). Do not claim QA passed. End with normal final response so Astra can wait on this task.
