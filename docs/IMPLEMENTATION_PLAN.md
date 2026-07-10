# Newton 0.4 Product Implementation Plan (Browser Bridge → newton-browser)

Status: approved plan, ready for execution. Owner decisions already made are recorded in
"Locked decisions" below and are not open for re-litigation by the executing worker.

This document is written for an autonomous worker (agent) executing in this repository.
It defines every workstream needed to take Browser Bridge from a source-install preview
to an installable product: license, icons, npm publication, CI and GitHub releases,
browser-store listings, onboarding, capability gaps versus peer tools, and performance
work. The worker is expected to complete roughly 90% of this unassisted and stop at the
explicitly marked human checkpoints.

---

## 1. Operating rules for the worker

1. **Follow repository conventions.** Read `CONTRIBUTING.md`, `docs/DECISIONS.md`, and
   `docs/RELEASE.md` first. Any new tool, protocol field, or contract change requires a
   decision entry in `docs/DECISIONS.md` and matching contract tests. Evidence rows go
   in `test/evidence/qa-ledger.md` as established.
2. **Gate every merge.** `pnpm release:check` must pass before a workstream is marked
   complete. `pnpm lint` (boundary check) and `pnpm typecheck` must pass on every commit.
3. **Human checkpoints.** Tasks marked `[H#]` require the human. When one is reached:
   finish all parallel work that does not depend on it, post a concise summary of what
   is blocked and exactly what the human must do (one message, all pending checkpoints
   batched), then stop and wait. Do not simulate, skip, or work around a checkpoint.
4. **Use Browser Bridge for web work.** Dashboard preparation (Chrome Web Store, Edge
   Partner Center, npm settings, registry submissions) should be driven through the
   `browser.*` MCP tools where possible: navigate, fill listing text, upload prepared
   assets, capture evidence screenshots. The worker must never enter credentials,
   payment details, or one-time codes, and must never click the final publish/submit/pay
   control — it prepares everything up to that point and hands the tab to the human via
   `browser.tabs.finalize` with `handoff`.
5. **Sequencing.** Workstreams are ordered by dependency in section 3. Independent
   workstreams may be interleaved. Prefer landing repo-only work (WS1–WS4, WS6–WS10)
   before starting the externally gated work (WS5, WS11, WS12).
6. **Versioning.** All of this ships as **0.4.0**. Bump versions once, at the end, in
   WS11 (release), not piecemeal.

## 2. Locked decisions (from the owner)

- **Name: `newton-browser`, brand "Newton".** Decided 2026-07-10; the owner verified
  npm availability. Full naming scheme and rename execution are WS0. Publish an npm
  placeholder as soon as an npm account exists — availability is point-in-time.
- **License: MIT.** Copyright holder "Koala Studios" (confirm exact legal string at [H1]).
- **Popup stays minimal.** A glanceable status surface, not a dashboard the user is
  expected to monitor. No options page, no activity log, no settings UI beyond the
  existing pairing form. See WS7 for the exact allowed scope.
- **No Firefox support.** Chrome and Edge only. Other Chromium browsers are
  "untested, may work" in docs; no engineering effort beyond WS10's doc note.
- **No arbitrary JavaScript evaluation tool.** An eval tool would bypass the typed
  action floor that defines the product. Record as a decision entry (WS9, task 9.7).

## 3. Dependency order

```text
WS0 Rename ───(first, before everything)
WS1 License ──────────────┬─→ WS4 npm packaging ──→ WS11 Release ──→ WS12 Listings/registries
WS2 Icons ────────────────┤                             ↑
WS3 CI + release workflow ┘                             │
WS5 Store submissions (needs WS1, WS2, WS3; long review pole — start early)
WS6 Onboarding page ──→ feeds WS5 screenshots
WS7 Popup sessions (independent)
WS8 Version skew (before store auto-update decouples versions; needs nothing)
WS9 Capability gaps (independent; largest engineering block)
WS10 Performance + observation budgets (after WS9 lands, shares driver code)
```

Recommended execution order: WS0 → WS1 → WS2 → WS3 → WS6 → WS7 → WS8 → WS4 → WS9 →
WS10 → WS5 (submit as soon as WS1+WS2+WS6 exist, because store review is the long
pole) → WS11 → WS12.

---

## WS0 — Rename to newton-browser

**Status: completed 2026-07-10** (tasks 0.1–0.4 done; decision entry #12 in
`docs/DECISIONS.md`). Extension-internal `BB_*` message types additionally became
`NB_*`, and the doctor probe header became `X-Newton-Browser-Doctor`.

