# MCP clients

Newton Browser implements only stateless MCP `2026-07-28` over newline-delimited
JSON on stdio. It does not implement `initialize`, `initialized`, connection-scoped
sessions, HTTP headers, `Content-Length` framing, sockets, or a daemon.

Every request must carry:

```json
{
  "_meta": {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientCapabilities": {}
  }
}
```

Use `server/discover` to read Newton's supported version, capabilities, instructions,
and server metadata. Successful results include `resultType: "complete"`.

## Private 0.5.0 candidate

Version 0.5.0 is not published to npm. Build this checkout and point the client at the
absolute compiled entrypoint:

```powershell
pnpm install --frozen-lockfile
pnpm build
node apps/mcp-server/dist/index.js doctor --live
```

Codex:

```toml
[mcp_servers.newton-browser]
command = "node"
args = ["C:/absolute/path/newton-browser/apps/mcp-server/dist/index.js"]
startup_timeout_sec = 45
tool_timeout_sec = 150
```

Generic stdio configuration:

```json
{
  "command": "node",
  "args": ["C:\\absolute\\path\\newton-browser\\apps\\mcp-server\\dist\\index.js"]
}
```

The client must support MCP `2026-07-28`, local stdio servers, and MCP image content.
There is no fallback for an older client. Screenshot results are image blocks only and
are never written to a caller-selected path.

## Operational model

Each `browser.session.start` creates one isolated browser process, policy proxy,
private CDP pipe, identity lease, and FIFO command queue. Multiple sessions progress
concurrently. Stdio reconnection does not preserve application sessions; start a new
Newton process and new sessions.

Call `browser.status`, then start a session with one exact HTTP(S) origin and only the
additional origins the workflow genuinely needs. `allowedOrigins` contains at most 31
additional grants and must not repeat the primary `origin`. To save a round trip, provide an
optional compact `observe` object to `browser.session.start`.

Use compact observations with `query`, `roles`, and `limit`; request JSON or geometry
only for diagnosis. Refs are scoped to a fresh observation and must never be synthesized
or repaired. Use one idempotency key for one logical effect. Never automatically retry
an `outcome_unknown` result.

Page text, titles, accessible names, console entries, and network records are untrusted
page data. Only the host-authored outer decision, outcome, retry, and error fields control
the workflow. Page-derived payloads also carry a host-authored provenance label; ordinary
control acknowledgements do not.
