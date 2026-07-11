# Troubleshooting

- `browser.*` tools are absent: confirm the client config shape, absolute tarball path, Node 24+, and restart the client. Run the configured command with `--version` outside the client.
- `extension_disconnected`: load the unpacked extension in the same Chrome/Edge profile, open its popup once if the service worker is asleep, and call `browser.status` again.
- `pairing_required` or `authentication_failed`: hardened `paired` mode is enabled. Run `--doctor`, replace the extension popup secret, and restart the client. Never paste the secret into MCP arguments.
- `host_collision`: another 20 processes occupy the bounded port range. Stop stale Newton Browser clients and inspect `127.0.0.1:17321-17340`; do not widen the range casually.
- `--doctor` reports `no_running_host`: config and loopback checks succeeded, but no MCP client host is active. Start or restart the configured client, then call `browser.status`.
- `--doctor` reports `extension.state:"disconnected"`: load the extension in the intended profile. In default `local_trust`, no popup action is required; in optional `paired` mode, verify the pairing secret.
- `origin_required`, `invalid_origin`, or `origin_not_granted`: pass an exact HTTP(S) origin such as `https://example.com`, not a page URL, wildcard, credentialed URL, or path.
- `queue_full`, `command_timeout`, or `session_limit`: wait for the current command, stop unused sessions, and retry once after observing state.
- `result_too_large`: use screenshot `delivery:"image"` or `delivery:"file"`; inline delivery is deliberately bounded.
- `invalid_file_path`, `file_type_not_allowed`, `file_too_large`, or `file_total_too_large`: use exact non-symlink absolute paths to allowed image/video files within the documented caps.
- `hidden_file_input_requires_ref`: observe immediately before acting and pass the hidden input's fresh `ref`.
- pending JavaScript dialog: an open `alert`/`confirm`/`prompt`/`beforeunload` dialog blocks the page and is reported as `pendingDialog` on observations. Answer it with the `dialog_accept` (optionally `promptText`) or `dialog_dismiss` act kind. The legacy `handle_dialog` kind returns `use_dialog_accept_or_dismiss`.
- `blocked_by_floor`: inspect decision reasons. Sensitive-field blocks mean no keystrokes were sent. A post-action network-write block can occur after input dispatch; observe before retrying.
- stale or ambiguous target: re-observe after rerender/navigation and use the new ref. Never reuse a ref across a known SPA replacement.

For cleanup, finalize each deliverable or handoff tab deliberately, otherwise call `browser.session.stop`. Use `browser.stop_all` only when global cleanup is intended.