**Goal:** the project is consistently "Newton" everywhere before anything is published
under the old name. Executed first; pre-1.0, breaking renames of env vars and protocol
strings are acceptable and are not individually decision-gated (one decision entry
covers the whole rename).

**Naming scheme (locked):**

| Surface | Name |
|---|---|
| Brand / display | Newton |
| GitHub repo | `Koala-Studios/newton-browser` |
| npm package (published) | `newton-browser` |
| CLI bin | `newton-browser` (`newton-browser --doctor`, `--install`, …) |
| Internal workspace packages (private) | `@newton-browser/core`, `@newton-browser/driver` |
| Extension manifest `name` / `short_name` | "Newton Browser" / "Newton" |
| MCP server key in client configs | `newton-browser` |
| Env var prefix | `NEWTON_BROWSER_` (e.g. `NEWTON_BROWSER_AUTH_MODE`, all 19 former `BROWSER_BRIDGE_*` vars) |
| Auth protocol id | `newton-browser-auth-v1` (replaces `browser-bridge-auth-v1`) |
| Per-user config dir | `newton-browser` (XDG/platform equivalents) |
| Skill | `skills/newton-browser`, skill `name: newton-browser` |
| Release artifacts | `newton-browser-<v>.tgz`, `newton-browser-extension-<v>.zip` (+ `.sha256`) |
| MCP registry `mcpName` | `io.github.koala-studios/newton-browser` |

MCP tool names (`browser.*`) are **unchanged** — they are generic, already correct,
and renaming them would break recorded client transcripts for no benefit.

**Tasks:**

- **0.1 [H0]** Human renames the GitHub repo: repo → Settings → General → Repository
  name → `newton-browser` → Rename. GitHub redirects the old URL and git remotes
  automatically, so nothing breaks in the interim. Human also renames the local
  working directory (`C:\DEV\browser-bridge` → `C:\DEV\newton-browser`) when no
  session/process holds it open, and reopens tooling from the new path.
- **0.2** Update the local git remote:
  `git remote set-url origin https://github.com/Koala-Studios/newton-browser.git`.
- **0.3** Code rename sweep (68 files reference the old name; use grep, not memory):
  package names + workspace filter references in all `package.json` and root scripts;
  env vars (19 `BROWSER_BRIDGE_*` → `NEWTON_BROWSER_*`, including QA/smoke-only vars);
  `browser-bridge-auth-v1` → `newton-browser-auth-v1` in `packages/core` protocol, host, and
  extension transport; per-user config dir in `apps/mcp-server/src/config.ts`;
  extension manifest `name`/`short_name`/`description`; `--print-config` and
  `--doctor` output strings; artifact/build script output names; `skills/browser-bridge`
  directory + frontmatter; `examples/mcp/*`; all docs (`README.md`, `docs/*`,
  `CONTRIBUTING.md`, `AGENTS.md`, issue/PR templates) including GitHub URLs.
- **0.4** History and evidence stay untouched: existing `docs/DECISIONS.md` entries,
  `test/evidence/qa-ledger.md` rows, and `artifacts/` transcripts keep the old name as
  historical record. Add one new decision entry recording the rename and the naming
  scheme table above.
- **0.5** Final check: `grep -ri "browser.bridge" --include exclusions for evidence/`
  returns only historical files; `pnpm release:check` green; a fresh clone from the
  new GitHub URL builds and passes `smoke:quick`.

**Acceptance:** fresh clone of `Koala-Studios/newton-browser` builds green; no
non-historical occurrence of the old name; extension loads showing "Newton
Browser"; `newton-browser --doctor` works from the packed tarball.

---

## WS1 — MIT license

**Status: completed 2026-07-10.**

**Goal:** the repository is legally adoptable and publishable.

- **1.1** Add `LICENSE` at the repo root: standard MIT text,
  `Copyright (c) 2026 Koala Studios`.
- **1.2** Add `"license": "MIT"` to the root `package.json` and to
  `apps/mcp-server/package.json`, `apps/extension/package.json`,
  `packages/core/package.json`, `packages/driver/package.json`.
- **1.3** Replace the README "License status" section with a one-line MIT statement
  linking to `LICENSE`. Remove the "no license yet" caveat from `docs/RELEASE.md`.
- **1.4 [H1]** Confirm with the human: exact copyright holder string ("Koala Studios"
  vs. a registered legal name) and the npm package name decision from WS4.1. Proceed
  with "Koala Studios" as the default if the human approves.

**Acceptance:** `LICENSE` present; every `package.json` declares MIT; no doc claims the
project is unlicensed; `pnpm release:check` green.

