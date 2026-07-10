# Release

Browser Bridge 0.3.0 is developed in a public repository and currently distributed from source or locally built artifacts. npm publication, browser-store submission, GitHub release publication, and adding a public license remain separate approval gates.

Run from a clean checkout with Node 24 or newer:

```text
pnpm install --frozen-lockfile
pnpm release:check
```

The gate runs boundary, type, unit/contract, build, deterministic extension artifact, packed clean-install, isolated clean-user directories, fixture, Node 24/25, chaos, and concurrent two-host checks. It must leave all ports in `127.0.0.1:17321-17340` closed.

Expected release artifacts:

- `artifacts/browser-bridge-mcp-0.3.0.tgz`
- `artifacts/browser-bridge-extension-0.3.0.zip`
- `artifacts/browser-bridge-extension-0.3.0.zip.sha256`

Before handing artifacts to another machine, compare the checksum, inspect both archive listings, run the clean-user procedure in `INSTALL.md`, and record exact versions/results in `test/evidence/qa-ledger.md`. Real-browser rows require Chrome and Edge stable with the unpacked release artifact, retained authentication, inactive owned-tab creation, current-tab scope, screenshot display, file acceptance, and cleanup.

Do not tag or publish while any critical evidence row is open, skipped, or unexplained.
