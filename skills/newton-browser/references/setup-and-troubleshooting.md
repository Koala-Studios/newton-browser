# Setup and Troubleshooting

## First-time setup

1. Configure the direct runtime and create/select one opaque Newton identity:

   ```text
   newton-browser setup --browser chrome
   ```

   To use a previously created/imported identity, add `--identity <identity-id>`.
2. When authenticated state is needed, have the operator sign in inside the contained
   visible browser and close it afterward:

   ```text
   newton-browser identity login <identity-id> --origin https://example.com
   ```

   Add only required `--allow-origin` values for an authentication redirect.
3. Optionally run `newton-browser doctor --live` for an explicit disposable
   process/CDP/proxy/cleanup check.
4. Version 0.4.5 is not published to npm. Build the checkout and point the MCP client at
   its absolute compiled entrypoint:

   ```json
   { "command": "node", "args": ["C:\\absolute\\path\\newton-browser\\apps\\mcp-server\\dist\\index.js"] }
   ```

   Do not use unpinned `npx newton-browser`; npm currently resolves it to obsolete
   extension-era 0.4.1. Use `npx -y newton-browser@0.4.5` only after a separately
   approved 0.4.5 publication.
5. Restart the MCP client. A direct configured/idle status is expected before the first
   session; the first session starts the browser. No extension, pairing key, debug port,
   or manually started daemon is required.

Normal tasks do not manually start a host. Each configured MCP client starts its own
packed stdio process, and each session owns its browser process. Distinct identities can
run concurrently. A persistent identity is exclusive; a busy result must not be bypassed.

## Common typed failures

| Code | Response |
| --- | --- |
| `direct_runtime_unavailable` | Stop the exact session and run the explicit live doctor; never launch an unmanaged fallback browser. |
| `configured_identity_busy` | Close the owning session/login, choose another identity, or omit identity when authentication is unnecessary. |
| `profile_identity_lease_active` | The recorded owner still exists; never override or delete its lease. |
| `direct_cleanup_uncertain` | Do not retry browser effects. Preserve the bounded error and require operator cleanup/restart verification. |
| `origin_required` / `invalid_origin` | Supply one exact normalized HTTP(S) origin. |
| `origin_not_granted` | Reconcile the live tab URL and restart with an explicitly authorized origin grant. |
| `queue_full` | Stop issuing work to that session until pending commands settle. |
| `result_too_large` | Use screenshot image/file delivery, JPEG/region capture, or a smaller bounded observation. |
| `command_timeout` | Inspect session status and current state; never blindly repeat a commit-shaped action. |
| `session_stopped` | Start a new session and re-establish page state. |
| `stale_target` / `target_moved` | Take a fresh observation and use a new ref. |
| `not_found` / `ambiguous` | Use a fresh exact ref or a narrower accessible target. |
| `blocked_by_floor` | Do not bypass the floor; have the user complete sensitive input when necessary. |
| `use_dialog_accept_or_dismiss` | Replace legacy `handle_dialog` with `dialog_accept` or `dialog_dismiss`. |
| `no_dialog_open` | Observe again; no dialog is waiting for a response. |
| `resize_needs_owned_tab` | Treat this as a runtime invariant failure; direct sessions always own their browser. |
| `fill_form_requires_fields` / `fill_form_field_incomplete` | Supply a non-empty ordered field list; inspect `fields` and `stoppedAt` before continuing. |
| `unknown_request_id` / `body_unavailable` | Re-list requests and use a fresh request id if the body is still available. |

## Process and tab cleanup

After each scenario, verify `browser.sessions.list` has no unintended sessions and finalize
every session explicitly. Direct mode supports `close` only and confirms browser/proxy/
lease cleanup before stop succeeds. One host's exit must affect only its own sessions.
After a confirmed crash, an operator may run `identity lease-inspect --id <id>` followed
by `identity lease-recover --id <id>`. Recovery is explicit, refuses a live recorded
owner, and requires all processes from the identity's Chrome or Edge family to be closed;
agents must never edit lease files.

If a page is missing CDN/font/image resources, restart with only the exact required
origins in `allowedOrigins`. Newton never widens an origin grant based on resource type;
HTTPS CONNECT additionally prevents safe classification inside the tunnel.