---

## WS2 — Icon and visual identity

**Status: in progress 2026-07-10.**

**Goal:** the extension has real icons everywhere Chrome shows one, with connection
state visible from the toolbar. The 128 px icon is a hard prerequisite for the store
listing (WS5).

- **2.1** Author a master icon as SVG in `apps/extension/icons/icon.svg`. Design brief:
  a simple, geometric "bridge between two surfaces" mark (e.g. two rounded nodes joined
  by a span), flat colors, legible at 16 px, no text, transparent background. Must not
  imitate Chrome, Edge, or any AI-vendor logo.
- **2.2** Add `scripts/render-icons.mjs` using `sharp` (devDependency, root workspace
  only — verify `scripts/verify-boundary.mjs` still passes) that rasterizes the SVG to:
  - `icons/icon-16.png`, `icon-32.png`, `icon-48.png`, `icon-128.png` (manifest `icons`)
  - `icons/action-connected-16/32.png` and `icons/action-disconnected-16/32.png`
    (toolbar states; disconnected = desaturated/grayed variant)
  Commit both the SVG and the rendered PNGs; the script exists for regeneration, not as
  a build step (keeps the deterministic extension artifact byte-stable).
- **2.3** Manifest: add the `icons` block and `action.default_icon`. Include the icons
  in the packed artifact (`scripts/build-extension-artifact.mjs` and `pack-check`
  listings must account for them).
- **2.4** In `apps/extension/src/service-worker.js`, call `chrome.action.setIcon` on
  host connect/disconnect transitions (the same events that already drive `BB_STATE`),
  so the toolbar shows connection state at a glance. Debounce so rapid reconnects do
  not flicker.
- **2.5** Produce a one-page preview contact sheet (all sizes on light/dark strips,
  plus a real toolbar screenshot at 100% zoom captured via Browser Bridge) and present
  it to the human.
- **2.6 [H2]** Human approves or requests one revision round of the icon before it is
  used in store assets. Extension work does not block on this; store submission (WS5)
  does.

**Acceptance:** placeholder letter icon gone in `chrome://extensions`, toolbar, and the
extensions menu; toolbar icon visibly changes with connection state; deterministic
artifact check still passes; evidence screenshot in the qa-ledger.

---

## WS3 — CI and release automation

**Status: in progress 2026-07-10.**

**Goal:** the existing local release gate runs on every PR, and tagging a version
produces a GitHub Release with the exact artifacts `docs/RELEASE.md` already defines.

- **3.1** `.github/workflows/ci.yml`:
  - Triggers: `pull_request`, `push` to `main`.
  - Job 1 (ubuntu-latest, Node 24): `pnpm install --frozen-lockfile`, `pnpm lint`,
    `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm smoke:quick`.
  - Job 2 (windows-latest, Node 24): same steps — Windows is the strongest-evidence
    platform and must stay green.
  - Job 3 (ubuntu-latest): `pnpm release:check`, with a generous timeout. If any
    release-check stage requires a real browser and cannot run headless in CI, split
    that stage behind an env flag and document it as a local-only gate in
    `docs/RELEASE.md` rather than weakening the gate.
  - Job 4 (matrix: Node 20, 22, 24): pack the MCP tarball, install it into a temp dir,
    and run `newton-browser --version` and `--doctor` offline checks. This enforces
    the WS4.3 runtime floor.
- **3.2** `.github/workflows/release.yml`:
  - Trigger: tag push matching `v*`.
  - Steps: full gate, then `pnpm extension:artifact` and `pnpm pack:check`, generate
    sha256 files, create a GitHub Release with
    `newton-browser-<v>.tgz`, `newton-browser-extension-<v>.zip`, `.sha256`, and
    release notes drawn from a `CHANGELOG.md` section.
  - npm publish step runs in a GitHub **environment** named `release` with required
    reviewer protection — this is the standing human gate for publishes ([H5] applies
    on first setup).
- **3.3** Add `CHANGELOG.md` (Keep-a-Changelog format) seeded with 0.1–0.3 summaries
  from git history and an Unreleased section this plan's work accumulates into.
- **3.4** Update `docs/RELEASE.md`: CI is now the enforcement mechanism; local
  `release:check` remains the pre-push convention.
- **3.5 [H3]** Human enables any repo settings the worker cannot change (Actions
  permissions, environment `release` with required reviewers, branch protection if
  desired). Worker prepares exact click-by-click instructions.

**Acceptance:** CI green on a no-op PR; a dry-run tag on a throwaway branch produces a
draft release with correct, checksum-verified artifacts.

---

