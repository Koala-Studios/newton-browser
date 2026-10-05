# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.7.11] - 2026-10-05

### Changed

- A `waitFor` on an action that has no after-wait of its own (`navigate`, `fill`, …), or
  written on the command instead of the action, becomes a following `wait_for` step in a
  sequence, reported under `normalized`. `click`, `hover` and `click_at` keep their own.

## [0.7.10] - 2026-10-05

### Fixed

- Clients that open with the classic MCP `initialize` handshake connect. Claude Code
  2.1.228 does so (depending on its release and settings) and could not reach the server at
  all. That connection gets the same tools without per-request protocol metadata.
  `2026-07-28` clients are unchanged.
- `fill` and `type` accept `text` for `value`, reported under `normalized`.
- A `wait_for` without its own `timeoutMs` may use the whole command budget, so a longer
  command `timeoutMs` lets a wait outlast a slow page instead of stopping at ten seconds.

## [0.7.9] - 2026-10-05

### Changed

- **Near-miss arguments work.** `browser.act` and the read tools rewrite shapes agents
  commonly write into the exact command before checking it, and list each rewrite in the
  result under `normalized`:
  - a wait's condition nested in `waitFor`;
  - `waitFor.kind` used as the state;
  - flat `ref`/`selector`/`role`+`name`;
  - `select` with `label` (or `value: { label }`);
  - `type` naming the action kind;
  - a ref written as `"e3"`;
  - a target or scope without its `kind`;
  - command fields beside `command` (or the command unwrapped);
  - numbers as strings.

  Conflicting or ambiguous input is still refused. Embedding hosts that check arguments
  themselves use the exported `normalizeToolArguments` first.
- **`wait_for` carries its condition itself**, like every other action:
  `{ kind: "wait_for", target, state }`, or `url`, `title` or `text`. `waitFor` remains
  the wait after `click`, `hover` and `click_at`.
- A wait reports `postcondition: { kind: "condition", condition }` naming what held
  (`hidden`, `enabled`, `url`, …), instead of `visible` for every wait.

### Fixed

- A URL wait with `*` (`**/done**`) matches as a wildcard pattern.
- A read scope (`observe`, `document.read`) that matches several elements reads the first
  and reports `scopeMatches`. An action target stays exact.
- A wait keeps waiting while a page still loading cannot finish a search, instead of
  failing at once with `search_incomplete`.

## [0.7.8] - 2026-10-05

### Changed

- **Breaking:** `waitFor` names an element with the same `target` as every action
  (`{ target: { kind: "ref", ref: "e3" }, state: "visible" }`), instead of its own flat
  `ref`, `selector` or `role` with `name`. Agents reused the action form and were refused.
  The flat fields are gone, not aliased.

### Added

- `waitFor` states `enabled` and `disabled`: wait until a control becomes usable. A custom
  control counts as disabled while it or an ancestor has `aria-disabled="true"`.

## [0.7.7] - 2026-10-05

### Fixed

- A page that commits but stays parsing (a script that never loads) returns as loading
  after ten seconds, instead of after nearly the whole budget. A start with the default
  30 second budget used to end so close to its deadline that a client's own limit could
  time it out. Observe no longer waits a second time for a document that already spent
  its parse wait.

### Changed

- `newton-browser install` says what it checked (the server starts and lists its tools)
  and what it did not (an agent using them), and names the client's own remedy when
  first use fails: update Codex, or `claude auth login` for an expired Claude Code sign-in.

## [0.7.6] - 2026-10-03

### Fixed

