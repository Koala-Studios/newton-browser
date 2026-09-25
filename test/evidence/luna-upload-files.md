# Upload file preparation evidence

## Scope

`packages/driver/src/upload-files.ts` provides the synchronous filesystem boundary for upload dispatch. It validates the existing MCP contract of 1-8 absolute local files, rejects NULs, wildcards, path escapes, canonical mismatches, symlinks in every path component, unsupported extensions, malformed signatures, and per-file or aggregate size limits. It opens each file, verifies the descriptor identity against the path, reads only the first 16 bytes for signature validation, retains descriptors until `close()`, and rechecks path and descriptor identity through `assertUnchanged()`.

The module does not copy or stage payloads. The final check and a later CDP consumer open remain separate operations, so this boundary does not claim an atomic guarantee against a filesystem race after `assertUnchanged()` returns.

## Focused verification

Command:

```text
node --test packages/driver/test/upload-files.test.mjs
```

Result: 8 passed, 0 failed, 0 skipped.

Covered cases:

- PNG, JPG, JPEG, WebP, GIF, MP4, and WebM signatures
- Required, absolute, NUL, wildcard, missing, directory, and canonical-mismatch paths
- Windows forward-slash and case-variant drive paths, plus pre-filesystem rejection of traversal, UNC, and device paths
- Direct-file and parent-component symlinks
- File count, extension, malformed signature, per-file, and aggregate byte limits
- In-place mutation and replacement after preparation
- Descriptor retention, idempotent close, and rejection after close