## WS4 — npm packaging and naming

**Goal:** `npx`-installable MCP host; client config becomes one copyable block with no
absolute paths.

- **4.1 Naming (resolved).** The package publishes as **`newton-browser`** per the
  WS0 naming scheme (owner-verified available; note `browser-bridge-mcp` and
  `browser-bridge` were already squatted on npm, which prompted the rename). As soon
  as npm credentials exist ([H5]), publish a `0.0.1` placeholder with the real README
  to hold the name — do not wait for 0.4.0.
- **4.2 Package metadata.** In `apps/mcp-server/package.json`: `license`,
  `repository` (with `directory`), `homepage`, `bugs`, `keywords`
  (`mcp`, `mcp-server`, `browser`, `chrome`, `edge`, `automation`, `agent`), `author`,
  and `mcpName` (`io.github.koala-studios/newton-browser` — required later by the MCP
  registry, WS12). Add a dedicated `apps/mcp-server/README.md` written for the npm
  page: what it is, the extension prerequisite, the three client config blocks, and a
  link back to the repo. Confirm via `pnpm pack:check` that `files` ships only `dist`,
  README, and package.json.
- **4.3 Runtime Node floor.** The shipped `dist` is compiled JS with a single `ws`
  dependency, so the published package can support older Node than the dev workspace:
  - Set esbuild target in `scripts/build-mcp.mjs` to `node20` and audit `dist` for
    Node >20 API usage (no `node:sqlite`, no `import.meta.dirname` reliance, etc.).
  - Package `engines`: `">=20.0.0"`. Root workspace `engines` stays `>=24` (tests use
    `node --test` on TS sources, which needs modern type stripping).
  - CI job 3.1/Job 4 proves the tarball runs on 20/22/24. Update README/INSTALL
    requirements: "Node 20+ to run; Node 24+ to develop."
- **4.4 Config simplification.** Update `README.md`, `docs/INSTALL.md`,
  `docs/MCP_CLIENTS.md`, `examples/mcp/*.json`, and `--print-config` output to lead
  with the npx form:
  ```json
  { "command": "npx", "args": ["-y", "newton-browser"] }
  ```
  Keep the source-checkout absolute-path form as the contributor path. Remove the
  `BROWSER_BRIDGE_PACKAGE_SPEC` tarball dance from the primary flow (retain for
  offline installs).
- **4.5 `--install <client>` command.** Extend `apps/mcp-server/src/cli.ts`:
  - `newton-browser --install codex|claude-code|claude-desktop|generic`
  - Locates the client config (`~/.codex/config.toml`, Claude Desktop's platform
    config path, or `claude mcp add` shell-out for Claude Code), shows the exact diff,
    writes a timestamped `.bak` backup, and merges the entry. `--dry-run` prints the
    diff only; `--yes` skips the confirmation prompt for scripted use. Refuses to
    overwrite an existing `browser-bridge` entry without `--force`.
  - Typed errors (`client_config_not_found`, `client_config_unparseable`) with a
    pointer to the manual instructions. Contract tests against fixture config files
    for all three clients on all three OS path conventions.
- **4.6** Decision entry in `docs/DECISIONS.md` covering the package name, the
  dev/runtime engine split, and `--install` semantics.

**Acceptance:** `pnpm pack:check` green; tarball installs and runs `--doctor` on Node
20/22/24 in CI; `--install --dry-run` produces correct diffs for all three clients from
fixtures; docs lead with the npx config. Actual `npm publish` happens in WS11.

---

## WS5 — Browser store submissions (Chrome Web Store + Edge Add-ons)

**Goal:** users install the extension from a store — no Developer mode, automatic
updates. This is the longest external lead time; prepare and submit as early as WS1,
WS2, and WS6 allow.

**Worker-preparable (do all of this before involving the human):**

- **5.1 Privacy policy.** Add `docs/PRIVACY.md`: no telemetry, no analytics, no remote
  servers, loopback-only relay, what page data flows where (only to the user's own MCP
  client), what is stored (`chrome.storage.local`: pairing secret hash and settings
  only). Both stores require a public privacy-policy URL; serve it via the WS12 GitHub
  Pages site or the raw GitHub URL as fallback.
