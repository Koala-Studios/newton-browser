# Newton Browser Roadmap

Newton Browser is local, agent-agnostic browser control for MCP clients. This roadmap is
directional, not a commitment. See `docs/IMPLEMENTATION_PLAN.md` for the detailed 0.4
plan and `docs/PROGRESS_LEDGER.md` for current status.

## Shipped toward 0.4.0

- Renamed to Newton Browser; MIT licensed.
- Icons and connection-state toolbar icon; first-run onboarding page; minimal
  session-visibility popup with a stop-all control.
- CI and release automation; npm packaging (`npx newton-browser`), Node 20 runtime
  floor, and a `--install <client>` config helper.
- Host/extension version-skew reporting.
- Capability additions: `browser.observe` text mode; JavaScript dialog accept/dismiss;
  owned-tab viewport `resize`; batch `fill_form`; read-only `browser.console` and
  `browser.network`; screenshot region capture and JPEG/quality encoding.
- Privacy-preserving owned sessions with `browser.session.start({ incognito: true })`.
- Security: host-side redaction of observation results wired into the live path
  (BB-035).

## Next (candidate, post-0.4)

- **Multi-tab sessions (WS9.5).** Track pages opened from an owned tab (window.open /
  target=_blank), origin-gate popups, and address child tabs from observe/act/screenshot.
  Requires live multi-target iteration; the single-tab core stays intact until it lands.
- **Observation token budget and cold-start p95 targets (WS10.1 / WS10.4).** Measured
  against real heavy pages; formalize caps and idle-wake handling.
- **session.start `viewport` convenience option** (a counterpart to the `resize` act kind).
- **Element-target screenshots.** Resolve a fresh element ref into a bounded screenshot
  crop; 0.4 callers use the existing `region` option.
- **Dialog state on `browser.status`.** Observations remain authoritative in 0.4;
  consider a bounded per-session status summary when the session model expands.
- **Drag-and-drop**, **session recording / GIF**, and **PDF export** act kinds.
- **A sandboxed, read-only expression evaluator** — only if it can be designed without
  weakening the typed action floor (see "not planned").
- **Broader Chromium coverage** (Brave, Arc, other Chromium): test and document.

## Not planned

- **Firefox support.** No `chrome.debugger` equivalent, and out of scope by decision.
- **Arbitrary JavaScript execution** (`eval`-style tool). It would bypass the typed
  action floor that defines the product's safety model (DECISIONS §16).
- **Any telemetry, analytics, crash reporting, or remote service.** Newton Browser is
  local-only by design.

Feedback and focused feature requests: the repository issue tracker.
