# Release

Newton Browser 0.4.5 makes exact-session observer focus idempotent when the owned
tab is already active. It retains the 0.4.4 approval-pause continuity and does not
change the public MCP tool surface.

Run from a clean checkout with Node 24 or newer:

```text
pnpm install --frozen-lockfile
pnpm release:check
```

The 13-stage gate runs boundary, strict workspace and driver typechecking, unit/contract
tests, provider-free regression evals, exact agent-cost budgets, deterministic driver and
extension builds, packed clean-install, isolated clean-user directories, fixture,
Node 24/25, chaos, and concurrent two-host checks. The driver
artifact must contain only compiled JavaScript and overlay assets—no TypeScript, source
maps, tests, fixtures, absolute checkout paths, or declaration-only runtime module. The
gate snapshots `127.0.0.1:17321-17340` before it starts: pre-existing local MCP
listeners may remain, but every port that was free at the start must still be free at the
end. A newly occupied port is a release failure.

Expected release artifacts:

- `artifacts/newton-browser-0.4.5.tgz`
- `artifacts/newton-browser-extension-0.4.5.zip`
- `artifacts/newton-browser-extension-0.4.5.zip.sha256`

Before handing artifacts to another machine, compare the checksum, inspect both archive listings, run the clean-user procedure in `INSTALL.md`, and record exact versions/results in `test/evidence/qa-ledger.md`. Real-browser rows require Chrome and Edge stable with the unpacked release artifact, retained authentication, inactive owned-tab creation, current-tab scope, screenshot display, file acceptance, and cleanup.

Do not tag or publish while any critical evidence row is open, skipped, or unexplained.

Real-browser acceptance is separate from the hermetic release command because it requires
an already loaded Chrome/Edge extension. Run `pnpm eval:live` for each required browser
target, record browser/extension versions and fixture counters, and do not treat
`extension_disconnected` as a passing live result.

The live harness defaults deterministically to Chrome and selects the first free host port
in `17321-17340`. Set `NEWTON_BROWSER_QA_OWNER=edge` to repeat the same matrix in Edge;
set `NEWTON_BROWSER_PORT` only when an exact free port in that range is required. Do not
use `browserTarget:auto` for release evidence because it does not prove which browser won
the session claim.

On PowerShell, run one selected browser at a time and leave the port unset so the harness
can avoid other local MCP tasks:

```powershell
$env:NEWTON_BROWSER_QA_OWNER = "chrome"
Remove-Item Env:NEWTON_BROWSER_PORT -ErrorAction SilentlyContinue
pnpm eval:live

$env:NEWTON_BROWSER_QA_OWNER = "edge"
pnpm eval:live
```

On POSIX shells, the equivalent commands are
`NEWTON_BROWSER_QA_OWNER=chrome pnpm eval:live` and
`NEWTON_BROWSER_QA_OWNER=edge pnpm eval:live`.

The MV3 restart proof is a separate manually coordinated run:

```powershell
$env:NEWTON_BROWSER_QA_OWNER = "chrome"
$env:NEWTON_BROWSER_QA_STATE_FILE = Join-Path $env:TEMP "newton-worker-restart.json"
node scripts/smoke/live-worker-restart.mjs
```

When the state file reports `reload_now`, reload only the unpacked Newton extension's
service worker in the selected browser. The harness must report the same owned tab after
recovery. Repeat with `NEWTON_BROWSER_QA_OWNER=edge` where Edge is available.

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

`.github/workflows/release.yml` runs the full packed release gate for a `v*` tag, rebuilds the signed extension artifact and MCP tarball, creates a GitHub Release using that version's `CHANGELOG.md` section, and publishes npm from the protected `release` environment. A manual dispatch with an exact existing tag checks out that immutable tag and reconciles its release assets, which provides a safe recovery path after a partial release. If the exact package version was already published manually from the verified tarball, the workflow treats it as satisfied and skips a duplicate publish. The repository administrator must configure that environment and its required reviewer before a publish can proceed. The recovery path passed against v0.4.1 in run 29182201160.

## Public distribution

- npm: `newton-browser@0.4.1` (0.4.2 through 0.4.5 publication pending)
- GitHub release artifacts: 0.4.4 current; 0.4.5 candidate
- Landing page: `https://koala-studios.github.io/newton-browser/`
- Chrome Web Store: accepted and live at
  `https://chromewebstore.google.com/detail/newton-browser/hjhanngbpeafifandahdemfcalfniijn`
- Edge Add-ons: Chrome-review gate cleared; submission outstanding
- Official MCP Registry: active/latest 0.4.1 record at
  `io.github.Koala-Studios/newton-browser`
- Community directories: waiting for the required 48-hour ingestion window; see
  `DISCOVERY_PLAN.md`