- **5.2 Listing copy.** Draft in `docs/store/listing.md`: name ("Browser Bridge" —
  first check both stores for name collisions using Browser Bridge itself), summary
  (132 chars for CWS), full description leading with local-only architecture,
  category (Developer Tools), and single-purpose statement ("connects local MCP
  clients to this browser for agent-driven browsing").
- **5.3 Permission justifications** (CWS review asks for each): `debugger` (CDP is the
  control mechanism — expect heightened review; cite the loopback-only relay, exact
  origin scoping, and the in-extension safety floor), `tabs`/`tabGroups` (owned-tab
  lifecycle), `scripting` (overlay/observation), `storage` (settings), `alarms`
  (reconnect timers), host permissions (session origins are user-scoped at runtime;
  the manifest breadth exists because sessions can target any user-chosen origin).
  Evaluate whether `optional_host_permissions` is feasible instead of blanket
  `http/https` host permissions — if the runtime can request per-origin grants at
  `session.start` without breaking the attach flow, that materially improves review
  odds; if not, document why in the justification. Also note in the listing that
  Chrome shows an "is debugging this browser" info bar during sessions — set
  expectations rather than let reviewers/users be surprised.
- **5.4 Store assets.** From WS2 icons: 128 px store icon; screenshots (1280×800) of
  the onboarding page, the popup in connected state with a session row, and an agent
  driving an owned tab — capture these with Browser Bridge itself; small promo tile
  440×280 rendered from the icon SVG.
- **5.5 Submission package.** The exact `browser-bridge-extension-0.4.0.zip` from the
  release gate is the upload artifact. Verify the zip root contains `manifest.json`.

**Human-required:**

- **5.6 [H4]** Chrome Web Store developer account: Google account choice, one-time $5
  registration fee, publisher identity/email verification. Worker drives the dashboard
  via Browser Bridge afterward: create item, upload zip, paste listing copy and
  justifications, attach assets — then hands the tab to the human for the final
  **Submit for review** click.
- **5.7 [H4]** Edge Add-ons: Microsoft Partner Center registration (free). Same
  pattern: worker fills everything, human clicks submit.
- **5.8** After submission, poll review status weekly (Browser Bridge can check the
  dashboards read-only when the human has left a session open, or the human forwards
  emails). Prepare a canned response template for reviewer questions about `debugger`.
- **5.9** Post-approval: update README/INSTALL to make store install the primary path;
  keep unpacked install as the contributor path; add the store badge/links.

**Acceptance:** both listings submitted; docs updated on approval; store item IDs
recorded in `docs/RELEASE.md` for future update uploads.

---

## WS6 — First-run onboarding page

**Status: in progress 2026-07-10.**

**Goal:** installing the extension immediately tells the user whether the bridge works
and how to configure their client — currently install ends in silence.

- **6.1** `apps/extension/onboarding.html` + `src/onboarding.js/.css`, opened once from
  the service worker on `chrome.runtime.onInstalled` with `reason === "install"`
  (never on `update`). Include it in the packed artifact.
- **6.2** Page contents (static, extension-page CSP, zero external requests):
  1. Live connection status reusing the `BB_PANEL_STATUS` machinery, auto-refreshing:
     "Waiting for an MCP client…" → "Connected" when a host appears.
  2. Step card: "Install the host" — the npx config blocks for Codex / Claude Code /
     Claude Desktop / generic, each with a copy button, plus the
     `newton-browser --install <client>` one-liner.
  3. Step card: "Verify" — tell the user to ask their agent to call `browser.status`.
  4. Collapsed troubleshooting section distilled from `docs/TROUBLESHOOTING.md`, and a
     link to the repo.
- **6.3** The popup gets a small "Setup guide" link that reopens this page (covers the
  update-install and moved-config cases without any onInstalled nagging).
- **6.4** Tests: extension readiness smoke (`smoke:extension-ready`) asserts the page
  is present in the artifact; a fixture test covers the "opens once on install, never
  on update" logic.

**Acceptance:** fresh unpacked install opens the page exactly once; status flips to
Connected when a host starts; screenshots captured for WS5.4; qa-ledger row recorded.

---

## WS7 — Popup: minimal session visibility

**Status: in progress 2026-07-10.**

**Goal (scoped by owner decision):** the popup stays a glanceable surface the user is
*not expected to check* — it only answers "is it connected, what is it touching" when
someone does look. Hard cap on scope; anything beyond the list below is out.

- **7.1** Keep the existing status line and pairing form untouched.
- **7.2** Add an active-sessions list: one row per session across connected hosts —
  origin (exact, no favicon fetching), tab mode badge (`owned` / `current`), and the
  session's `instanceLabel` when present. Empty state: no list rendered at all (popup
  looks exactly like today).
- **7.3** Add a single **Stop all** button, visible only when at least one session is
  active, wired to the existing `browser.stop_all` path through a new
  `BB_PANEL_STOP_ALL` message. Confirmation is the button itself (no dialog); the
  action is already designed to be safe and explicit.
