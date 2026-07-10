# Setup and Troubleshooting

## First-time setup

1. Load the unpacked or release extension in the normal Chrome or Edge profile.
2. Add the version-pinned `newton-browser` stdio entry to the MCP client.
3. Restart the client.
4. Call `browser.status` and confirm `ready: true`. Default `local_trust` needs no pairing key or popup action.

Normal tasks do not manually start a host. Every configured MCP client starts its own packed process; the extension discovers hosts on the bounded loopback range. If the user explicitly enables `paired` mode, run `newton-browser --doctor` and enter its key in the popup once.

Chrome and Edge can remain enabled together. The host atomically assigns a session to one browser, and standbys receive no commands. Default `auto` mode needs no choice; set per-user `browserTarget` or `NEWTON_BROWSER_BROWSER=chrome|edge` only when a specific browser is required.

## Common typed failures

| Code | Response |
| --- | --- |
| `pairing_required` | Hardened pairing is enabled; complete the one-time doctor/popup flow. |
| `authentication_failed` | Re-run doctor, verify the same OS-user profile, and re-pair deliberately. |
| `extension_disconnected` | Confirm the extension is enabled in the browser profile and call status again. |
| `host_collision` | Inspect the bounded port range for unrelated listeners; do not kill a process without identifying it. |
| `origin_required` / `invalid_origin` | Supply an exact normalized HTTP(S) origin. |
| `origin_not_granted` | Reconcile the live tab URL and restart with an explicitly authorized origin grant. |
| `queue_full` | Stop issuing work to that session until pending commands settle. |
| `result_too_large` | Use screenshot image or file delivery as recommended by the result. |
| `command_timeout` | Inspect session status and current state; never blindly repeat a commit-shaped action. |
| `session_stopped` | Start a new session and re-establish page state. |
| `browser_not_selected` | The host targets another browser; use that browser or change the explicit `browserTarget`. |
| `session_not_owned` | Another browser owns the session; do not retry the operation from the standby. |
| `stale_target` / `target_moved` | Take a fresh observation and use a new ref. |
| `ambiguous` | Use a fresh exact ref or narrower accessible target. |
| `blocked_by_floor` | Do not bypass the floor; have the user complete sensitive input when necessary. |

## Process and tab cleanup

After each scenario, verify `browser.tabs.list` has no unintended sessions, finalize every tab explicitly, and confirm no orphan `newton-browser` process remains. One host's exit must affect only sessions stamped with that host instance.
