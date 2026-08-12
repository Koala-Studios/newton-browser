# Plan 12 — Newton Identities and Opaque Profile Import

Status: implementation and authorized Chrome Default import/cleanup complete; optional workflow, not a release gate

Depends on: Plan 10 profile-root ownership

## Outcome

Newton provides persistent, isolated browser identities. Normal setup asks the operator to
sign in once inside a Newton-owned browser. An explicit migration command may seed a new
identity from a closed Chrome/Edge profile by copying only approved authentication state
as opaque bytes. Newton never inspects, exports, synchronizes, or writes back to the source.

Authentication preservation is best-effort and is not a product or release claim. In
particular, current Windows Chrome App-Bound Encryption binds standard-profile protected
data to Chrome's standard user-data directory; an opaque copy launched from Newton's
isolated `--user-data-dir` may therefore be unable to decrypt an existing Google session.
The supported authentication path, when an operator needs it, is a direct sign-in inside
the Newton-owned identity. Release QA does not require an authenticated third-party site.
This limitation is grounded in Chromium's
[App-Bound encryption browser test](https://chromium.googlesource.com/chromium/src/%2B/68b3492d/chrome/browser/os_crypt/app_bound_encryption_win_browsertest.cc),
which expects standard-directory protected data to fail after a non-standard user-data
directory launch.

## Files

Add:

- `apps/mcp-server/src/browser-runtime/profile-store.ts`
- `apps/mcp-server/test/browser-runtime/profile-store.test.ts`

Integrate later in:

- `apps/mcp-server/src/config.ts`
- `apps/mcp-server/src/mcp-server.ts`
- CLI parsing/help and `README.md`
- `docs/SECURITY.md` and `docs/DECISIONS.md`

## Stored model

```ts
interface IdentityManifest {
  version: 1;
  id: string;                 // host-generated opaque ID
  browserFamily: "chrome" | "edge";
  createdAt: string;
  source: "new" | "opaque_import";
}
```

The manifest contains no source path, profile name, site, account, cookie, storage key,
or credential metadata. Directory names use opaque IDs, not operator/profile labels.

## Import contract

- Import requires explicit CLI/operator intent and cannot be triggered by page content or
  an MCP browser action.
- Refuse a live/locked or changing source. Capture file identity/size/mtime before copy,
  open without following links, copy into a new staging root, fsync where supported, and
  verify identity/size/mtime again. Any uncertainty aborts the entire import.
- Permit only a reviewed relative-path allowlist needed for cookie and origin storage
  continuity. Prohibit `Login Data`, `Web Data`, `History`, downloads, extensions,
  preferences that restore tabs, sessions/tabs, service workers, caches, crash reports,
  sync metadata, and every unknown file.
- Never deserialize SQLite, LevelDB, JSON, protobuf, or browser preference files. Copying
  a permitted file is byte-for-byte and content-blind.
- Reject symlinks, junctions/reparse points, devices, sockets, hard-link surprises,
  escaping realpaths, excessive depth/count/bytes, and case-collision ambiguity.
- Atomically rename the complete staged identity into the store. Cleanup is identity-bound
  by owner marker, realpath, direct parent, and file identity. Never merge into an existing
  identity or delete/modify the source.
- Imported encrypted state is same-machine/best-effort. Failure to authenticate is a user
  visible import failure or requires signing in; Newton never requests/decrypts secrets.

## Implementation sequence

1. Implement owned root creation, markers, manifests, listing, and safe deletion.
2. Define the first minimal platform allowlist with security review and fixtures.
3. Implement staged import and mutation/lock/link adversarial tests.
4. Add a CLI-only `identity create/list/import/delete/lease-inspect` surface. Do not add
   MCP tools; this is operator setup, not agent autonomy.
5. Add an explicit `identity login <id> --origin <origin> [--allow-origin <origin>]...`
   operator workflow. It launches the exact persistent identity through the same owned
   process, policy proxy, private CDP, blank-first navigation, and cleanup transaction as
   MCP sessions. It never disables containment, shares the identity, accepts credentials,
   or exposes profile/process/CDP details. The visible browser remains open until the
   operator closes it or sends an ordinary termination signal; cleanup must be confirmed
   before the command succeeds.
6. Launch only against Newton identities. An identity may have at most one owning browser
   process unless a browser-supported read-only snapshot mode is proven safe.

## Exit gates

Real closed-profile imports authenticate on supported Windows Chrome/Edge and Linux Chrome
without modifying the source. Live/locked/mutated/link/cap cases fail without publishing a
partial identity. Repository and evidence scans contain no copied profile material. An
operator can delete a Newton identity without affecting any browser profile outside the
owned root. A persistent identity can be signed into through the bounded operator login
command without an MCP client or extension, and a concurrent login/session attempt is
rejected by the same exclusive lease.