- **7.4** Version line in small text at the bottom (`manifest.version`, plus host
  version once WS8 lands) — this doubles as the surface for the WS8 skew warning.
- **7.5** Data path: extend the service worker's `BB_PANEL_STATUS` response with a
  bounded session summary (origin, mode, label only — no URLs, no titles, nothing
  content-derived, consistent with the redaction posture). Update `BB_STATE` pushes so
  an open popup stays current.
- **7.6** Contract tests for the new message shapes; extension fixture test for
  render/empty/stop-all; qa-ledger evidence row with a real two-session screenshot.

**Acceptance:** popup with no sessions is visually identical to 0.3.0 plus the version
line; with sessions it shows rows and Stop all; total popup JS stays small (target:
under ~150 lines).

---

## WS8 — Version-skew handling

**Goal:** once the store auto-updates the extension while users pin an npm version,
mismatches become routine; they must produce a typed, actionable answer instead of a
protocol failure.

- **8.1** Include `version` (package/manifest version) in both directions of the
  existing hello/handshake exchange in `packages/core/src/protocol.ts` and the
  transports. Unknown extra fields must already be tolerated by 0.3.0 peers — verify,
  so 0.4↔0.3 conversations degrade to "version unknown" rather than failing.
- **8.2** Compatibility policy (decision entry): same `major.minor` = compatible;
  patch skew = silently fine; minor/major skew = still attempt to operate, but
  `browser.status` reports `extensionVersion`, `hostVersion`, and
  `versionSkew: "none" | "patch" | "incompatible"` with a typed `nextAction`
  ("update the npm package" / "update the extension").
- **8.3** Popup (WS7.4) shows a single amber line on `incompatible` skew. Nothing else.
- **8.4** Contract tests: skewed-version fixtures both directions, plus a
  missing-version (0.3.0 peer) fixture.

**Acceptance:** `browser.status` reports versions and skew; skewed fixtures pass;
decision entry recorded.

---

## WS9 — Capability gaps versus peer tools

**Goal:** close the everyday gaps that make agents fall back to other browser tools.
Peer comparison (Playwright MCP and Anthropic's Claude-in-Chrome/Claude Code browser
tools, surveyed 2026-07):

| Capability | Playwright MCP | Claude in Chrome | Browser Bridge 0.3 | This plan |
|---|---|---|---|---|
| Accessibility observation | ✅ snapshot | ✅ read_page | ✅ observe (full/diff) | parity — keep |
| Screenshot | ✅ | ✅ (+zoom region) | ✅ (image/file/inline) | region/element capture → WS10 |
| Page text extraction | via snapshot | ✅ get_page_text | ❌ | **9.1** |
| Console messages | ✅ | ✅ | ❌ | **9.2** |
| Network request list + body | ✅ | ✅ | ❌ | **9.3** |
| JS dialog handling | ✅ handle_dialog | ✅ | ❌ typed unsupported | **9.4** |
| Multi-tab in one task | ✅ browser_tabs | ✅ tabs_* | ❌ one tab per session | **9.5** |
| Viewport/device control | ✅ resize | ✅ resize_window | screenshot-only `device` | **9.6** |
| Batch form fill | ✅ fill_form | ✅ form_input | one action per call | **9.8** |
| Arbitrary JS eval | ✅ run_code_unsafe | ✅ javascript_tool | ❌ | **excluded by design — 9.7** |
| Drag and drop | ✅ | ❌ | ❌ | deferred (note in ROADMAP) |
| File upload | ✅ | ✅ | ✅ set_files | parity — keep |
| Wait primitives | ✅ | ✅ | ✅ wait_for | parity — keep |
| Recording/GIF, PDF export | partial | GIF | ❌ | deferred (ROADMAP) |

Every new tool below: decision entry, action-schema/protocol additions in
`packages/core`, driver implementation in `packages/driver`, host wiring in
`apps/mcp-server`, redaction review, contract + fixture tests, tool-reference and
skill (`skills/browser-bridge`) updates, live-QA smoke coverage.

- **9.1 `browser.observe` text mode.** Add `mode: "text"` returning readable page text
  (main-content extraction first, body innerText fallback), bounded by a `maxChars`
  cap with typed truncation metadata. Runs through the existing text-redaction pass.
  This is the cheap "read the article/docs" primitive that currently forces a full
  observation.
- **9.2 `browser.console`.** Buffer CDP `Runtime.consoleAPICalled` +
  `Log.entryAdded` per session (ring buffer, e.g. 500 entries) from session start.
  Tool params: `sessionId`, `level` filter, `pattern` substring, `limit`, `clear`.
  Messages pass text redaction; stack traces trimmed. Read-only → `decision.class:
  "read_only"`.
