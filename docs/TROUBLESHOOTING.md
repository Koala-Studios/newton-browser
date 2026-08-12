# Troubleshooting

- Tools absent or the client sends `initialize`: the client does not support Newton's
  modern-only MCP `2026-07-28` contract. Upgrade the client; Newton has no compatibility
  mode.
- `protocol_version_required`: send protocol metadata on every request.
- MCP error `-32022`: send exactly `2026-07-28`; Newton does not negotiate down. Its
  `data` contains only the specification-defined `supported` and `requested` fields.
- Configured status is idle: expected before the first session. Runtime readiness belongs
  to an owned session process.
- `direct_runtime_unavailable`: stop any retained session and run `doctor --live`.
- `direct_cleanup_uncertain`: preserve the descriptor and retry `browser.session.stop`;
  do not start further effects until cleanup is confirmed.
- `configured_identity_busy`: close the owning session or login. If the owner crashed,
  inspect and explicitly recover the lease; recovery refuses a live recorded process.
- Browser discovery failure: verify Node 24+ and a current Chrome or Edge regular
  executable. Use optional `setup --browser chrome|edge` to choose between installed
  families, then run `doctor --live`.
- Origin errors: pass exact normalized HTTP(S) origins. Add only required third-party
  origins; wildcards and page-provided suggestions are rejected.
- `queue_full` or `session_limit`: let admitted work settle and stop unused sessions.
- `command_timeout`: retry only a confirmed `not_started` result. Observe before acting
  after `outcome_unknown`.
- Target errors: re-observe and use a fresh narrower ref. Never synthesize refs.
- `dialog_blocked`: use typed dialog handling after obtaining effect authorization.
- Lifecycle errors such as `discarded`, `debugger_conflict`, `target_gone`, and
  `renderer_unresponsive` are distinct; do not flatten them into a generic timeout.
- `result_too_large`: narrow observations or request a JPEG, viewport crop, or region.
  Screenshots are MCP image content only; there is no inline/file delivery switch.
- Sensitive-zone screenshot failure: keep the policy and use a fresh ref or non-image
  evidence. Newton never returns an unmasked fallback.
- File-input errors: use exact operator-authorized non-symlink image/video paths. Newton
  validates files and never submits the form.
- Network body unavailable: only bounded granted-origin UTF-8 text is eligible. There is
  no raw or base64 escape hatch.

For diagnosis, request `browser.status` with `detail:"full"`, run ordinary `doctor` for
configuration, or `doctor --live` for one disposable owned-browser launch. Stop a session
with `browser.session.stop`; use `browser.stop_all` only for intentional global cleanup.
