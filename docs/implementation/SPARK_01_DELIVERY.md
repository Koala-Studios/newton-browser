# Spark packet 01 delivery notes

Implementation status: completed in working tree `C:\Users\<user>\.codex\worktrees\421a\newton-browser`.

## Added exported APIs

- `packages/driver/src/text-edit-range.ts`
  - `export interface TextEditMatch`
  - `export interface TextEditRange`
  - `export function resolveTextEditRange(value: string, edit: TextEditMatch): TextEditRange`
- `apps/mcp-server/src/native-platform.ts`
  - `export type NativeBrowserFamily = 'chrome' | 'edge'`
  - `export interface NativePlatformLayout`
  - `export function nativePlatformLayout(...)`

## Files written

- `packages/driver/src/text-edit-range.ts`
- `apps/mcp-server/src/native-platform.ts`
- `docs/implementation/SPARK_01_DELIVERY.md`

## Tricky implementation decisions

- For text-edit matching, I used explicit UTF-16 index searching with overlap (`indexOf(match, start)` and `start += 1`) and checked every candidate boundary with a surrogate-pair boundary guard before accepting a match.
- Prefix/suffix constraints are applied as immediate adjacency checks around the candidate range, with exact string slices and no normalization.
- Match enumeration is streaming:
  - with `occurrence` set, scan to the requested one without early truncation;
  - without `occurrence`, fail with `ambiguous` on the first second qualifying match.
- I reject malformed caller-provided Unicode (`match`, `replacement`, `prefix`, `suffix`) by scanning UTF-16 pairs directly; `value` is left untouched because it may be arbitrary browser text.
- Output and range-length constraints are bounded against the packet limits before returning a range.
- Host layout resolution is branch-selective:
  - Windows returns native registry keys and `.exe` launcher/runtime names.
  - Linux returns `path.posix` file registrations and Node launcher/runtime names.
- Linux explicit `configDirectory` is rejected unless normalized and absolute without NUL/dot-segment artifacts; otherwise home-based `.config` fallback is used after validating absolute home.

## Unverified assumptions

- The packet did not specify whether additional path validation should reject trailing `/` in an already normalized Linux `configDirectory`. The current implementation accepts normalized paths that still contain trailing separators.
- No integration or tests were added in this packet by request.
