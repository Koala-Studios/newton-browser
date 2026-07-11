# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
