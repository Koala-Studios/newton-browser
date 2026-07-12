# Release

Newton Browser 0.4.1 is the metadata-only MCP Registry casing patch for the public 0.4 line. The Chrome Web Store 0.4.0 package has been submitted and is pending review. Edge Add-ons submission is explicitly deferred until the Chrome listing is live. MCP registry and community-directory submissions are tracked in `docs/DISCOVERY_PLAN.md`.

Run from a clean checkout with Node 24 or newer:

```text
pnpm install --frozen-lockfile
pnpm release:check
```

The gate runs boundary, type, unit/contract, build, deterministic extension artifact, packed clean-install, isolated clean-user directories, fixture, Node 24/25, chaos, and concurrent two-host checks. It must leave all ports in `127.0.0.1:17321-17340` closed.

Expected release artifacts:

- `artifacts/newton-browser-0.4.1.tgz`
- `artifacts/newton-browser-extension-0.4.1.zip`
- `artifacts/newton-browser-extension-0.4.1.zip.sha256`

Before handing artifacts to another machine, compare the checksum, inspect both archive listings, run the clean-user procedure in `INSTALL.md`, and record exact versions/results in `test/evidence/qa-ledger.md`. Real-browser rows require Chrome and Edge stable with the unpacked release artifact, retained authentication, inactive owned-tab creation, current-tab scope, screenshot display, file acceptance, and cleanup.

Do not tag or publish while any critical evidence row is open, skipped, or unexplained.

Final 0.4 candidate evidence (2026-07-11): the unshortened packed release gate passed
three consecutive times after incognito support and release-scope closure—381.5s,
380.7s, and 380.5s—with all 11 stages green and zero cross-session results, deadlocks,
or orphan relay ports. See QA-REL-001 in `test/evidence/qa-ledger.md`.

The 0.4.1 Registry-casing patch candidate passed the same unshortened gate three
consecutive times in 418.7s, 410.4s, and 411.6s. All 11 stages passed each time with
9,032,054 combined measured operations, zero cross-session results or deadlocks,
identical release-artifact checksums, and zero orphan relay ports. See QA-REL-004.

The protected public release run 29159340143 passed on Linux with 459,020 warmup
operations, 4,662,434 measured operations, zero cross-session results or deadlocks,
and 13,266,944 bytes of RSS growth against the unchanged 96 MiB limit. It created the
public GitHub Release assets and correctly skipped duplicate npm publication because
the verified 0.4.0 tarball was already public. See QA-REL-003.

## CI and release automation

`.github/workflows/ci.yml` runs lint, typecheck, tests, build, and the quick smoke suite on Ubuntu and Windows with Node 24. It separately runs the packed `release:check` gate and verifies the MCP tarball on Node 20, 22, and 24.

`.github/workflows/release.yml` runs the full packed release gate for a `v*` tag, rebuilds the signed extension artifact and MCP tarball, creates a GitHub Release using that version's `CHANGELOG.md` section, and publishes npm from the protected `release` environment. If the exact package version was already published manually from the verified tarball, the workflow treats it as satisfied and skips a duplicate publish. The repository administrator must configure that environment and its required reviewer before a publish can proceed.

## Public distribution

- npm: `newton-browser@0.4.1`
- GitHub tag and release: `v0.4.1`
- Landing page: `https://koala-studios.github.io/newton-browser/`
- Chrome Web Store: submitted for review on 2026-07-11
- Edge Add-ons: deferred until the Chrome listing is live
- Official MCP Registry: active/latest 0.4.1 record at
  `io.github.Koala-Studios/newton-browser`
- Community directories: waiting for the required 48-hour ingestion window; see
  `DISCOVERY_PLAN.md`
