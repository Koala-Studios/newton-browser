# Spark coding packet 01 — isolated helpers

Use model `gpt-5.3-codex-spark`, reasoning xhigh. Authoritative working directory is `C:\Users\Frank\.codex\worktrees\421a\newton-browser`. Read root AGENTS.md. Frank authorizes this coding delegation; no subagents or other workers. Luna owns tests/QA; do not launch builds, tests, browsers, package changes or modify its files.

Write ONLY these new files:
1. `packages/driver/src/text-edit-range.ts`
2. `apps/mcp-server/src/native-platform.ts`
3. `docs/implementation/SPARK_01_DELIVERY.md`

Do not wire imports into existing modules yet. Astra owns integration. No package/lockfile/core-contract changes, no filesystem mutations at module import time. No dependency additions, boilerplate frameworks, abstract service layers, retries or logging. Code must be straightforward TypeScript with explicit types and named exports. You may inspect existing files read-only. Report completion in the delivery file and normal final task response; do not message other tasks.

## A. Pure precise-edit range resolver

Export:

```ts
export interface TextEditMatch {
  match: string;
  replacement: string;
  prefix?: string;
  suffix?: string;
  occurrence?: number;
}
export interface TextEditRange {
  start: number;
  end: number;
  expected: string;
}
export function resolveTextEditRange(value: string, edit: TextEditMatch): TextEditRange;
```

Use existing `EngineError` from `@newton-browser/core`. This module chooses a range and expected text; it performs no browser input and reads no page. Rules:

- UTF-16 offsets, no Unicode normalization or line-ending conversion. Browser values already define their own line endings. Preserve exact prefix/suffix outside the replacement.
- `value` at most 65536 UTF-16 units; `match` length 1..4096; replacement length 0..65536; optional prefix/suffix length 0..4096. Reject excess input work with `work_limit`; malformed values with `invalid_arguments`. Require well-formed Unicode (no unpaired surrogates) for caller match/replacement/context. Value may contain arbitrary browser text; never split an existing surrogate pair at range boundaries.
- Occurrence, if supplied, is a 1-based integer <=65536 among matches satisfying prefix/suffix. Otherwise exactly one qualifying match is required. No match is `not_found`; >1 without occurrence is `ambiguous`.
- Prefix/suffix mean immediately adjacent exact strings, not anywhere earlier/later. An absent constraint imposes none. An empty prefix/suffix is valid and imposes no additional restriction.
- Enumerate overlapping matches (`next start = found index + 1`) so `aa` in `aaa` is ambiguous. Avoid collecting all matches: keep count and chosen start. If no occurrence and second valid match is found, reject immediately. Do not stop before the requested occurrence due to presentation caps.
- Check boundaries do not bisect a surrogate pair. Invalid matching boundaries do not qualify. Expected result length must be <=65536, else `work_limit` before any browser effect.
- Return an immutable object `{start,end,expected}`. Do not return extra diagnostics, original value, candidate arrays or input text in errors. No JSON serialization or regex built from user input.

Delivery examples to reason through (Luna writes tests): replace unique middle match; two identical matches; occurrence 2; overlapping `aa`; prefix distinguishing repeated words; emoji before and in match; empty replacement; multiline exact strings; boundary/effect length caps. No claiming tests passed.

## B. Pure native-platform layout helper

Export:

```ts
export type NativeBrowserFamily = 'chrome' | 'edge';
export interface NativePlatformLayout {
  runtimeName: 'node.exe' | 'node';
  launcherName: 'native-launcher.exe' | 'native-launcher';
  registration: {kind:'registry'; key:string} | {kind:'file'; path:string};
}
export function nativePlatformLayout(input: {
  platform: NodeJS.Platform;
  browser: NativeBrowserFamily;
  hostName: string;
  homeDirectory?: string;
  configDirectory?: string;
}): NativePlatformLayout;
```

No filesystem reads/writes, process execution or environment access. Input must fully describe selection. Invalid platform/browser/host/path throws `Error('native_install_arguments')` with no user data.

- Support win32 and linux only. Do not imply macOS support.
- Validate hostName: lowercase ASCII dot-separated labels; each nonempty label starts with a letter and contains only letters/digits/underscore; full length <=100. No consecutive dots, slashes, traversal or trailing dots.
- Windows Chrome registry: `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\<hostName>`.
- Windows Edge registry: `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\<hostName>`.
- Windows names node.exe and native-launcher.exe. Ignore home/config for registry path.
- Linux uses path.posix regardless of executing host. Explicit configDirectory must be an absolute normalized path (reject NUL, dot/dotdot segments and non-absolute paths). If omitted, require absolute homeDirectory and use `<home>/.config`.
- Linux Chrome registration `<config>/google-chrome/NativeMessagingHosts/<hostName>.json`; Edge `<config>/microsoft-edge/NativeMessagingHosts/<hostName>.json`. This config is a browser user-config base, not a personal browser profile read. Runtime names node and native-launcher.
- Return immutable layout and nested registration. Do not implement Chromium variants, global system registration, shell scripts, HTTP endpoints or anything not specified.

## Delivery

Document exact exported APIs, paths changed, tricky decisions and unverified assumptions. Read your code against every bullet before finishing. Do not say implementation is integrated or tested. If the specification conflicts with actual authoritative APIs, explain it in the delivery file; don't silently redesign the interface.
