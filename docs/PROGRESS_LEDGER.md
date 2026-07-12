# Newton Browser — Workstream Progress Ledger

Tracks execution of `docs/IMPLEMENTATION_PLAN.md` (WS0–WS12) at the workstream level.
This is the durable "what is done" record; `test/evidence/qa-ledger.md` holds granular
per-check QA evidence, and `docs/DECISIONS.md` holds contract decisions. Update this
file as each workstream lands.

Legend: ✅ done · 🔶 in progress · ⛔ not started · 🚧 blocked on human (`[H#]`)

| WS | Scope | Status | Commits / evidence |
|----|-------|--------|--------------------|
| WS0 | Rename → newton-browser | ✅ | rename sweep; DECISIONS §12; residual cosmetic notes below |
| WS1 | MIT license | ✅ | `LICENSE`; `license` in all 5 package.json; `7bc9da6` |
| WS2 | Icons + toolbar states | ✅ | `2c55f7c`, `59aac3f`, `bd3bfcd`; manifest wired; owner approved the current contact sheet 2026-07-11 |
| WS3 | CI + release workflows | ✅ | CI GREEN on Linux+Windows, Node 20/22/24; protected v0.4.0 release workflow GREEN (run 29159340143). Fixed BB-036..BB-043. |
| WS4 | npm packaging + Node floor + `--install` | ✅ | metadata; Node 20 runtime floor reconciled; `--install` + tests; DECISIONS §15 |
| WS5 | Browser stores | 🔶 | Chrome Web Store v0.4.0 submitted and pending review; Edge Add-ons explicitly deferred until the Chrome listing is live |
| WS6 | First-run onboarding page | ✅ | `cf52dbb`, `de5124b`; `apps/extension/onboarding.{html,js}` |
| WS7 | Minimal popup sessions | ✅ | `4b03650`, `0e3b238`; session list + Stop-all |
| WS8 | Version-skew handling | ✅ | `3a14386`, `9abcbea`; `classifyVersionSkew`, status reports versions |
| WS9 | Capability gaps (0.4 scope) | ✅ | text/dialogs/resize/fill/console/network done and live-proved; multi-tab and status dialog summary deferred (DECISIONS §§23,25) |
| WS10 | Performance / observation budgets (0.4 scope) | ✅ | region + JPEG/quality shipped (DECISIONS §22); element-target capture and formal obs/cold-start budgets deferred (DECISIONS §25) |
| WS11 | Release 0.4.x | ✅ | npm/GitHub 0.4.1 public; three consecutive local release gates and hosted release gate passed; workflow npm-auth failure recovered with the verified tarball |
| WS12 | Discovery | 🔶 | Official MCP Registry 0.4.1 record is active/latest and logged-out verified; downstream ingestion check is due after 2026-07-14 05:07 UTC before community submissions |

## Gate status

- `pnpm typecheck` — ✅ green
- `pnpm test` — ✅ 133/133 pass (build, typecheck, lint, pack:check all green)
- `pnpm release:check` — ✅ three consecutive final passes after incognito/scope closure
  (381.5s / 380.7s / 380.5s; zero cross-results, deadlocks, or orphan ports)
- `pnpm lint` (boundary) — ✅ green

## WS9 breakdown

| Item | Capability | Status | Why / what it needs |
|------|-----------|--------|---------------------|
| 9.1 | `observe` text mode | ✅ committed | read-only; done to full quality with redaction + tests |
| 9.7 | eval exclusion (decision) | ✅ committed | DECISIONS §16 |
| 9.4 | dialog accept/dismiss | ✅ live-proved | CDP `Page.handleJavaScriptDialog`; `pendingDialog` on observations; DECISIONS §17; QA-LIVE-001. Status duplication deferred. |
| 9.8 | `fill_form` batch fill | ✅ live-proved | host-side sequential fills; per-field floor; sensitive halt with zero keystrokes; DECISIONS §20; QA-LIVE-001. |
| 9.6 | viewport / `resize` | ✅ live-proved | owned-tab `resize`, persistent and bounded; DECISIONS §18; QA-LIVE-001. session.start convenience deferred. |
| 9.2 | `browser.console` | ✅ live-proved | driver ring buffer, read-only, redacted; DECISIONS §21; QA-LIVE-001. |
| 9.3 | `browser.network` | ✅ live-proved | metadata + origin-gated body, headers excluded; DECISIONS §21; QA-LIVE-001. |
| 9.5 | multi-tab sessions | ⏸ deferred | architectural one-driver-per-tab change; DECISIONS §23, ROADMAP. |

