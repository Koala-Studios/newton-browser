# Troubleshooting

- Tools absent or the client sends `initialize`: the client does not support Newton's
  modern-only MCP `2026-07-28` contract. Upgrade the client; Newton has no compatibility
  mode.
- Codex 0.147.0 or newer still uses the older MCP path when `features.mcp_2026_07_28`
  is disabled or the stdio server lacks `CODEX_MCP_PROTOCOL_VERSION=2026-07-28`. Run the
  exact Newton `install codex --force` command instead of editing only the entrypoint.
- `codex_mcp_candidate_incompatible`: the exact candidate did not complete Codex MCP
  stateless discovery, report its package version, expose every required browser tool,
  and exit cleanly under a fresh isolated configuration. The installer intentionally
  left the previous configuration untouched.
- `newton_browser_version_mismatch`: the configured expected version and launched package
  differ. Do not edit the version guard; reinstall the exact reviewed package.
- `protocol_version_required`: send protocol metadata on every request.
- MCP error `-32022`: send exactly `2026-07-28`; Newton does not negotiate down. Its
  `data` contains only the specification-defined `supported` and `requested` fields.
- Configured status is idle: expected before the first session. Runtime readiness belongs
  to an owned session process.
- `direct_runtime_unavailable`: stop any retained session and run `doctor --live`.
- `direct_cleanup_uncertain`: preserve the descriptor and retry `browser.session.stop`;
  do not start further effects until cleanup is confirmed.
- `configured_identity_busy`: another live host owns the selected persistent identity;
  close that owner, use another identity, or wait. Newton never steals a live lease.
- `configured_identity_recovery_unavailable`: a prior owner disappeared but Newton could
  not prove its exact browser tree and identity root are unused. Preserve the identity;
  inspect it with `identity lease-inspect` and use explicit `lease-recover` only after
  resolving the reported process ambiguity.
- `configured_identity_recovery_failed`: the stale lease failed exact validation or
  quarantine. Do not delete it manually; retain the identity and diagnose filesystem
  ownership.
- Bound identity is not reused: `identity bindings` must contain an exact match for the
  session's primary origin. Additional origins do not select a binding. The identity must
  still exist and be free; unbind it before deletion.
- Browser discovery failure: verify Node 24+ and a current Chrome or Edge regular
  executable. Use optional `setup --browser chrome|edge` to choose between installed
  families, then run `doctor --live`.
- Origin errors: the initial value must be one normalized HTTP(S) origin. After startup,
  Newton uses normal Chromium networking and does not require additional origins.
- Login button is inert or a site shows `ERR_BLOCKED_BY_CLIENT`: Newton 0.6.4 does not
  install a proxy or Fetch blocker. Confirm `browser.status` reports the expected version,
  close stale Newton/Chromium processes, and verify the configured entrypoint. Then test
  the same identity in `identity login`; browser/account/network policy outside Newton may
  still block the flow.
- Page CSS, icons, fonts, or layout look corrupted: first verify the exact 0.6.4 entrypoint
  is running. This release does not disable background networking, extensions, sync, or
  component updates and does not inject styles/scripts or freeze rendering. Capture a
  network log and screenshot; any Newton-originated `Fetch.failRequest`, proxy switch,
  `ERR_BLOCKED_BY_CLIENT`, raw icon ligature, or persistent script-disabled state is a bug.
- Session is active but no window is visible: expected for the deterministic headless
  `browser.session.start` runtime. Use operator-only `identity login` for personal
  sign-in; there is no current-tab attachment or handoff mode.
- `queue_full` or `session_limit`: let admitted work settle and stop unused sessions.
- `command_timeout`: retry only a confirmed `not_started` result. Observe before acting
  after `outcome_unknown`.
- A click followed by POST/GraphQL/telemetry is ordinary browser behavior, not a blocked
  action. After `dispatched_unverified` or `outcome_unknown`, keep the same session open,
  observe current state, and never restart login or repeat the action blindly.
- A site-owned popup or authentication tab does not require a coordinate click on the
  tab strip or Chrome's `Debugger paused in another tab` banner. Newton leaves its
  provisional blank target alone, then attaches and activates it after an HTTP(S) page
  commits. Re-observe with the same session; when the page
  closes, re-observe again and Newton returns to the opener. If a current release instead
  leaves the banner visible or reports the opener as `renderer_unresponsive`, preserve
  the session and report it as an owned-page routing defect—do not click browser chrome.
- Target errors: re-observe and use a fresh narrower ref. Every 0.6.4 interactive
  observation starts a new bounded ref cycle, so long-lived same-document apps recover
  without reload or navigation. Text observations allocate no refs. Never synthesize refs.
- `max_refs_exceeded` from 0.6.1 or earlier: do not retry an uncertain action, reload, or
  stop the session. Use bounded text observation and an unmasked screenshot only to verify
  current state, safely complete or preserve the work, then upgrade to 0.6.4. Replacing the
  private-pipe host necessarily closes its owned browser, so there is no honest hot swap.
- `dialog_blocked`: use typed dialog handling after obtaining effect authorization.
- Lifecycle errors such as `discarded`, `debugger_conflict`, `target_gone`, and
  `renderer_unresponsive` are distinct; do not flatten them into a generic timeout.
- `result_too_large`: narrow observations or request a JPEG, viewport crop, or region.
  Screenshots are MCP image content only; there is no inline/file delivery switch.
- Sensitive-zone screenshot failure: keep the policy and use a fresh ref or non-image
  evidence. Newton never returns an unmasked fallback.
- File-input errors: use exact operator-authorized non-symlink image/video paths. Newton
  validates files and never submits the form.
- Network body unavailable: only bounded current-visible-origin UTF-8 text is eligible.
  Cross-origin, binary, compressed, raw, and base64 bodies are intentionally omitted.

For diagnosis, request `browser.status` with `detail:"full"`, run ordinary `doctor` for
configuration, or `doctor --live` for one disposable owned-browser launch. Stop a session
with `browser.session.stop`; use `browser.stop_all` only for intentional global cleanup.
