# Setup and Troubleshooting

## Setup

1. After configuring the compiled MCP entrypoint, ephemeral sessions work without a
   setup command. Optional setup records only a default browser:

   ```text
   newton-browser setup --browser chrome
   ```

2. When authentication is needed, create an identity explicitly, then have the operator
   sign in inside the visible owned browser and close it:

   ```text
   newton-browser identity create --browser chrome
   newton-browser identity login <identity-id> --origin https://example.com
   ```

   Add only exact redirect origins with `--allow-origin`.
3. Run `newton-browser doctor --live` for an explicit disposable
   process/CDP/proxy/cleanup check.
4. Until an approved npm publication, build the checkout and configure the MCP client
   with the absolute compiled `apps/mcp-server/dist/index.js`. Do not install an older
   extension-era npm version.
5. Restart the client. No extension, pairing key, debug port, or daemon is required.

Each MCP client starts one stateless stdio host. Each browser session owns an isolated
browser process and identity. A persistent identity is exclusive.

Operator `config.json` may contain only `browser` and `hostPolicies`. Host policies can
raise commit classification for an exact origin and add screenshot masks, but never
authorize work or lower the generic floor. See `docs/INSTALL.md` in the Newton Browser
repository for the strict shape.

## Typed failures

| Code | Response |
| --- | --- |
| `protocol_version_required` | Send protocol metadata on every request. |
| MCP error `-32022` | Configure a client that sends MCP `2026-07-28`; Newton does not negotiate down. |
| `client_capabilities_required` | Fix per-request `_meta`; do not add a handshake. |
| `direct_runtime_unavailable` | Stop the exact session and run the live doctor. |
| `configured_identity_busy` | Close the owner, choose another identity, or omit it. |
| `profile_identity_lease_active` | Never override or delete the lease. |
| `direct_cleanup_uncertain` | Do not retry effects; preserve the error and verify cleanup. |
| `origin_required` / `invalid_origin` | Supply one exact normalized HTTP(S) origin. |
| `origin_not_granted` | Restart with an explicitly authorized exact origin. |
| `session_queue_full` | Stop issuing work until pending commands settle. |
| `result_too_large` | Use JPEG/region, a smaller viewport, or a smaller observation. |
| `command_timeout` | Inspect current state; never blindly repeat a commit-shaped action. |
| `session_stopping` | Wait for cleanup or start a new session after it completes. |
| `stale_target` / `not_found` / `ambiguous` | Re-observe and use a fresh narrower ref. |
| `blocked_by_floor` | Do not bypass the floor; let the user complete sensitive input. |
| `no_dialog_open` | Observe again; no dialog is awaiting a response. |
| `fill_form_requires_fields` | Supply a non-empty ordered flat field list. |
| `unknown_request_id` / `body_unavailable` | Re-list network requests and use a fresh id. |

## Cleanup

Stop every session explicitly and confirm `browser.sessions.list` is empty. Stop succeeds
only after browser/proxy/lease cleanup is confirmed. After a confirmed crash, an operator
may use `identity lease-inspect` then `identity lease-recover`; recovery requires all
processes from that browser family to be closed. Never edit a lease file manually.

If a page lacks a required third-party resource, restart with only that exact origin in
`allowedOrigins`. This array contains additional origins only; never repeat the primary
`origin`. Resource type never widens the grant.