- **9.3 `browser.network`.** Enable CDP `Network` domain per session; keep a bounded
  ring of request metadata (method, URL, status, type, sizes, timing). Two modes: list
  (filterable by `urlPattern`) and body fetch by `requestId` — body fetch is capped
  (reuse the existing relay/result size bounds → `result_too_large`), passes redaction,
  and **must refuse bodies for requests whose URL origin is outside the session's
  granted origins** (typed `origin_not_granted`) to preserve the origin story.
  Request/response *headers are excluded entirely* (cookies, auth tokens) — metadata
  and bodies only. This exclusion is the load-bearing privacy line; test it explicitly.
- **9.4 Dialog handling.** New act kinds `dialog_accept` / `dialog_dismiss` (with
  optional `promptText` for accept), backed by CDP `Page.javascriptDialogOpening`
  events. A pending dialog is exposed in observe results and `browser.status` for that
  session. Auto-behavior: none — dialogs remain agent-decided, but now decidable.
  `beforeunload` dialogs map to the same kinds. Floor: `dialog_accept` on
  `beforeunload` during navigation is `agentic`; ordinary alert/confirm/prompt accept
  is `agentic`; nothing here can be `blocked`-class since the dialog was page-initiated.
- **9.5 Multi-tab sessions.** Track pages opened from an owned tab (window.open,
  target=_blank) via CDP targets: they join the session's tab group, inherit the
  origin grant check (a popup outside `allowedOrigins` is immediately closed with a
  typed observe note), and become addressable via a `tabId` param on
  observe/act/screenshot (default: the original tab). `browser.tabs.list` grows
  per-session tab rows; `finalize` and `stop` handle all session tabs. This fixes the
  common "clicked a link, it opened a new tab, session is now blind" dead end.
  Current-tab sessions do **not** get multi-tab (scope stays deliberately narrow).
- **9.6 Session viewport control.** `session.start` gains optional
  `viewport: { width, height } | "mobile" | "desktop"` applied via
  `Emulation.setDeviceMetricsOverride` for owned tabs only (never current-tab), and an
  act kind `resize`. Screenshot `device` param remains as a per-shot override.
- **9.7 Eval exclusion decision.** Record in `docs/DECISIONS.md`: no arbitrary
  JavaScript execution tool. Rationale: every mutation must route through typed
  actions so the safety floor's classification is sound; an eval tool converts the
  floor into a suggestion. Revisit only with a sandboxed read-only expression design.
- **9.8 Batch fill.** New act kind `fill_form`: an ordered array of
  `{target, value}` pairs, executed sequentially with the standard per-field floor
  checks; stops at first failure and reports per-field results. Saves one round trip
  per field on multi-field forms — a meaningful token/latency win for agents.

**Acceptance per tool:** decision entry, schema validation both directions,
fixture-driven contract tests, live smoke coverage in `smoke:real-browser`, redaction
tests (9.2/9.3 especially), tool-reference + skill docs updated, release gate green.

---

## WS10 — Performance and token-efficiency

**Goal:** measurable budgets instead of vibes; agents pay fewer tokens and less
latency per step.

- **10.1 Observation budget.** Define a target: full observation of the heavy fixture
  pages ≤ a fixed token-equivalent budget (measure chars as proxy; record the chosen
  number in the decision entry). Add a fixture with a virtualized/infinite-scroll page.
  Where over budget: tighten compaction (dedupe repeated siblings, collapse offscreen
  regions with a typed marker) and document `maxChars`-style bounds on observe.
- **10.2 Region and element screenshots.** `browser.screenshot` gains optional
  `region: {x,y,width,height}` and `target` (element ref) — captures only the needed
  pixels; smaller payloads, less masking surface. Reuses existing delivery modes.
- **10.3 Image format/quality knob.** Optional `format: "png" | "jpeg"` +
  `quality` for evidence-grade vs. token-grade captures (JPEG at q≈70 is typically
  5–10× smaller for screenshots sent to models). PNG stays default.
- **10.4 Cold-start and idle-wake budget.** `smoke:cold-starts` already measures
  distribution; set explicit p95 targets (record current numbers first, then target),
  and address the MV3 idle-wake penalty: on host connect, verify the existing `alarms`
  keepalive keeps the first post-idle command under the target; if not, add a
  lightweight reconnect-then-retry in the host so the first command absorbs the wake
  transparently instead of failing.
- **10.5** Record before/after numbers for 10.1–10.4 in the qa-ledger.

