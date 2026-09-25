# Spark packet 03 — integrate platform-neutral installation

Authoritative checkout: `C:\Users\Frank\.codex\worktrees\421a\newton-browser`. Read AGENTS.md and FINAL_PUSH_PLATFORM_INTEGRATION.md. Luna's batch01 run is complete; installer paths can now change. No subagents, other-task messages, tests/builds/browser launches or package/config changes. Astra owns engine/core/CLI and linux-native-registration.ts. Complete this whole packet before final response.

Allowed writes ONLY:
- `apps/mcp-server/src/native-file.ts` (new)
- `apps/mcp-server/src/native-runtime-build.ts`
- `apps/mcp-server/src/native-artifacts.ts`
- `apps/mcp-server/src/native-install.ts`
- `apps/mcp-server/src/native-launcher.cjs`
- `docs/implementation/SPARK_03_DELIVERY.md`

## Single artifact implementation

Move hashNativeFile unchanged from native-runtime-build.ts into native-file.ts. Native-artifacts and native-install import hashNativeFile from native-file.ts. Retain a compatibility re-export from native-runtime-build.ts for old imports/tests. Replace ensureNativeRuntimeBuild implementation with a thin call to buildNativeRuntime(root,entry,runtime,process.platform==='win32'?'node.exe':'node'), rejecting platforms outside win32/linux. Delete its old duplicate construction body. No cycle between artifacts and runtime wrapper.

Native-install uses buildNativeLauncher and deletes its old ensureLauncher body. Preserve publishNativeJson and nativeRegistrationMatches unless changes below require it. Use existing nativePlatformLayout and Astra's publishLinuxNativeRegistration/removeLinuxNativeRegistration helpers; do not duplicate their functions.

## Explicit family/platform selection

Change signatures compatibly:
```ts
installNativeLocal(root:string,extensionId:string,options:{browser?:'chrome'|'edge'}={})
unregisterNativeLocal(root:string,extensionId:string,options:{browser?:'chrome'|'edge'}={})
```
Default Chrome. Validate extensionId before any effect; nativePlatformLayout validates family/platform/hostName. Use os.homedir() for Linux home; use process.env.XDG_CONFIG_HOME when nonempty and validate through layout. Windows should not need home/config lookups.

Install flow: validate/canonicalize parent and root → ensureNativeOwner → validate/create connections → build immutable runtime/launcher using layout enum names → publish launcher.json digest and manifest.json exactly as before → register selected family/platform. For Windows layout.registration.kind registry, use its key with existing reg.exe mechanism. For Linux kind file, ensure the user config base exists safely (only create missing .config directly beneath verified current-user home, do not recursively create arbitrary provided XDG paths); call publishLinuxNativeRegistration(root,registration.path). Do not register both families automatically. Return existing root/digest and registry compatibility field for Windows plus a registration descriptor for both; unregister closure retains same options.

Unregister flow uses same selected layout. Windows query exact registry value and delete only matching root manifest as before. Linux call removeLinuxNativeRegistration. No deleting entire installation/other family/profile. Never print manifest contents or credentials.

## Linux ownership, preserve Windows ACL behavior

ensureNativeOwner: keep Windows SID lookup/icacls branch intact. For Linux, create mkdtemp stage under canonical parent, chmod0700 before publishing installation marker wx0600, then rename. Existing root must be a non-symlink canonical directory owned by process.getuid() with no group/other permissions (mode &0077 ===0). Validate installation marker version1/extensionId using hashNativeFile; also check Linux owner and no group/other write. Do not chmod an existing foreign root or overwrite its marker. Reject platform not supported.

Create connections with mode0700. Validate directory after mkdir (regular directory, no symlink, realpath equals expected; on Linux uid matches and no group/other permissions). Do not leave recursive mkdir as an implicit trust check.

Stage cleanup keeps exact dev/ino/parent ownership and known-file unlink only. No recursive delete or broad process stops. If runtime/registration cannot proceed return explicit error; no daemon/TCP proxy/install fallback.

## Launcher

Stable SEA root calculation remains relative to process.execPath under root/launchers/<digest>. Select `node.exe` on win32 or `node` on linux, reject other platforms. Use selected filename for hash verification and spawn. Keep metadata schema compatible (build.version1, entryDigest/runtimeDigest). No arbitrary runtime filename from metadata. Preserve inherited stdio and removed NODE_OPTIONS/NODE_PATH. No shell wrapper or dependency on repository/system npm at runtime.

## Review hardening from packet02

In artifact removeStageFiles, require path.dirname(resolvedStage)===path.resolve(expectedParent) AND realpath(expectedParent)===path.resolve(expectedParent) AND resolvedStage===path.resolve(stage), not a broad startsWith ancestor check. Remember expectedParent is an explicit direct stage parent. Maintain dev/ino and symlink checks.

Do not alter engine files, root scripts or CLI. Delivery must list those remaining integration call sites explicitly, including CLI --browser and current Windows-only setup gate. Report untested Linux/SEA behavior honestly. No QA claim based on source inspection. Finish normal final response; Astra may wait on this coding task.