The shipped WS9 surface is live-proved in Chrome by QA-LIVE-001. Multi-tab and the
convenience-only status/viewport additions are explicit post-0.4 deferrals.

## Residual cosmetic items (non-blocking)

- `test/fixtures/` — `bb_auth_fixture` keys are self-consistent internal historical
  fixture naming and are intentionally unchanged.

## npm

- `newton-browser@0.4.0` is public on npm. The protected release workflow verified the
  packed artifacts and correctly skipped a duplicate publish.

## Log

- 2026-07-10 — Ledger created; audited WS0–WS8 committed, WS4 staged/incomplete,
  lint gate red. Beginning WS4 completion → WS11.
- 2026-07-10 — WS4 completed (`6fc4ae3`): Node 20 runtime floor reconciled across
  manifests/esbuild/doctor/boundary guard; `--install` command with backup/dry-run/
  force + contract tests; DECISIONS §15. Lint gate green.
- 2026-07-10 — WS9.1 + WS9.7 committed (`f710a97`): `observe` text mode with host-side
  redaction (card/SSN masking, 200k cap) + tests; permanent no-arbitrary-JS decision.
  DECISIONS §16. Gate green, 107/107 tests.
- 2026-07-10 — Paused WS9 after the two low-risk increments. Remaining WS9 items
  (9.2/9.3 new tools + CDP ring buffers, 9.4 dialogs, 9.5 multi-tab, 9.6 viewport,
  9.8 fill_form floor expansion) each need heavier infra, security-sensitive floor
  design, and/or live-browser evidence. WS10/WS11 depend on them; WS11 also needs H5.
- 2026-07-10 — npm name `newton-browser` claimed (0.0.1 placeholder, user-published).
- 2026-07-10 — WS9.4 dialogs implemented: `dialog_accept`/`dialog_dismiss` act kinds,
  driver dialog tracking, redacted `pendingDialog` on observations, floor = agentic,
  legacy `handle_dialog` → `use_dialog_accept_or_dismiss`. DECISIONS §17. Gate green,
  114/114 tests. Live Chrome/Edge evidence row still pending human (extension load).
- 2026-07-10 — WS9.6 resize implemented: owned-tab `resize` act kind, persists
  across debugger re-attach, bounded viewport, floor agentic. DECISIONS §18. Gate
  green, 116/116. Live evidence row pending human.
- 2026-07-10 — BB-035 (critical): wired host-side observation redaction into the live
  result path; it was exported/tested but never invoked, so values + mode:text page text
  reached the client unredacted. End-to-end host tests added. DECISIONS §19, bugs BB-035.
- 2026-07-10 — WS9.8 fill_form (`56f0489`): host-side batch expansion, per-field floor,
  stop-on-sensitive-field. DECISIONS §20.
- 2026-07-10 — WS9.2/9.3 (`da1648e`): read-only browser.console + browser.network with
  driver ring buffers, header exclusion, origin-gated bodies. DECISIONS §21.
- 2026-07-10 — WS10.2/10.3 (`e94ceb2`): screenshot region + jpeg/quality. DECISIONS §22.
- 2026-07-10 — WS5/WS12/WS11 docs (`c96f49a`): PRIVACY.md, store listing + permission
  justifications, ROADMAP.md, 0.4 CHANGELOG. WS9.5 deferred to live (DECISIONS §23).
