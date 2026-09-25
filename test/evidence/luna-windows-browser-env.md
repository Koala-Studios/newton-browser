# Windows browser environment lookup evidence

## Scope

`browserExecutableCandidates` now reads `PROGRAMFILES`, `PROGRAMFILES(X86)`, and `LOCALAPPDATA` case-insensitively when constructing Windows system candidates. Canonical keys retain precedence, candidate order is unchanged, explicit executable validation is unchanged, and non-Windows behavior is untouched.

## Regression coverage

The focused test uses a plain object with mixed-case keys matching the host shape (`ProgramFiles`, `ProgramFiles(x86)`, and `LocalAppData`) and verifies the complete ordered candidate list for both Chrome and Edge. The existing canonical-key, platform, explicit-path, symlink, and Linux trust tests remain in the same focused file.

Command:

```text
pnpm exec vitest run apps/mcp-server/test/browser-runtime/browser-discovery.test.ts
```

Result: 6 passed, 0 failed, 0 skipped with Node `node --experimental-strip-types --test`.

The initially attempted `pnpm exec vitest run ...` command could not start because
this worktree has no Vitest executable; no dependency or package file was changed.
