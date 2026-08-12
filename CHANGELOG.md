# Changelog

## [Unreleased]

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

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
