# Setup and troubleshooting

Sessions work once the compiled MCP entrypoint is configured. Optional setup records a default browser:

```text
newton-browser setup --browser chrome
newton-browser doctor --live
```

`doctor --live` starts one session on a loopback page in a throwaway store, observes it and proves cleanup.

Sign-in for later sessions is an operator step:

```text
newton-browser source login --id default --browser chrome
```

The operator signs in personally in the visible window and confirms in the terminal; closing the window cancels. Running sessions keep their copies; new sessions open signed in.

| Code | Response |
| --- | --- |
| `protocol_version_required` / MCP `-32022` | Send stateless MCP `2026-07-28` metadata on every request. |
| `invalid_arguments` | Fix the named `field`; resend with the same `nextCommandId`. |
| `stale_target` / `target_moved` / `ambiguous` / `not_found` | Observe again and use a fresh narrower ref. |
| `browser_launch_failed` | Retry once, then report its `phase`; run `doctor --live`. |
| `configured_browser_unavailable` | Install Chrome or Edge, or set `NEWTON_BROWSER_BROWSER_EXECUTABLE`. |
| `unsupported_capability` | The page or mode does not support that read or action. |

A popup or sign-in tab is a session page: `browser.pages.list` shows it and `browser.page.select` moves to it. Never click browser chrome by coordinates.
