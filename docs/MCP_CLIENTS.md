# MCP Clients

All clients start the same `browser-bridge-mcp` 0.1.0 tarball over stdio. Each process independently binds one free loopback port, so Codex and Claude Code can run concurrently without a shared daemon. Use the files under `examples/mcp`; replace only the absolute artifact path.

Codex uses TOML under `[mcp_servers.browser-bridge]`. The Codex desktop app, CLI, and IDE extension share `~/.codex/config.toml`; project `.codex/config.toml` is supported only for trusted projects. Restart the client after changing MCP configuration.

Claude Desktop and Claude Code use JSON `mcpServers` shapes. Claude Code may also manage the equivalent entry through its `claude mcp` commands. A new client session is required after changing the configuration.

Generic clients must support local stdio MCP servers and MCP image content blocks to use primary screenshot delivery. Clients that cannot render image blocks should request `delivery:"file"` with an absolute directory. Browser-only ChatGPT sessions do not read local Codex configuration and therefore cannot start this local package.

The generated config command is:

```text
browser-bridge-mcp --print-config codex|claude-desktop|claude-code|generic
```

Set `BROWSER_BRIDGE_PACKAGE_SPEC` to the absolute private tarball before generating a private-artifact config. Without it, output names the future version-pinned registry package; that form is not usable until publication is separately approved.
