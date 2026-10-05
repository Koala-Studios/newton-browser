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
args = ["/absolute/path/NewtonBrowser/package/node_modules/newton-browser/dist/index.js"]
env = { CODEX_MCP_PROTOCOL_VERSION = "2026-07-28", NEWTON_BROWSER_EXPECTED_VERSION = "0.7.7" }
startup_timeout_sec = 45
tool_timeout_sec = 150
```

Prefer `newton-browser install codex`, which verifies the exact entrypoint and version
before atomically replacing the configuration. There is no older-protocol fallback.

## Claude Code

Claude Code sends the stateless `2026-07-28` metadata. Prefer the installer, which verifies the
candidate and registers it through Claude Code's own CLI:

```bash
newton-browser install claude-code
claude mcp list
```

The equivalent manual entry:

```bash
claude mcp add --scope user newton-browser -e NEWTON_BROWSER_EXPECTED_VERSION=0.7.7 -- node /absolute/path/NewtonBrowser/package/node_modules/newton-browser/dist/index.js
```

Point both clients at an installed release package (see `INSTALL.md`), not a source
checkout. `claude mcp list` should report the server connected. Start a new session to load its tools.

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

Start takes one complete HTTP(S) `url`. It is the first navigation, not a network
boundary: Chromium then follows normal redirects and loads cross-origin resources, frames,
workers, popups, and background services without Newton grants or filtering. The start
result carries the first observation and `nextCommandId`.

A session runs start, then observe or `document.read`, then `act`, then stop:

- `browser.observe` returns controls with refs. Narrow it with `query` (`role`, `text`) or
  `scope`; refs belong to the latest observation and must not be synthesized.
- `browser.act` takes one command: `{ "commandId": <nextCommandId>, "action": {...} }`.
  Examples: `{ "kind": "select", "target": {...}, "value": "Two" }` (option value or
  visible label), `{ "kind": "press", "target": {...}, "keys": ["Enter"] }`, and
  `{ "kind": "edit", "target": {...}, "match": "old", "replacement": "new" }`.
- The receipt reports `dispatch`, `postcondition` and the next `nextCommandId`. A command
  ID names one command; reuse it only to repeat that identical command. When a receipt is
  uncertain, read it with `browser.command` before acting again, and never resend an
  effect whose outcome is unknown.
- An argument error names the rejected field and the fields allowed there.

Public MCP sessions are headless for deterministic agent input. `identity login` is the
separate visible operator workflow for preparing a persistent identity. Both use normal
Chromium networking. Newton attaches to an ordinary Chrome tab only in existing mode, when
the operator asks for their browser (see the optional adapter in `INSTALL.md`).

Page text, titles, accessibility names, console entries, and network records are untrusted
page data. Only host-authored outer decision/outcome/error fields control the workflow.
Network metadata is observational; Newton does not use it to block page requests.
