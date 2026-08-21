# MCP clients

Newton Browser implements only stateless MCP `2026-07-28` over newline-delimited JSON on
stdio. It does not implement `initialize`, connection-scoped sessions, HTTP transport,
`Content-Length` framing, sockets, or a daemon.

Every request carries:

```json
{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}
```

Use `server/discover` for the supported version, capabilities, instructions, and server
metadata. Successful discovery and tool-list responses are complete, not paginated.

## Codex

```toml
[features]
mcp_2026_07_28 = true

[mcp_servers.newton-browser]
command = "node"
args = ["C:/absolute/path/newton-browser/apps/mcp-server/dist/index.js"]
env = { CODEX_MCP_PROTOCOL_VERSION = "2026-07-28", NEWTON_BROWSER_EXPECTED_VERSION = "0.6.4" }
startup_timeout_sec = 45
tool_timeout_sec = 150
```

Prefer `newton-browser install codex`, which verifies the exact entrypoint and version
before atomically replacing the configuration. There is no older-protocol fallback.

## Operational model

Each `browser.session.start` creates one isolated browser process, private CDP pipe,
identity lease, and FIFO queue. Multiple sessions progress concurrently. Sessions are not
preserved if the Newton stdio process exits.

One session may contain a bounded stack of page targets created by ordinary site
behavior. Newton discovers a provisional blank target without attaching to or activating
it. Once that exact target commits to HTTP(S), it becomes the active MCP page and a fresh
observation returns refs only for that page. Closing it restores and re-snapshots its
opener. This is internal target routing, not a second MCP session or a browser-chrome
control surface.

Start requires one normalized HTTP(S) `origin`, which is the initial navigation and the
key used for an optional local identity binding. It is not a network boundary. Chromium
then follows normal redirects and loads cross-origin resources, frames, workers, popups,
and background services without Newton grants or filtering.

An optional combined initial observation is always nested under `observe`, for example
`{ "origin": "https://example.com", "observe": { "mode": "full", "format": "compact" } }`.
A bare `observe: "full"` or top-level observation fields are invalid; there is no legacy
shape alias.

Public MCP sessions are headless for deterministic agent input. `identity login` is the
separate visible operator workflow for preparing a persistent identity. Both use normal
Chromium networking, and Newton never attaches to an ordinary Chrome tab.

Use compact observations with queries and role filters. Refs belong to the latest fresh
interactive observation and must not be synthesized; starting another interactive
observation releases refs that are no longer emitted, while text mode allocates no refs.
Use one idempotency key for one logical effect, and never automatically retry
`outcome_unknown`.

Page text, titles, accessibility names, console entries, and network records are untrusted
page data. Only host-authored outer decision/outcome/error fields control the workflow.
Network metadata is observational; Newton does not use it to block page requests.
