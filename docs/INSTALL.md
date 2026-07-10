# Installation

Browser Bridge 0.1.0 is a private artifact release. It requires Node 24 or newer, a Chromium browser, the MCP tarball, and the extension ZIP. It does not require a source checkout, global npm install, daemon, or service.

## 1. Verify artifacts

Copy these files to `C:\BrowserBridge`:

- `browser-bridge-mcp-0.1.0.tgz`
- `browser-bridge-extension-0.1.0.zip`
- `browser-bridge-extension-0.1.0.zip.sha256`

Verify the extension archive:

```powershell
$expected = (Get-Content C:\BrowserBridge\browser-bridge-extension-0.1.0.zip.sha256).Split()[0]
$actual = (Get-FileHash C:\BrowserBridge\browser-bridge-extension-0.1.0.zip -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne $expected) { throw "Browser Bridge extension checksum mismatch" }
```

Extract the ZIP to `C:\BrowserBridge\extension`. In Chrome or Edge, open the extensions page, enable Developer mode, choose Load unpacked, and select that directory. The selected directory must contain `manifest.json` at its root.

## 2. Configure one client

Copy the matching version-pinned example from `examples/mcp`, keeping the absolute tarball path correct for that machine. `npx --package <absolute-tarball> browser-bridge-mcp` installs only into the npm cache and auto-starts one stdio host per client; it is not a global install.

For Codex, merge `examples/mcp/codex.toml` into `~/.codex/config.toml` and restart Codex. Official Codex guidance stores MCP configuration there and defines local stdio servers with `command` and `args`.

For Claude Desktop, merge the `mcpServers` object into its desktop configuration and restart the app. For Claude Code, add the server from `examples/mcp/claude-code.json` at user or project scope and start a new session. Generic clients use `examples/mcp/generic.json`.

## 3. Start—no pairing required

Start or restart the client and call `browser.status`. The default `local_trust` mode connects the extension automatically; there is no pairing key or extension-popup step.

The optional doctor command verifies Node support, host-policy configuration, transport-auth mode, the bounded loopback range, supported MCP revisions, and any extension connection visible through a running host:

```powershell
npx --yes --package C:\BrowserBridge\browser-bridge-mcp-0.1.0.tgz browser-bridge-mcp --doctor
```

`ready:false` is a setup result, not a crash; follow its typed `nextAction`.

Then start an exact-origin session. No separate host command or extension-panel click is part of normal startup.

### Optional hardened pairing

To require the key handshake, create `%LOCALAPPDATA%\BrowserBridge\config.json` containing `{"transportAuth":"paired"}` (merge this field with any existing `hostPolicies`). Restart the MCP client, run `--doctor`, and paste the displayed secret into the extension popup once. Do not store the secret in screenshots, tickets, repositories, or chat.
