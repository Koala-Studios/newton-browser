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
| WS3 | CI + release workflows | ✅ | `b5e5bea`, `c780698`; `.github/workflows/ci.yml`, `release.yml` |
| WS4 | npm packaging + Node floor + `--install` | ✅ | metadata; Node 20 runtime floor reconciled; `--install` + tests; DECISIONS §13 |
| WS5 | Store submissions | 🚧 `[H4]` | worker-preparable assets pending; accounts need human |
| WS6 | First-run onboarding page | ✅ | `cf52dbb`, `de5124b`; `apps/extension/onboarding.{html,js}` |
| WS7 | Minimal popup sessions | ✅ | `4b03650`, `0e3b238`; session list + Stop-all |
| WS8 | Version-skew handling | ✅ | `3a14386`, `9abcbea`; `classifyVersionSkew`, status reports versions |
| WS9 | Capability gaps (new tools) | 🔶 | 9.1/9.2/9.3/9.4/9.6/9.7/9.8 done; 9.5 (multi-tab) remaining. Plus BB-035 redaction fix. |
| WS10 | Performance / observation budgets | 🔶 | 10.2 region + 10.3 jpeg/quality done (DECISIONS §20); 10.1 obs-budget + 10.4 cold-start are live-measurement, deferred |
| WS11 | Release 0.4.0 | ⛔ `[H5]` | versions still 0.3.0 (correct until WS11); depends on WS9/WS10 + npm creds |
| WS12 | Discovery (ROADMAP/PRIVACY/landing) | ⛔ | not started |

## Gate status

- `pnpm typecheck` — ✅ green
- `pnpm test` — ✅ 127/127 pass
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
| 9.5 | multi-tab sessions | ⛔ | CDP target tracking; most invasive |

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