- 2026-07-10 — Headless build phase complete. Full gate green: build, typecheck, lint,
  127/127 tests. Remaining work is live-verification (all WS9/WS10 evidence rows, 9.5
  multi-tab) and human checkpoints H3/H4/H5/H6. 11 MCP tools exposed.
- 2026-07-11 — Bumped all versions 0.3.0 → 0.4.0 (manifests, host constant, docs,
  examples, CHANGELOG). Fixed a BB-035 fallout regression: result redaction dropped
  `changed.files` (set_files delta) because redactBrowserChanged ignored non-primitive
  values — only the packed-stdio smoke test caught it. Added a unit regression test.
  Full gate + pack:check green at 0.4.0. Store artifact: newton-browser-extension-0.4.0.zip.
- 2026-07-11 — LIVE QA (extension loaded, host 0.4.0 ↔ ext 0.4.0, chrome): verified
  session start/attach/origin-reconcile, observe full+text, screenshot file+JPEG q70,
  console, network list + origin-gated body (cross-origin refused / same-origin allowed),
  dialog_accept (sync-dialog unblock), fill_form safe batch + sensitive-field halt
  (payment_or_pii_field, no keystrokes), resize 1280x800, overlay "driving" indicator.
  Store screenshot captured (artifacts/store/newton-driving-example.png).
- 2026-07-11 — First CI run went red (BB-037): validation/release-check/pack-check ran
  typecheck/test/build:mcp before building @newton-browser/core, which resolves types
  from dist. Fixed order in ci.yml, release-check.mjs, pack-check.mjs; proven in a clean
  clone (128/128 + pack:check green). Pushed for live CI re-check.