- Owned browsers present a fine pointer with hover. On a host with no pointing device
  (a Linux container, such as an embedding's runner) Chrome reported `pointer: none` and
  `hover: none`, and sites switched hover menus to click-only, so `hover` acknowledged
  but opened nothing.

## [0.7.5] - 2026-10-03

### Fixed

- A frame that attached and was removed at once (storefront apps do this while loading)
  left its setup waiting forever: every selector or role target returned
  `search_incomplete` and screenshots waited on it. Its detach now settles the setup.
- Screenshots wait for frames to stop attaching and changing, then retry within the
  budget instead of failing right after a navigate or scroll. An unavailable screenshot
  carries `detail` saying which condition failed and whether retrying helps.
- `click_at` and `move` stay valid while animation runs elsewhere on the page: only the
  captured surroundings of the point must still match.
- Role targets skip child frames with no rendered box, whose accessibility queries
  Chromium may never answer, and report `search_incomplete` instead of waiting out the
  command when a frame does not answer.
- `<summary>` disclosures appear in observe as buttons with their `expanded` state and
  resolve as `button` role targets.
- Document reads and text waits include closed shadow roots. A native count of all
  shadow-root children against the open ones page script reaches proves whether any
  exist, so pages without them pay one search.

### Added

- `target_covered`: a target that another element covers names it in the step's
  `coveredBy` (for example a signup popup), instead of returning `target_moved`.

### Changed

- The default screenshot budget is 4 MiB, which fits a 1440x900 photographic viewport.

## [0.7.4] - 2026-10-03

### Fixed

- macOS key input no longer stalls the browser. Key events carried a native key code,
  which sent each one through the system menu's shortcut search: seconds per key, with the
  whole browser unresponsive meanwhile (select, typing and live-view keys alike).
- A select on a control that is already focused starts a fresh type-ahead search, so a
  second select within a second no longer misses.
- Start, navigate and observe return a page that committed but is still parsing (for
  example behind a script that never loads) with `loading: true`, instead of timing out
  and closing the session.
- An observe `query` with text reaches matching links and controls beyond the per-role
  bounds; matching names take the bounded slots first.
- Release certification fails when a required test was skipped, not only when one failed.

### Changed

- The select `value` and press `keys`/`text` fields are described in the tool schema, and
  `docs/MCP_CLIENTS.md` shows the current start, observe, act and stop path.

## [0.7.3] - 2026-10-02

### Added

- `newton-browser install claude-code` verifies the exact candidate over stateless MCP
  `2026-07-28`, then registers a user-scope server through `claude mcp add-json`
  (`--force` replaces an existing entry).

### Fixed

- The existing-browser add-on starts with Chrome and on any tab switch or page load, so its
  native connection comes back on its own instead of reporting `adapter_unavailable` until a
  tab opened or closed. Its manifest is unchanged, so `adapter update` applies it.

## [0.7.2] - 2026-09-28

### Added

- Embedding `adoptSignIn`: a running session takes a person's new sign-in and reloads its
  page, so a worker continues signed in without restarting.

### Fixed

- Browsers starting at the same moment no longer fail with `browser_launch_failed`
  (`identity_lease`): the profile store lock waits briefly for another process instead of
  failing at once.

## [0.7.1] - 2026-09-28

### Fixed

- A passkey request no longer hangs in a headless session. Headless Chrome has no prompt a
  person could cancel, so a session without passkeys (a person's sign-in) refuses passkey
  requests at once, as cancelling would, and a session with passkeys refuses a sign-in for a
  site it holds none for. Sites no longer sit with their other sign-in options disabled.

## [0.7.0] - 2026-09-28

### Changed

- One shared session engine serves owned browsers, the operator's own Chrome (through the
  tab adapter) and the embedding API; the legacy direct runtime is retired.
- The published tool catalog is compact (about 16 KB instead of 24 KB); argument errors
  still name the field and what it expected.
- Runs on macOS in owned and existing-browser modes, with Claude Code and Codex as MCP
  clients over stateless MCP `2026-07-28`.

### Added

- `browser.session.start` lists `loginSites`, the sites the login source holds cookies for.
- Observations report `loading: true` while a page is still loading.
- `resize` works in the operator's own tabs through device metrics, without resizing
  their window.
- Opt-in console and network reads; covering overlays and custom clickable elements in
  observations; a page that stops responding is reopened on the same identity.
- Embedding API: live frames, operator takeover, passkeys and shared sign-in.

### Fixed

- Stopping a session in the operator's Chrome closes the tabs it opened and releases theirs.
- Full reads of large pages are bounded per query instead of timing out.
- `press` without a target sends keys to the page.
- Screenshots are captured at page (CSS) pixels, matching `click_at` coordinates.
- The shared profile store survives macOS volume device renumbering.

## [0.6.3] - 2026-08-20

### Fixed

- Replaced browser-session page auto-attach with exact target discovery for owned popups
  and new tabs. Newton leaves provisional blank targets untouched, attaches only after an
  owned target commits to HTTP(S), routes subsequent page commands through that target,
  and restores a freshly rebuilt opener context when the secondary page closes.
- Added bounded post-input target reconciliation so a popup whose target event crosses the
  action-signal boundary is available through the next same-session observation without a
  browser-chrome click or a second MCP session.
- Added the Windows Edge compatibility-layer bypass used to preserve inherited private
  CDP pipe handles; it is never added to Chrome or non-Windows Edge.
- Added deterministic provisional-target and routing regressions plus real Chrome and Edge
  secondary-page/opener-restoration coverage to the complete release gate.

## [0.6.2] - 2026-08-19

### Fixed

- Bound interactive refs to the latest observation cycle instead of retaining every ref
  ever seen during a same-document SPA lifetime. A fresh interactive observation now
  recovers its own bounded ref budget without navigation, reload, or session replacement.
- Stop invisible, filtered, duplicate, and otherwise non-emitted observation candidates
  from consuming ref capacity. Text observations remain ref-free and do not invalidate the
  current interactive snapshot.

## [0.6.1] - 2026-08-19

### Fixed

- Removed every post-action blocking path. Normal POST, GraphQL, telemetry, navigation,
  dialog, popup, and download activity can no longer retroactively turn dispatched input
  into `outcome: prevented` or a retry-safe result.
- Hardened the direct host so a driver-level blocked result after command admission is
  classified as `outcome_unknown` and never retry-safe.
- Made operator closure of the visible identity-login browser a normal completion path;
  the command still reports success only after exact runtime and identity-lease cleanup.
- Updated agent recovery guidance to retain and re-observe the same session after an
  uncertain or unverified dispatch instead of restarting authentication.

## [0.6.0] - Unreleased

### Changed

- Removed the exact-origin policy proxy, origin-grant configuration, CDP Fetch
  interception, request denial, and blocked-origin result fields. Owned Chrome and Edge
  now use ordinary Chromium networking for redirects, subresources, frames, workers,
  popups, and browser background dependencies.
- Removed network-altering launch flags that disabled extensions, sync, component
  updates, default apps, and background networking. Newton still launches a dedicated
  isolated process and profile over a private CDP pipe.
- Removed page-altering focus emulation, persistent mutation observers, and screenshot
  script/animation freezing. Observation uses non-mutating reads and sensitive pixels are
  masked after capture in trusted Node code.
- Simplified session start to one initial HTTP(S) URL. `allowedOrigins`, `originGrants`,
  origin-grant CLI commands, containment receipts, and their compatibility paths no
  longer exist.
- Reworked real-site QA to require usable rendered pages across video, community,
  commerce, advertising, reference, and standards sites, and to reject browser-generated
  blocked/error pages or leaked icon ligatures.
- Corrected `wait_for` so attached, visible, hidden, detached, checked, unchecked, and
  value states retain distinct semantics instead of treating every selector as visible.
- Made selector targeting tolerate hidden responsive duplicates while retaining
  fail-closed visible ambiguity, and added bounded fresh-target recovery before a
  selector/semantic fill has dispatched any input.
- Agent MCP sessions remain headless for deterministic trusted input; the separate
  operator `identity login` browser is visible. Both now use the same unrestricted normal
  Chromium network behavior.

> The 0.5.1 and 0.5.2 entries below describe the historical implementation shipped in
> those versions. Their origin-grant behavior is not part of the current contract.

## [0.5.2] - 2026-08-18

### Changed

- Add durable operator-approved exact-origin grant policies that are merged
  automatically into matching MCP sessions and visible identity-login runs.
- Allow `identity login --origin <primary>` to resolve the operator-bound identity,
  removing the need for agents to remember opaque identity IDs or repeat reviewed
  redirect grants.
- Return the exact canonical `blockedOrigin` for an authoritatively denied main-frame
  navigation while continuing to reject automatic page-authored authorization.

## [0.5.1] - 2026-08-18

### Fixed

- Classify denied main-frame navigation before an action settles so agents receive a
  typed `prevented` result instead of a misleading successful but inert control.
- Add bounded request-class diagnostics for denied origins without exposing URL paths,
  queries, or unrelated page content.
- Add durable exact-origin bindings for operator-owned identities, while preserving
  per-session lease exclusivity and ephemeral identities for unrelated origins.
- Clarify the headless MCP session boundary versus the separate visible operator login
  workflow, and synchronize the installed Newton Browser skill contract.

## [0.5.0] - 2026-08-12

### Fixed

- Added a crash-surviving browser guardian with exact process-tree and identity/lease
  cleanup ownership, plus explicit stale-lease inspection/recovery.
- Removed temporal proxy-to-command attribution; prevented outcomes now require causal
  driver evidence while the proxy remains an aggregate fail-closed boundary.
- Added direct queued/running command deadline semantics, a ten-minute 256-entry
  idempotency window, and privacy-safe direct full status.
- Removed MCP source maps from the tarball and made the complete release gate include
  Chrome/Edge direct-live and read-only production-site QA.
- Added real-site and forced-host-crash live stages. Final integrated results remain to
  be recorded; this entry is not a release claim.
- Collapsed safety decisions to one class, one commit boundary, and one bounded reason;
  removed duplicate blocked/evidence/reason-array fields and the console clear mutation.
- Made cancellation phase truthful: queued cancellation is retry-safe and not started,
  while running cancellation remains FIFO-fenced and returns outcome unknown.
- Made screenshot publication fail closed on missing mask disposition, malformed or
  noncanonical image data, signature mismatch, oversized data, or unredactable metadata.
- Tightened modern MCP request shapes, cursor handling, unknown-method/tool errors, and
  client-supplied fields without adding initialization or framing compatibility.
- Modern parse and invalid-request errors now omit an unavailable request ID exactly as
  required by the 2026-07-28 MCP response schema; they never emit a legacy `id:null`.
- Unsupported-version errors now expose only the specification-defined `supported` and
  `requested` data fields instead of adding a product compatibility label.
- Bounded stdio output queues, made fragmented input assembly linear, and made output
  failure terminate admission instead of accumulating unwritable responses.
- Removed private frame-routing test fields, nested response-shape fallbacks, and the
  duplicate session attachment/live-origin mirrors.
- Enabled workspace-wide unused-local and unused-parameter errors so compatibility debris
  cannot remain hidden after contract removal.
- Narrowed redacted bounding-box tuples and wait states explicitly under the workspace's
  exact optional and unchecked-index compiler contract.
- Removed the last two inert cursor-paint compatibility calls/methods and corrected the
  constructor's stale typed-error helper name.
- Made host/runtime option construction exact, exported the observation input contract,
  narrowed redacted result access, and deleted the impossible driver-level `fill_form`
  compatibility guard surfaced by the final workspace typecheck.
- Removed the standalone eval-only `browser.wait_for` and nested-target compatibility
  shapes; the checked-in corpus and replay engine now use the exact public action grammar.
- Resumed an exact paused related target when its authoritative URL becomes granted,
  instead of advancing Newton's ticket while leaving Chromium permanently paused.
- Removed untrusted page titles from screenshot metadata alongside the encoded image.
- Made browser-page auto-attach rollback stateful so a failed enable retains its precise
  setup error while an acknowledged enable is still disabled before debugger teardown.
- Marked unsuccessful `browser.act` tool results as MCP errors while preserving their
  canonical prevented/not-started/unknown action envelope for agent inspection.
- Omitted absent console/network options at the exact optional-property boundary instead
  of constructing invalid explicit `undefined` fields.
- Migrated every connected frame/input/containment harness to the strict public target,
  observation-cap, provenance, and result contracts; removed test-only legacy assumptions.
- Made containment QA distinguish causal driver prevention from independent proxy
  enforcement and stopped claiming that intentionally commit-floored popup actions were
  allowed successes.
- Replaced unreliable consent/challenge-dependent YouTube and Reddit pages in public QA
  with their public text endpoints while retaining AX/action/screenshot coverage on the
  five interactive reference and commerce sites.
- Made the clean-tree three-pass verifier launch pnpm through Node on Windows instead of
  directly spawning a command shim, which Node 25 rejects with `EINVAL`.
- Kept mandatory public real-site QA as one evidence matrix per browser/platform while
  removing volatile third-party availability from the three artifact-reproducibility
  repetitions.
- Canonicalized secure profile-store and hermetic-eval roots beneath a linked/junction
  temporary ancestor while continuing to reject a linked store leaf.
- Extended junction-safe canonicalization to executable validation, opaque profile
  sources, and guardian-owned identity cleanup without permitting linked leaves or hard
  links.
- Made Linux validation wait for peer socket-close events and use platform-native
  absolute-path fixtures; absolute workspace-path scanning now requires a path boundary
  instead of misclassifying ordinary `/worker` text under a short `/work` checkout.
- Prevented custom driver parity builds from deleting and rebuilding the shared core
  output while concurrent tests import it; the normal package build remains the sole
  owner of core compilation.
- Made release verification run the Linux container as the exact runner UID/GID for its
  owned evidence mount, and made Windows resolve pnpm from the active setup action when
  setup-node leaves a stale non-existent `npm_execpath`.
- Standardized the direct-runtime live harness on native canonical temp paths so Windows
  8.3 runner paths cannot make successful authoritative cleanup look refused.
- Removed arbitrary Chromium argument injection from the runtime composition. Browser
  launch switches are now a fixed product policy rather than a caller-controlled blacklist.
- Removed the empty/active-session-derived browser-family list from public status; browser
  selection remains an explicit bounded session-start argument.
- Removed the host's active-session-derived identity count. Concurrency QA now inventories
  the owned identity store directly after cleanup instead of treating missing sessions as
  proof that ephemeral identities were removed.
- Removed fixed-success config and zero-buffer placeholders from doctor output; the next
  action now points directly to `doctor --live` when static configuration is usable.
- Made session provisioning abortable so stop or request cancellation cannot publish a
  browser that completed startup after cleanup began; malformed driver deltas now return
  non-retryable outcome uncertainty instead of being treated as verified.
- Removed the stale browser-store website path and old Node compatibility matrix; active
  CI, release, docs, and install surfaces are direct-runtime and Node 24 only.
- Removed the orphan GitHub Pages deployment and marketing site. The private MCP package
  no longer has an automatic public-deployment side channel.
- Bound the complete release gate to the exact source candidate, including explicit
  records for intentionally deleted tracked files, before and after every verification run.
- Unified MCP and identity utilities on one strict profile-store resolver, rejected
  relative/root config overrides, and made first-use identity creation initialize its
  owned config directory without requiring setup first.
- Keyed full queue/lifecycle diagnostics by the already-public session ID so concurrent
  sessions can be diagnosed without exposing process, target, profile, or lease identity.
- Removed duplicate eval/quick-test executions and the duplicate core build from the
  deterministic pipeline; focused commands remain available, while each release fact is
  proved once per pass. The publication workflow now enforces three consecutive passes.
- Removed transition-era AIP test filenames and the obsolete add-on discovery plan, and
  documented the strict operator-only host-policy configuration that remained intentional.
- Made direct-runtime, setup, crash, and seven-site QA emit their final receipt only after
  authoritative host and owned-temp cleanup; cleanup uncertainty now supersedes a
  green-looking workflow result instead of being swallowed.
- Made the seven-site QA remove its identity-bound temporary root when host construction
  fails before a host exists, instead of retaining a pre-host setup artifact.
- Aligned the exact allowed-origin caps across MCP admission and direct-runtime startup,
  and bounded every canonical HTTP(S) origin.
- Reversed owned-runtime startup rollback correctly: proxy closure is confirmed before
  releasing the identity lease.
- Reconciled lost stop acknowledgements against authoritative session inventory without
  hiding retained cleanup uncertainty.
- Enforced the canonical composite-ref grammar for every sensitive screenshot zone and
  rejected blank stdio lines as invalid JSON instead of accepting a compatibility no-op.
- Made packed installs offline/no-audit/no-fund, removed the unused native `sharp`
  dependency, and migrated the packed utility gate off the deleted `config print` alias.
- Removed the live-QA browser-family environment fallback; QA has one canonical
  `NEWTON_BROWSER_QA_BROWSER` selector, while production configuration remains separate.
- Removed precursor release receipts and extension-era program matrices that could be
  mistaken for evidence about the modern frozen tree. The retained defect and provenance
  ledgers are historical records; fresh final receipts are generated only after freeze.
- Bound host policy to one immutable snapshot loaded from the exact host config directory;
  action evaluation no longer consults process-global configuration after construction.
- Made public `allowedOrigins` unambiguously additional-only: zero to 31 exact grants,
  with primary-origin repetition and duplicate grants rejected before session creation.
- Extended the Linux Chrome matrix from package-shape checking to an exact-tarball
  install and packed owned-browser run with its own bounded gate status.
- Removed the external tokenizer override and UTF-8 heuristic fallback from the token
  gate; release cost measurement now always uses the pinned `o200k_base` implementation.
- Removed empty vendor-default host-policy merge scaffolding and reject overlapping
  operator manifests instead of making file order an authorization decision.
- Centralized runtime and packed-smoke version identity on the shipped MCP package
  manifest, and marked the core/driver workspace packages private.
- Made publication depend on three-pass Windows and Linux verification, Windows
  Chrome/Edge, the pinned Linux CFT matrix, and matching cross-platform tarball hashes.
- Made default config resolution honor the supplied isolated home on every platform,
  preventing macOS/Windows fallback into the operator's real profile during clean runs.
- Removed raw-TypeScript guardian execution from production browser launch; source and
  packed workflows now require the exact compiled guardian artifact.
- Read browser selection and host policy from one validated immutable configuration
  snapshot; setup refuses to preserve malformed policy state.
- Made core compilation replace its output directory before emit and made the boundary
  gate reject retired compiled modules, eliminating stale compatibility artifacts.
- Bound publication's three passes to one clean tagged candidate: per-platform receipts
  now require identical pass digests and artifacts, record commit/tree identity, and must
  match across Windows and Linux before publication.
- Removed setup's duplicate config-directory validator; every MCP, setup, identity, and
  doctor path now uses the same strict owned config resolver.
- Aligned identity-login origin admission with the single 512-character grant bound used
  by MCP, host, driver, proxy, registry, and documentation.
- Derived CLI version and doctor Node requirements from one validated shipped package
  manifest, removing both duplicated literals and an unresolved doctor constant.
- Extended exact optional-property, checked index-access, and override enforcement from
  the driver to the entire core/MCP TypeScript workspace.

### Added

- Version `0.5.0` is the first direct-only/stateless candidate; the minor-version break
  distinguishes it from the incompatible published extension-era `0.4.5` package.
- Direct owned-browser runtime: one isolated Chrome/Edge process, private CDP pipe,
  exact-origin launch-time proxy, identity lease, and FIFO command pump per session.
- Opaque Newton identities with operator login and fail-closed narrow import from a closed
  stable local profile.
- Source and exact-packed direct live gates for Windows Chrome/Edge and Linux Chrome,
  including concurrency, nested OOPIF routing, containment, input, dialogs, lifecycle,
  and cleanup.
- Stateless MCP `2026-07-28` newline-delimited stdio with per-request metadata,
  discovery, cancellation, concurrent bounded request handling, and complete results.

### Changed

- Removed the MV3 application, loopback relay, pairing/version-skew control plane,
  current-tab/tab-group/incognito compatibility contracts, browser-store packaging, and
  all extension build and release paths. Stateless stdio is the sole runtime.
- Removed initialization-era MCP, legacy framing, socket continuity, session finalize,
  screenshot file/inline delivery, nested action targets, result aliases, synthetic tab
  IDs, page-effects, and owned/unowned driver compatibility branches.
- Removed redundant `eval:live`, `release:complete-local`, and `config print` aliases.
  Direct live QA, release QA, and client installation now each have one canonical command.
- Removed implicit configured identities. Setup records only a browser preference;
  persistent identities are created separately and used only by explicit opaque ID.
- Promoted the owned-browser workflow to stable `setup` and `doctor --live` commands;
  removed the migration-era `preview` command namespace and its aliases.
- Documentation and every shipped/cached Newton Browser skill now describe only direct
  configured-idle status, isolated owned processes, opaque identities, stop-only cleanup,
  modern request metadata, image-only screenshots, and typed cleanup failures.

### Security

- The exact-origin proxy is ready before browser launch and prevents denied application
  requests independently of CDP interception.
- Sensitive-zone screenshots pause the controlled targets, measure exact bounded zones,
  capture lossless PNG, and apply opaque masks in Newton's trusted Node raster pipeline.
  Missing targets, malformed images, geometry churn, or pause/resume uncertainty fail
  closed; no unmasked fallback is returned.

## [0.4.5] - 2026-08-04

### Fixed

- Focus an observed session without mutating its tab when that tab is already
  active. If Chrome rejects an activation during a concurrent focus change, accept
  it only when a fresh tab read proves that the exact target became active.

## [0.4.4] - 2026-08-04

### Fixed

- Allow explicit persistent-MCP idle windows up to 30 days so approval-gated worker
  runs retain the same authenticated Browser host across human decision pauses.
  Explicit daemon shutdown still owns cleanup.

## [0.4.3] - 2026-08-04

### Fixed

- Resolve a global executable's symlink before deciding whether the compiled entrypoint
  is the main module. Global installs now run utility commands and persistent Unix-socket
  daemon mode instead of exiting successfully without starting.

## [0.4.2] - 2026-08-03

### Added

- Optional local observer registry with authenticated session-status and exact-tab
  focus endpoints for private embedded viewers. The registry exposes only bounded
  session metadata and remains disabled unless both its directory and token are set.
- A deployment-supplied instance label can bind every session from one MCP host to
  its originating worker run without changing the public MCP tool contract.
- Explicit Unix-socket daemon/client modes let an orchestrator preserve one local
  browser host and its owned sessions across sequential MCP client reconnects.
  The socket is private, single-client, and refuses unsafe stale paths.
- An authenticated observer can apply one already-resolved secret to one exact
  fresh field reference without exposing the value through the public MCP tool
  catalog or weakening ordinary credential/OTP blocking.

### Security

- Observer endpoints stay loopback-only, require a separate high-entropy bearer
  token, never expose page content or grants, and do not transfer session ownership.

## [0.4.1] - 2026-07-11

### Fixed

- Match the official MCP Registry namespace to GitHub's canonical organization casing
  (`io.github.Koala-Studios/newton-browser`) so GitHub ownership and npm package
  verification agree during publication.

## [0.4.0] - 2026-07-11

### Added

- MIT licensing and package metadata.
- Extension visual identity, generated PNG master icon, toolbar connection state, and deterministic icon packaging.
- CI and release workflows; `newton-browser` npm packaging via `npx`, a Node 20 runtime floor, and a `--install <client>` config helper.
- First-run onboarding page and a minimal session-visibility popup with a stop-all control.
- Host/extension version-skew reporting on `browser.status`.
- `browser.observe` text mode (`mode:"text"`) returning bounded, redacted page text.
- JavaScript dialog handling: `dialog_accept` (with `promptText`) and `dialog_dismiss` act kinds, plus `pendingDialog` on observations.
- Owned-tab viewport `resize` act kind, persisted across debugger re-attach.
- Batch `fill_form` act kind with per-field floor and stop-on-first-failure.
- Read-only `browser.console` and `browser.network` tools (headers never exposed; network bodies origin-gated).
- Screenshot `region` capture and `format:"jpeg"`/`quality` encoding.
- Privacy-preserving owned sessions with `browser.session.start({ incognito: true })`,
  including typed `incognito_not_allowed` guidance when extension access is disabled.

### Fixed

- Host-side observation redaction is now wired into the live result path, so accessible values and `mode:"text"` page text reach the client secret-redacted (BB-035).

### Security

- Renamed from Browser Bridge to Newton Browser; retired the old env-var prefix, auth protocol id, and config directory.

## [0.3.0] - 2026-07-10

### Added

- Standalone local MCP host and MV3 extension with bounded loopback discovery.
- Exact-origin sessions, owned-tab lifecycle controls, screenshots, file selection, host-policy manifests, and simultaneous Chrome/Edge arbitration.
- Deterministic packed-artifact, clean-user, chaos, and real-browser release evidence.

## [0.2.0] - 2026-07-10

### Added

- Early local browser-control preview and foundational transport contracts.

## [0.1.0] - 2026-07-10

### Added

- Initial project bootstrap and safety-floor design.
