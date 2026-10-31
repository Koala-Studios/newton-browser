# Troubleshooting

- Tools absent or the client sends `initialize`: the client does not support Newton's modern-only MCP `2026-07-28` contract. Upgrade the client; Newton has no compatibility mode.
- Codex 0.147.0 or newer still uses the older MCP path when `features.mcp_2026_07_28` is disabled or the stdio server lacks `CODEX_MCP_PROTOCOL_VERSION=2026-07-28`. Run `install codex --force` instead of editing only the entrypoint.
- `codex_mcp_candidate_incompatible`: the candidate did not complete stateless discovery, report its version, expose the browser tools and exit cleanly; the installer left the previous configuration untouched.
- `newton_browser_registration_stale` on stderr: the client registration was made with an older package than the one installed at its path. The server runs the installed package; `install claude-code --force` / `install codex --force` refreshes the registration. `newton_browser_version_mismatch` with a closed connection is the same situation on 0.7.23 or earlier, where the server refused to start: rerun both installs with `--force`.
- `protocol_version_required` / MCP `-32022`: send exactly `2026-07-28` metadata on every request.
- `configured_browser_unavailable` or `browser_launch_failed`: verify Node 24+ and a current Chrome or Edge; `setup --browser chrome|edge` chooses between installed families; `NEWTON_BROWSER_BROWSER_EXECUTABLE` names one exactly. Then run `doctor --live`. A launch failure reports its `phase`.
- `invalid_arguments`: the error names the `field` and what it `expected`; fix that field and resend with the same `nextCommandId`.
- `stale_target`, `target_moved`, `ambiguous`, `not_found`: observe again and use a fresh narrower ref. Never synthesize refs.
- `target_covered`: another element (the step's `coveredBy`, often a popup) covers the target. Dismiss it, then retry.
- A receipt that may have reached the page without a finished result: do not repeat it. Keep the session, observe, and check the site before acting again; `browser.command` gets or cancels a running command.
- `pageRestarted` on a receipt: the page hung and was reopened at its last address on the same sign-in. Observe before continuing.
- A popup or sign-in tab: it is a session page. `browser.pages.list` shows it and `browser.page.select` moves to it; never click browser chrome by coordinates.
- A session is active but no window is visible: sessions are headless. Operator sign-in is `source login`, which opens a visible window.
- A stuck saved sign-in (`maintenance.lock` or `publication.lock` in the login source): with no sign-in in progress, `source recover --id <name> --browser <family>` releases only a lock whose owner is gone. `source collect` removes retired generations no session is copying.
- Screenshot or body unavailable: screenshots never fall back to an unmasked image; network bodies are only bounded text from the page's own origin.

For diagnosis run `doctor` for configuration or `doctor --live` for one disposable session.
