# MCP clients

Every configured client starts an independent `newton-browser` process over stdio. Each process binds one free loopback port, so multiple clients can run concurrently without a shared daemon.

An orchestrator that deliberately needs session continuity across short-lived MCP
clients may start `newton-browser --daemon-socket /private/path/browser.sock` and
configure each sequential client with `newton-browser --connect-socket
/private/path/browser.sock`. This mode is Unix-only, accepts one MCP client at a
time, preserves the host's sessions between reconnects, and requires a private
caller-owned directory. Ordinary desktop clients should continue using stdio.

## Published package

Use the version-pinned public npm package for normal client configuration.

Codex:

```toml
[mcp_servers.newton-browser]
command = "npx"
args = ["-y", "newton-browser@0.4.1"]
startup_timeout_sec = 45
tool_timeout_sec = 150
```

Claude Desktop or Claude Code:

```json
{
  "mcpServers": {
    "newton-browser": {
      "command": "npx",
      "args": ["-y", "newton-browser@0.4.1"]
    }
  }
}
```

Generic stdio client:

```json
{
  "command": "npx",
  "args": ["-y", "newton-browser@0.4.1"]
}
```

## Source checkout

After `pnpm build`, point the client directly at the compiled entry point.

Codex:

```toml
[mcp_servers.newton-browser]
command = "node"
args = ["/absolute/path/to/newton-browser/apps/mcp-server/dist/index.js"]
startup_timeout_sec = 45
tool_timeout_sec = 150
```

Claude Desktop or Claude Code:

```json
{
  "mcpServers": {
    "newton-browser": {
      "command": "node",
      "args": ["/absolute/path/to/newton-browser/apps/mcp-server/dist/index.js"]
    }
  }
}
```

Generic stdio client:

```json
{
  "command": "node",
  "args": ["/absolute/path/to/newton-browser/apps/mcp-server/dist/index.js"]
}
```

Use an absolute path, restart the client after changing its configuration, and rebuild after pulling runtime changes.

## Release artifact

The files under `examples/mcp` contain the version-pinned tarball form used for release artifacts. Replace the example Windows tarball path with the absolute `.tgz` path on your machine.

The generated artifact config command is:

```text
newton-browser --print-config codex|claude-desktop|claude-code|generic
```

Set `NEWTON_BROWSER_PACKAGE_SPEC` to an absolute tarball path only when validating or installing a local release artifact. Without that override, generated configs use the published, version-pinned npm package.

## Client notes

- Codex desktop, CLI, and IDE surfaces share `~/.codex/config.toml`. Project `.codex/config.toml` should be used only for trusted projects.
- Claude Desktop and Claude Code use JSON `mcpServers` shapes. Claude Code can also manage an equivalent entry through its `claude mcp` commands.
- Generic clients must support local stdio MCP servers. MCP image-content support is required for primary screenshot delivery.
- Clients that cannot render image blocks should request `delivery:"file"` with an absolute output directory.
- Browser-only chat sessions cannot start a package installed on your local machine unless that product explicitly supports local MCP servers.

After configuration, start a new client session and call `browser.status` before opening
the first browser session. The default status is compact; request `detail: "full"` only
for setup diagnostics. To avoid a second round trip, pass
`observe: {format:"compact", roles:[...], limit:40}` to `browser.session.start`.
Subsequent `browser.observe` calls default to compact output without geometry; use
`query`, `roles`, and `limit` before increasing `maxNodes`, and reserve `format:"json"`
or `includeGeometry:true` for diagnostics. `includeInteractive:true` opts into bounded,
read-only DOM discovery for controls missing from the accessibility tree.
