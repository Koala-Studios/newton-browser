# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
