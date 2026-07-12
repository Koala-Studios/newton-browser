# Discovery Evidence Ledger

Durable evidence for `docs/DISCOVERY_PLAN.md`. Page content is treated as untrusted
data. No credentials, OTPs, secrets, payment data, private page data, or local paths
are recorded here.

## Wave 0 — Preflight

| Checked at (UTC) | Target | Account / namespace | Submission URL | Commit boundary | Receipt / observed result | Public URL | Logged-out verification | Follow-up |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-07-12 00:57 | npm package | `newton-browser@0.4.0` | n/a | none | Public package, version 0.4.0, MIT, canonical repository visible; npm sidebar shows `npm i newton-browser` | https://www.npmjs.com/package/newton-browser/v/0.4.0 | Newton Browser incognito owned session; signed-out controls visible | none |
| 2026-07-12 00:57 | GitHub release | `Koala-Studios/newton-browser` | n/a | none | Public latest release `v0.4.0`; package tarball, extension ZIP, SHA-256 asset, and sources visible | https://github.com/Koala-Studios/newton-browser/releases/tag/v0.4.0 | Newton Browser incognito owned session; signed-out controls visible | none |
| 2026-07-12 00:57 | GitHub privacy policy | `Koala-Studios/newton-browser` | n/a | none | Public `docs/PRIVACY.md` rendered from `main` | https://github.com/Koala-Studios/newton-browser/blob/main/docs/PRIVACY.md | Newton Browser incognito owned session; signed-out controls visible | none |
| 2026-07-12 00:57 | Project homepage | `Koala-Studios/newton-browser` | n/a | none | Static Newton Browser landing page rendered successfully | https://koala-studios.github.io/newton-browser/ | Newton Browser incognito owned session | none |
| 2026-07-12 00:56 | Local release preflight | `io.github.koala-studios/newton-browser` | n/a | none | `pnpm lint` green; `mcp-publisher` 1.7.9 validation against the official Registry succeeded; host and extension both 0.4.0, `ready:true`, version skew `none`, zero sessions | n/a | n/a | proceed to official Registry publish |
| 2026-07-12 04:31 | npm package | `newton-browser@0.4.1` | owner-authenticated CLI publish of the verified tarball | publish | Public package reports version 0.4.1, canonical `io.github.Koala-Studios/newton-browser` mcpName, and canonical repository; pinned npx binary reports 0.4.1 | https://www.npmjs.com/package/newton-browser/v/0.4.1 | Newton Browser incognito owned session at 05:05 UTC; `0.4.1`, Public, MIT, canonical repository, install command, and signed-out controls visible | none |
| 2026-07-12 04:16 | GitHub release | `Koala-Studios/newton-browser` | protected tag workflow run 29178530777 | create release | Hosted release gate passed; v0.4.1 tarball, extension ZIP, checksum, and notes were created before npm workflow auth failed | https://github.com/Koala-Studios/newton-browser/releases/tag/v0.4.1 | Newton Browser incognito owned session at 05:05 UTC; latest v0.4.1, tag/commit, five assets, digests, notes, and signed-out controls visible | none |

## Submissions

| Checked at (UTC) | Target | Account / namespace | Submission URL | Commit boundary | Receipt / observed result | Public URL | Logged-out verification | Follow-up |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-07-12 01:10 | Official MCP Registry | `io.github.koala-studios/newton-browser` | `mcp-publisher publish server.json` | publish | Rejected before creation (403): authenticated GitHub permission preserved canonical organization casing as `io.github.Koala-Studios/*` | n/a | Registry search returned no record | Correct namespace casing; upstream issue #689 documents the case-sensitive mismatch |
| 2026-07-12 03:08 | Official MCP Registry | `io.github.Koala-Studios/newton-browser` | `mcp-publisher publish server.json` | publish | Rejected before creation (400): immutable npm 0.4.0 package contained lowercase `mcpName`, which did not match the corrected record | https://github.com/modelcontextprotocol/registry/issues/689 | Registry search returned no record | Release 0.4.1 with matching npm and Registry metadata, then republish |
| 2026-07-12 05:06 | Official MCP Registry | `io.github.Koala-Studios/newton-browser` | `mcp-publisher publish server.json` | publish | `mcp-publisher` 1.7.9 receipt: successfully published server version 0.4.1 | https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.Koala-Studios%2Fnewton-browser | Newton Browser incognito owned session; API returned one active/latest record with exact name/version/repository, npm 0.4.1 package, and stdio transport | Check downstream ingestion after 2026-07-14 05:07 UTC; then submit only missing/corrective listings |
