# Release

Newton Browser 0.4.0 is developed in a public repository and currently distributed from source or locally built artifacts. GitHub Actions runs validation on every pull request and main-branch push, including the packed release gate. npm publication, browser-store submission, and GitHub release publication remain separate approval gates.

Run from a clean checkout with Node 24 or newer:

```text
pnpm install --frozen-lockfile
pnpm release:check
```

The gate runs boundary, type, unit/contract, build, deterministic extension artifact, packed clean-install, isolated clean-user directories, fixture, Node 24/25, chaos, and concurrent two-host checks. It must leave all ports in `127.0.0.1:17321-17340` closed.

Expected release artifacts:

- `artifacts/newton-browser-0.4.0.tgz`
- `artifacts/newton-browser-extension-0.4.0.zip`
- `artifacts/newton-browser-extension-0.4.0.zip.sha256`

Before handing artifacts to another machine, compare the checksum, inspect both archive listings, run the clean-user procedure in `INSTALL.md`, and record exact versions/results in `test/evidence/qa-ledger.md`. Real-browser rows require Chrome and Edge stable with the unpacked release artifact, retained authentication, inactive owned-tab creation, current-tab scope, screenshot display, file acceptance, and cleanup.

Do not tag or publish while any critical evidence row is open, skipped, or unexplained.

Final 0.4 candidate evidence (2026-07-11): the unshortened packed release gate passed
three consecutive times after incognito support and release-scope closure—381.5s,
380.7s, and 380.5s—with all 11 stages green and zero cross-session results, deadlocks,
or orphan relay ports. See QA-REL-001 in `test/evidence/qa-ledger.md`.

## CI and release automation

`.github/workflows/ci.yml` runs lint, typecheck, tests, build, and the quick smoke suite on Ubuntu and Windows with Node 24. It separately runs the packed `release:check` gate and verifies the MCP tarball on Node 20, 22, and 24.

`.github/workflows/release.yml` runs the full packed release gate for a `v*` tag, rebuilds the signed extension artifact and MCP tarball, creates a GitHub Release using that version's `CHANGELOG.md` section, and publishes npm from the protected `release` environment. If the exact package version was already published manually from the verified tarball, the workflow treats it as satisfied and skips a duplicate publish. The repository administrator must configure that environment and its required reviewer before a publish can proceed.
