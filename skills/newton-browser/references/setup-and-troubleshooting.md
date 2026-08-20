# Setup and troubleshooting

Ephemeral sessions work after the compiled MCP entrypoint is configured. Optional setup
records a default browser:

```text
newton-browser setup --browser chrome
```

## Exact CLI provenance

Use the `command` plus leading entrypoint from Codex's active
`[mcp_servers.newton-browser]` table for every setup, identity, doctor, or install
operation. Run that exact entrypoint with `--version` first and require `0.6.3`.

Never execute `apps/mcp-server/dist/index.js` from a repository or Codex worktree, a
global `newton-browser`, `npx`, or an older versioned package for live browser work. Do
not pass `--allow-origin`, `allowedOrigins`, or any retired network-grant option. If the
configured immutable entrypoint is missing or reports another version, repair the client
configuration before opening a browser.

For authentication, use that exact immutable CLI entrypoint to create/bind an identity
and let the operator sign in personally:

```text
newton-browser identity create --browser chrome
newton-browser identity bind --id <identity-id> --origin https://example.com
newton-browser identity login --origin https://example.com
```

The visible login browser and headless MCP sessions both use normal Chromium networking.
There are no origin grants or `--allow-origin` flags. Newton never attaches to ordinary
Chrome tabs. Run `newton-browser doctor --live` for a disposable process/CDP/cleanup check.

Important failures:

| Code | Response |
| --- | --- |
| `protocol_version_required` / MCP `-32022` | Send stateless MCP `2026-07-28` metadata on every request. |
| `direct_runtime_unavailable` | Stop the session and run the live doctor. |
| `configured_identity_busy` | Close the owner, use another identity, or omit it. |
| `direct_cleanup_uncertain` | Do not retry effects; retry exact cleanup. |
| `origin_required` / `invalid_origin` | Supply one normalized HTTP(S) initial origin. |
| `session_queue_full` | Let pending work settle. |
| `command_timeout` | Inspect state; do not blindly repeat a commit. |
| `stale_target` / `not_found` / `ambiguous` | Re-observe and use a fresh narrower ref. |
| `max_refs_exceeded` | On 0.6.3, make one fresh interactive observation; it starts a new bounded ref cycle without reload or navigation. On an older runtime, preserve the session and verify state with text/screenshot reads before upgrading. Never retry an uncertain effect. |
| `blocked_by_floor` | Let the user complete sensitive input. |

An action cannot be reported as `prevented` after input dispatch. Network requests,
dialogs, popups, downloads, and navigation observed after a click are normal browser
effects, not policy failures. Keep the same session open and re-observe before deciding
that authentication or an application authorization did not persist.

A popup or authentication tab is a session-owned page, not browser chrome. Newton 0.6.3
leaves its provisional blank target untouched, then attaches and activates the committed
HTTP(S) page automatically. Re-observe the same session to obtain fresh refs; when that
page closes, re-observe again to continue on the rebuilt opener. Never click the tab strip
or Chrome's debugger banner by coordinates.

If CSS, fonts, icons, or login redirects fail, confirm the exact Newton 0.6.3 entrypoint
and close stale older processes. Newton does not proxy traffic, intercept Fetch, disable
browser networking, inject styles/scripts, or freeze rendering. Any evidence that it does
is a product defect, not a missing grant.

The visible identity-login command completes when the operator closes its owned Chrome
window only after exact runtime and lease cleanup is confirmed. Stop each agent session
and confirm `browser.sessions.list` is empty. Lease recovery is an operator action and
refuses a live recorded browser process.