- 2026-07-11 — CI GREEN end-to-end (run 29147904773, commit 7aa57d2): both-OS
  validation, Node 20/22/24 packed runtime, and the full packed release gate all pass.
  First-ever CI execution surfaced 5 real cross-platform/order bugs, all fixed:
  BB-036 (set_files redaction regression), BB-037 (typecheck-before-build order),
  BB-038 (Windows-only npm/npx path resolution), BB-039 (npx local-tarball quirk),
  BB-040 (GNU tar can't read ZIPs). WS3 now truly validated, not just authored.
- 2026-07-11 — Incognito owned-tab sessions added (`0a38e06`): browser.session.start
  incognito:true opens the owned tab in an incognito window (reuse-or-create), typed
  incognito_not_allowed when the extension isn't permitted in incognito. Threaded through
  session types/host/bindExternalSession/createOwnedTab. Tabs-port tests. DECISIONS §24.
  User enabled "Allow in incognito" and reloaded the extension. After the Codex restart,
  QA-LIVE-003 proved a real isolated GitHub session, logged-out state, exact 1280x800
  capture, and clean finalization through the registered 0.4.0 MCP host.
- 2026-07-11 — Live QA evidence recorded (QA-LIVE-001/002/003): all 0.4 features verified
  in real Chrome; exact-size logged-out Wikipedia and isolated-incognito GitHub store
  screenshots captured at artifacts/store/. Onboarding/popup shots still require manual
  capture because extension pages are outside Newton's controllable HTTP(S) surface.
- 2026-07-11 — Owner approved the current WS2 icon contact sheet and explicitly deferred
  element-target screenshots, dialog state duplication on `browser.status`, and the
  `session.start` viewport convenience option beyond 0.4. Decision numbering repaired;
  deferrals recorded in DECISIONS §25 and ROADMAP. Current local gate: 131/131 tests.
- 2026-07-11 — Final 0.4 packed release gate passed three consecutive times after the
  incognito and scope-closure changes: 381.5s / 380.7s / 380.5s, 3.32M–3.37M stress
  operations per run, zero cross-results/deadlocks/orphan ports, all 11 stages green.
- 2026-07-11 — Discovery prep completed: static tracker-free `site/`, store promo tile,
  and `server.json`; official `mcp-publisher` 1.7.9 validation passed without publishing.
- 2026-07-11 — The overhauled standalone `newton-browser` skill and all bundled
  references validated successfully. The standalone repository is the authoritative
  distribution source.
- 2026-07-11 — Owner accepted the final static landing page. Read-only release-host audit
  found no GitHub environments, Pages source branch set to `None`, no remote tags, and no
  local npm authentication. These remain explicit human/approval gates rather than code
  defects.
- 2026-07-11 — Owner authorized public release actions and authenticated the npm owner
  account. Created the protected GitHub `release` environment with the owner as required
  reviewer, configured Pages for GitHub Actions, and added a static-site workflow for
  `site/` without changing the approved page. Final clean-port release gate passed in
  381.9s with 3,186,018 stress operations and zero cross-results, deadlocks, or orphan ports.
- 2026-07-11 — CI run 29157179006 caught BB-041: a release-progress note named an
  unrelated product repository and correctly failed the standalone boundary on Linux and
  Windows. Removed the non-product note; the existing boundary gate is the regression.
- 2026-07-11 — Published `newton-browser@0.4.0`, pushed annotated tag `v0.4.0`, and
  completed protected release run 29159340143. The public GitHub Release contains the
  package tarball, extension ZIP, and ZIP SHA-256 asset; the npm idempotency step skipped
  the already-published version. BB-042 moved RSS accounting after an exercised warmup
  without changing the 96 MiB limit; BB-043 included that warmup in the child timeout.
  Hosted evidence: 459,020 warmup operations, 4,662,434 measured operations, zero
  cross-results/deadlocks, and 13,266,944 bytes RSS growth.
- 2026-07-11 — GitHub Pages is live at `https://koala-studios.github.io/newton-browser/`.
  The owner completed the credentialed Chrome Web Store dashboard steps and submitted
  Newton Browser 0.4.0 for review with the verified release ZIP, store icon, promo tile,
  two exact-size screenshots, listing copy, privacy disclosures, and public distribution.
  Chrome submission is complete and now depends on Google's review decision. The owner
  explicitly deferred Edge Add-ons submission until the Chrome listing is live, so WS5
  remains in progress without blocking the Chrome release.
- 2026-07-11 — Post-release documentation reconciled with the public npm/GitHub release,
  Chrome review state, and Edge deferral. Added `docs/DISCOVERY_PLAN.md`: official MCP
  Registry first, downstream-ingestion check, then Newton Browser-assisted Glama,
  PulseMCP, MCP.so, and compatibility-gated Smithery submissions.
- 2026-07-11 — Official Registry publication exposed BB-044: GitHub namespace
  authorization preserves the canonical `Koala-Studios` casing, while immutable npm
  0.4.0 metadata used lowercase. Prepared 0.4.1 with matching Registry/npm metadata and
  a deterministic casing regression. Three consecutive release gates passed in 418.7s,
  410.4s, and 411.6s with 9,032,054 combined operations, zero cross-results/deadlocks,
  identical artifact checksums, and zero orphan ports.
- 2026-07-12 — Protected release run 29178530777 passed the full hosted gate and created
  the public v0.4.1 GitHub Release, then npm rejected the workflow credential with E404.
  BB-045 made partial release retries idempotent and pinned npm publication to the exact
  verified tarball. The owner-authenticated recovery published `newton-browser@0.4.1`;
  public metadata contains `io.github.Koala-Studios/newton-browser`, and the pinned npx
  binary reports 0.4.1.
- 2026-07-12 — Published `io.github.Koala-Studios/newton-browser` 0.4.1 to the official
  MCP Registry. A fresh logged-out Newton Browser session verified one active/latest API
  record with the canonical repository, npm 0.4.1 package, and stdio transport. The
  required 48-hour downstream-ingestion check is due after 2026-07-14 05:07 UTC; Glama,
  PulseMCP, MCP.so, and compatibility-gated Smithery remain intentionally untouched until
  then to avoid duplicates.
