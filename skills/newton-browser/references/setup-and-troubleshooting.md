# Setup and Troubleshooting

## First-time setup

1. Install the Newton Browser extension in the normal Chrome or Edge profile.
2. Add a version-pinned stdio host to the MCP client, for example:

   ```json
   { "command": "npx", "args": ["-y", "newton-browser@0.4.0"] }
   ```

   During source development, point the client at the built
   `apps/mcp-server/dist/index.js` instead.
3. Restart the MCP client.
4. Call `browser.status` and require `ready: true`. Default `local_trust` requires no
   pairing key or popup action.

Normal tasks do not manually start a host. Each configured MCP client starts its own
packed process; the extension discovers hosts on the bounded loopback range. If the user
explicitly enables `paired` mode, run `newton-browser --doctor` and enter its key in the
popup once.

Chrome and Edge can remain enabled together. The host atomically assigns a session to one
browser, and standbys receive no commands. Default `auto` needs no choice; set per-user
`browserTarget` or `NEWTON_BROWSER_BROWSER=chrome|edge` only when a specific browser is
required.

For `incognito: true`, the user must enable **Allow in incognito** under the extension's
browser details. Reload the extension and restart the MCP client after changing it.

## Common typed failures

| Code | Response |
| --- | --- |
| `pairing_required` | Hardened pairing is enabled; complete the one-time doctor/popup flow. |
| `authentication_failed` | Re-run doctor, verify the same OS-user profile, and re-pair deliberately. |
| `extension_disconnected` / `host_unavailable` | Confirm the extension and configured MCP host are enabled, restart the client if needed, then call status again. |
| `host_collision` | Inspect the bounded port range for unrelated listeners; do not kill a process without identifying it. |
| `origin_required` / `invalid_origin` | Supply one exact normalized HTTP(S) origin. |
| `origin_not_granted` | Reconcile the live tab URL and restart with an explicitly authorized origin grant. |
| `incognito_not_allowed` | Enable **Allow in incognito**, reload the extension, and restart the MCP client. |
| `queue_full` | Stop issuing work to that session until pending commands settle. |
| `result_too_large` | Use screenshot image/file delivery, JPEG/region capture, or a smaller bounded observation. |
| `command_timeout` | Inspect session status and current state; never blindly repeat a commit-shaped action. |
| `session_stopped` | Start a new session and re-establish page state. |
| `browser_not_selected` | Use the selected browser or change the explicit `browserTarget`. |
| `session_not_owned` | Another browser owns the session; do not retry from the standby. |
| `stale_target` / `target_moved` | Take a fresh observation and use a new ref. |
| `not_found` / `ambiguous` | Use a fresh exact ref or a narrower accessible target. |
| `blocked_by_floor` | Do not bypass the floor; have the user complete sensitive input when necessary. |
| `use_dialog_accept_or_dismiss` | Replace legacy `handle_dialog` with `dialog_accept` or `dialog_dismiss`. |
| `no_dialog_open` | Observe again; no dialog is waiting for a response. |
| `resize_needs_owned_tab` | Resize only an owned tab, never the user's current tab. |
| `fill_form_requires_fields` / `fill_form_field_incomplete` | Supply a non-empty ordered field list; inspect `fields` and `stoppedAt` before continuing. |
| `unknown_request_id` / `body_unavailable` | Re-list requests and use a fresh request id if the body is still available. |
| incompatible `versionSkew` | Relay status `nextAction` and update the older host or extension before continuing. |

## Process and tab cleanup

After each scenario, verify `browser.tabs.list` has no unintended sessions and finalize
every tab explicitly. One host's exit must affect only sessions stamped with that host
instance.
