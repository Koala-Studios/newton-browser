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
| WS9 | Capability gaps (new tools) | ⛔ | not started |
| WS10 | Performance / observation budgets | ⛔ | not started |
| WS11 | Release 0.4.0 | ⛔ | versions still 0.3.0 (correct until WS11) |
| WS12 | Discovery (ROADMAP/PRIVACY/landing) | ⛔ | not started |

## Gate status

- `pnpm typecheck` — ✅ green
- `pnpm test` — ✅ 98/98 pass
- `pnpm lint` (boundary) — ✅ green (Node floor reconciled to `>=20.0.0`)

## Residual cosmetic items (non-blocking)

- `packages/driver/src/overlay.css:6` — comment still references `BB_DRIVE_BEGIN`
  (constant is now `NB_DRIVE_BEGIN`).
- `scripts/verify-boundary.mjs` — stale `"browser bridge"` guard term (matches nothing).
- `test/fixtures/` — `bb_auth_fixture` keys are self-consistent internal test naming.

## Log

- 2026-07-10 — Ledger created; audited WS0–WS8 committed, WS4 staged/incomplete,
  lint gate red. Beginning WS4 completion → WS11.
