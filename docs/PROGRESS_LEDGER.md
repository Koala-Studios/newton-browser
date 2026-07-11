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
| WS2 | Icons + toolbar states | ✅ | `2c55f7c`, `59aac3f`, `bd3bfcd`; manifest `icons`/`default_icon` wired |
| WS3 | CI + release workflows | ✅ | CI GREEN on Linux+Windows, Node 20/22/24, full release gate (run 29147904773). Fixed BB-036..BB-040. |
| WS4 | npm packaging + Node floor + `--install` | ✅ | metadata; Node 20 runtime floor reconciled; `--install` + tests; DECISIONS §13 |
| WS5 | Store submissions | 🚧 `[H4]` | PRIVACY.md + listing copy + permission justifications done (docs/store/); screenshots/accounts/submit need human |
| WS6 | First-run onboarding page | ✅ | `cf52dbb`, `de5124b`; `apps/extension/onboarding.{html,js}` |
| WS7 | Minimal popup sessions | ✅ | `4b03650`, `0e3b238`; session list + Stop-all |
| WS8 | Version-skew handling | ✅ | `3a14386`, `9abcbea`; `classifyVersionSkew`, status reports versions |
| WS9 | Capability gaps (new tools) | 🔶 | 9.1/9.2/9.3/9.4/9.6/9.7/9.8 done; 9.5 multi-tab deferred to live (DECISIONS §21). Plus BB-035. |
| WS10 | Performance / observation budgets | 🔶 | 10.2 region + 10.3 jpeg/quality done (DECISIONS §20); 10.1 obs-budget + 10.4 cold-start are live-measurement, deferred |
| WS11 | Release 0.4.0 | 🔶 `[H5]` | versions bumped to 0.4.0; artifact + tarball built; pack:check green. npm publish + tag need human. |
| WS12 | Discovery (ROADMAP/PRIVACY/landing) | 🔶 | ROADMAP.md + PRIVACY.md done; landing page + registry submissions need human (H6) |

## Gate status

- `pnpm typecheck` — ✅ green
- `pnpm test` — ✅ 128/128 pass (build, typecheck, lint, pack:check all green)
- `pnpm lint` (boundary) — ✅ green (Node floor reconciled to `>=20.0.0`)

## WS9 breakdown

| Item | Capability | Status | Why / what it needs |
|------|-----------|--------|---------------------|
| 9.1 | `observe` text mode | ✅ committed | read-only; done to full quality with redaction + tests |
| 9.7 | eval exclusion (decision) | ✅ committed | DECISIONS §14 |
| 9.4 | dialog accept/dismiss | ✅ committed | CDP `Page.handleJavaScriptDialog`; `pendingDialog` on observations; DECISIONS §15; deterministic tests. Live evidence row still pending. |
| 9.8 | `fill_form` batch fill | ✅ committed | host-side expansion into sequential fills; per-field floor; stops at sensitive field; DECISIONS §18. Live evidence row pending. |
| 9.6 | viewport / `resize` | ✅ committed | owned-tab `resize` act kind, persists across re-attach, bounded; DECISIONS §16. session.start `viewport` convenience option deferred. Live evidence row pending. |
| 9.2 | `browser.console` | ✅ committed | driver ring buffer (Runtime/Log), read-only tool, redaction, tests; DECISIONS §19. Live evidence pending. |
| 9.3 | `browser.network` | ✅ committed | driver ring buffer, list + origin-gated body, headers excluded, tests; DECISIONS §19. Live evidence pending. |
| 9.5 | multi-tab sessions | ⏸ deferred | architectural (one-driver-per-tab today); needs live multi-target iteration. DECISIONS §21, ROADMAP. |

All remaining WS9 items also require live Chrome/Edge evidence rows in `qa-ledger.md`
per the release-gate convention — the extension must be loaded unpacked in a real
browser, which needs the human.

## Residual cosmetic items (non-blocking)

- `packages/driver/src/overlay.css:6` — comment still references `BB_DRIVE_BEGIN`
  (constant is now `NB_DRIVE_BEGIN`).
- `scripts/verify-boundary.mjs` — stale `"browser bridge"` guard term (matches nothing).
- `test/fixtures/` — `bb_auth_fixture` keys are self-consistent internal test naming.
- `docs/DECISIONS.md` — duplicate section numbers (two §13, two §14) from an earlier
  worker append; renumber in a docs pass. New entries continue from §15.

## npm

- `newton-browser` name claimed on npm (0.0.1 placeholder published 2026-07-10).
  Real 0.4.0 publish happens in WS11 (overwrite, never unpublish).

## Log

- 2026-07-10 — Ledger created; audited WS0–WS8 committed, WS4 staged/incomplete,
  lint gate red. Beginning WS4 completion → WS11.
- 2026-07-10 — WS4 completed (`6fc4ae3`): Node 20 runtime floor reconciled across
  manifests/esbuild/doctor/boundary guard; `--install` command with backup/dry-run/
  force + contract tests; DECISIONS §13. Lint gate green.
- 2026-07-10 — WS9.1 + WS9.7 committed (`f710a97`): `observe` text mode with host-side
  redaction (card/SSN masking, 200k cap) + tests; permanent no-arbitrary-JS decision.
  DECISIONS §14. Gate green, 107/107 tests.
- 2026-07-10 — Paused WS9 after the two low-risk increments. Remaining WS9 items
  (9.2/9.3 new tools + CDP ring buffers, 9.4 dialogs, 9.5 multi-tab, 9.6 viewport,
  9.8 fill_form floor expansion) each need heavier infra, security-sensitive floor
  design, and/or live-browser evidence. WS10/WS11 depend on them; WS11 also needs H5.
- 2026-07-10 — npm name `newton-browser` claimed (0.0.1 placeholder, user-published).
- 2026-07-10 — WS9.4 dialogs implemented: `dialog_accept`/`dialog_dismiss` act kinds,
  driver dialog tracking, redacted `pendingDialog` on observations, floor = agentic,
  legacy `handle_dialog` → `use_dialog_accept_or_dismiss`. DECISIONS §15. Gate green,
  114/114 tests. Live Chrome/Edge evidence row still pending human (extension load).
- 2026-07-10 — WS9.6 resize implemented: owned-tab `resize` act kind, persists
  across debugger re-attach, bounded viewport, floor agentic. DECISIONS §16. Gate
  green, 116/116. Live evidence row pending human.
- 2026-07-10 — BB-035 (critical): wired host-side observation redaction into the live
  result path; it was exported/tested but never invoked, so values + mode:text page text
  reached the client unredacted. End-to-end host tests added. DECISIONS §17, bugs BB-035.
- 2026-07-10 — WS9.8 fill_form (`56f0489`): host-side batch expansion, per-field floor,
  stop-on-sensitive-field. DECISIONS §18.
- 2026-07-10 — WS9.2/9.3 (`da1648e`): read-only browser.console + browser.network with
  driver ring buffers, header exclusion, origin-gated bodies. DECISIONS §19.
- 2026-07-10 — WS10.2/10.3 (`e94ceb2`): screenshot region + jpeg/quality. DECISIONS §20.
- 2026-07-10 — WS5/WS12/WS11 docs (`c96f49a`): PRIVACY.md, store listing + permission
  justifications, ROADMAP.md, 0.4 CHANGELOG. WS9.5 deferred to live (DECISIONS §21).
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
