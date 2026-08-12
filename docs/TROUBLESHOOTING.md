# Troubleshooting

- `browser.*` tools absent: verify the stdio configuration, package/absolute tarball path,
  Node 20+, and restart the MCP client. Run the configured command with `--version`.
- Status has no `mode:"direct"`: run `setup --browser chrome|edge`, verify the
  configured executable with `--doctor`, and restart the MCP client.
- Direct status is configured but `ready:false`: expected before the first session. Start
  one owned session; runtime readiness belongs to that session process.
- `direct_runtime_unavailable`: stop the exact session if retained and run
  `doctor --live`. Do not switch control planes or retry an effect blindly.
- `direct_cleanup_uncertain`: preserve the session descriptor and bounded error. Retry
  cleanup/stop; do not start new effects until process/proxy/lease cleanup is confirmed.
- `configured_identity_busy`: close the owning session/login, select another operator-
  created identity, or omit identity for public isolated work. Never break the lease file.
  If the owning process is known to have crashed, run `identity lease-inspect` and then
  the explicit `identity lease-recover --id ...`; recovery refuses any live recorded PID
  and also requires every process from that identity's browser family to be closed.
- `owned_browser_runtime_failed` or browser discovery failure: verify a current local Chrome
  or Edge regular executable, exact configured family, and live doctor result.
- `origin_required`, `invalid_origin`, or `origin_not_granted`: pass an exact normalized
  HTTP(S) origin, not a path, wildcard, credentialed URL, or page-provided suggestion.
- Missing third-party HTTPS assets: add only the exact required HTTPS origins. CONNECT
  exposes no resource type, so Newton intentionally does not infer passive CDN access.
- `queue_full` or `session_limit`: allow admitted work to settle and stop unused sessions.
- `command_timeout`: use the reported outcome. `not_started` may be retried deliberately;
  `outcome_unknown` must not be repeated automatically. Observe current state first.
- `stale_target`, `target_moved`, `not_found`, or `ambiguous`: re-observe after navigation/
  rerender and use a fresh narrower ref. Never synthesize or repair refs semantically.
- `dialog_blocked`: use the typed dialog accept/dismiss action after obtaining any required
  effect authorization, then re-observe.
- `discarded`, `debugger_conflict`, `target_gone`, or `renderer_unresponsive`: treat these
  as distinct lifecycle failures. Do not collapse them into a generic timeout.
- `result_too_large`: use a smaller queried/role-filtered observation or screenshot image/
  file delivery. Inline screenshots are deliberately bounded.
- screenshot with sensitive zones fails: target geometry or trusted raster masking could
  not be proven. Do not remove the policy or request an unmasked fallback; use a fresh
  observation, a narrower zone, or non-image evidence.
- file-input errors: use exact operator-authorized, non-symlink absolute image/video paths
  within the type/count/size caps and a fresh file-input ref. Newton never submits the form.
- network body unavailable: bodies are intentionally omitted unless granted-origin,
  supported, bounded UTF-8 text. There is no raw/base64 escape hatch.

For diagnostics, request `browser.status` with `detail:"full"`, run ordinary `--doctor`
for configuration, or run `doctor --live` for an explicit disposable launch.
Inspect only bounded host-authored codes and counts; do not log page/profile content.

For cleanup, use `browser.session.finalize({disposition:"close"})` or
`browser.session.stop`. Direct mode does not support deliverable/handoff/current-tab.
Use `browser.stop_all` only when global cleanup is intended, then confirm
`browser.sessions.list` is empty.
