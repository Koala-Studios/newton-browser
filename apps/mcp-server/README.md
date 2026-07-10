# Browser Bridge Host

Local MCP host for the standalone Browser Bridge extension.

## Run

```powershell
browser-bridge-mcp
```

The host listens on `127.0.0.1:17321`, exposes an MCP server over stdio, and relays commands to the loaded unpacked Browser Bridge extension over localhost WebSocket. It has no database and no platform dependency.

## Extension Pairing

1. Build the extension runtime:

   ```powershell
   pnpm extension:build
   ```

2. Load unpacked from:

   ```text
   apps/extension
   ```

3. Start this host process. The extension discovers the localhost host in the background; the popup only shows connected/disconnected status.

## MCP Tools

The stdio server exposes the `browser.*` tools documented in the canonical skill.

## MCP Client Config

Use the host as a stdio MCP server. Keep normal network access disabled for the calling agent when you want local-only operation; the extension and host only need localhost.

```json
{
  "mcpServers": {
    "browser-bridge": {
      "command": "browser-bridge-mcp"
    }
  }
}
```

Use the packed, version-pinned executable in real client configuration. Development can run the compiled `apps/mcp-server/dist/index.js` after `pnpm build`.

## Privacy Boundary

The host and extension run on the user's machine. Browser control traffic stays on localhost. Page observations and screenshots only leave the machine if the calling agent sends them to its model provider.

## Safety

The host runs the Browser Bridge safety floor before relaying mutating actions. Blocked actions return a blocked result. Commit-like actions are relayed without a human approval prompt; Browser Bridge is a local hands-and-eyes tool for the worker, not a moderation layer.