**Acceptance:** budgets written down as decision entries; measured before/after
evidence; no regression in the deterministic artifact or release gate.

---

## WS11 — Release 0.4.0

**Goal:** everything above ships as one coherent release.

- **11.1** Bump all versions to 0.4.0; finalize `CHANGELOG.md`; refresh README (store
  install path if approved, npx config, new tool list, Node 20 runtime floor).
- **11.2** Full `pnpm release:check` on Windows locally + CI green; complete all open
  qa-ledger rows (the RELEASE.md rule stands: no open/skipped critical evidence).
- **11.3 [H5]** Human: create the npm account, enable 2FA,
  configure trusted publishing (GitHub OIDC) or a granular automation token as a repo
  secret, and approve the `release` environment. Worker prepares exact instructions.
- **11.4** Tag `v0.4.0` (human approves the tag push), CI publishes the GitHub Release;
  npm publish runs through the protected environment ([H5] reviewer approval is the
  publish gate).
- **11.5** Upload the 0.4.0 zip to both store dashboards (worker drives, human clicks
  submit — same pattern as WS5).
- **11.6** Post-release verification from a machine-clean directory:
  `npx -y newton-browser --doctor`, store-installed extension,
  onboarding page, one real end-to-end session. Record in qa-ledger.

---

## WS12 — Discovery surface

**Goal:** people can find, evaluate, and trust the product without cloning the repo.

- **12.1 Landing page.** GitHub Pages from a `site/` directory (or `docs/` subpath):
  single static page — what it is, the local-only architecture diagram, a short
  screen-capture demo (record an agent driving a session; an animated PNG/GIF is fine
  at this stage), install instructions (store link + npx block), privacy policy
  (WS5.1), and doc links. No trackers, no external assets — consistent with the
  product's story. **[H6]** Human approves content before Pages is enabled (publishing
  is outward-facing).
- **12.2 MCP registry submissions.** Official MCP registry (`mcpName` from WS4.2,
  publisher CLI, GitHub auth — the auth step is human; worker prepares the
  `server.json`). Then community indexes (Smithery, PulseMCP, Glama, mcp.so): worker
  fills each submission via Browser Bridge; human performs any login/final submit.
- **12.3 `ROADMAP.md`** at the repo root: shipped (0.4.0), next (deferred items:
  drag-and-drop, recording/GIF, PDF export, sandboxed read-only eval study,
  other-Chromium test matrix), explicitly-not-planned (Firefox, arbitrary JS eval,
  telemetry of any kind). Link from README and the issue templates.
- **12.4** README top: badges (CI, npm version, store link), one-paragraph pitch, and
  the demo capture from 12.1.

**Acceptance:** page live, registries listing the server, ROADMAP linked; all
outward-facing content human-approved before publish.

---

## Human checkpoint registry

| ID | What the human must do | Blocks |
|----|------------------------|--------|
| H0 | Rename GitHub repo to `newton-browser` (Settings → General → Rename); rename the local working directory when no session holds it | WS0 |
| H1 | Confirm copyright holder string ("Koala Studios" default) | WS1.4 |
| H2 | Approve icon design (one revision round budgeted) | WS5 store assets only |
| H3 | Repo settings: Actions permissions, `release` environment + required reviewer, optional branch protection | WS3 finalization, WS11 publish |
| H4 | Create Chrome Web Store dev account (pay one-time $5) and Edge Partner Center account; sign in; click final Submit on both listings | WS5 |
| H5 | Create/confirm npm account with 2FA, publish-permission setup (trusted publishing or token secret); approve the release-environment publish; the `newton-browser` name placeholder should be published here immediately | WS4 placeholder, WS11 |
| H6 | Approve landing-page content; enable GitHub Pages; perform registry logins/final submits | WS12 |

Batching guidance for the worker: H0+H1 can be asked immediately at kickoff. H2
arrives with the WS2 contact sheet. H3+H5 are one "repo & npm setup" session (do H5
early — the npm name is unprotected until the placeholder is published). H4 is one
"store accounts" session where the worker drives the browser and the human handles
sign-in, payment, and submit clicks. H6 closes the project.

## Explicitly out of scope

- Firefox support (owner decision; also structurally blocked: no `chrome.debugger`).
- Arbitrary JavaScript evaluation tooling (WS9.7 decision).
- Popup growth beyond WS7's list (no options page, no logs, no settings UI).
- Telemetry, analytics, crash reporting, or any remote service — in any workstream.
- Drag-and-drop, session recording/GIF, PDF export — ROADMAP "next", not 0.4.0.
