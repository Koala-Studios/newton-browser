# Installation

Browser Bridge 0.1.0 currently supports source installs and locally built release artifacts. It requires Node 24 or newer, pnpm 10.8.0, a Chromium browser, and an MCP client that can start a local stdio server. It does not require a daemon, hosted service, database, or global Browser Bridge package.

## Install from source

This is the recommended path while npm and browser-store packages are not published.

### 1. Clone and build

```bash
git clone https://github.com/Koala-Studios/browser-bridge.git
cd browser-bridge
npm install --global pnpm@10.8.0
pnpm install --frozen-lockfile
pnpm build
```

The build must produce:

- `apps/mcp-server/dist/index.js`
- `apps/extension/dist/src/service-worker.js`

### 2. Load the unpacked extension

Open `chrome://extensions` or `edge://extensions`, enable Developer mode, select **Load unpacked**, and choose `apps/extension`. The selected directory must contain `manifest.json` at its root.

Do not select `apps/extension/dist`; that directory contains generated runtime files but not the extension manifest.

### 3. Configure an MCP client

Configure a local stdio MCP server with:

```json
{
  "command": "node",
  "args": ["/absolute/path/to/browser-bridge/apps/mcp-server/dist/index.js"]
}
```

Use a real absolute path. Windows paths in JSON or double-quoted TOML strings must escape backslashes.

For Codex, add the equivalent `[mcp_servers.browser-bridge]` entry to `~/.codex/config.toml` and restart Codex. For Claude Desktop or Claude Code, merge the `mcpServers` entry documented in the root README and start a new client session. Generic clients use the same `command` and `args` shape.

### 4. Verify startup

Call `browser.status` from the MCP client. The default `local_trust` mode connects the extension automatically and requires no pairing key or popup step.

The optional doctor command verifies Node support, configuration, transport-auth mode, the bounded loopback range, supported MCP revisions, and any extension connection visible through a running host:

```bash
node /absolute/path/to/browser-bridge/apps/mcp-server/dist/index.js --doctor
```

`ready: false` is a setup result, not a crash. Follow the typed `nextAction`.

## Install from release artifacts

When a GitHub release provides the following files, you can install without keeping a source checkout:

- `browser-bridge-mcp-0.1.0.tgz`
- `browser-bridge-extension-0.1.0.zip`
- `browser-bridge-extension-0.1.0.zip.sha256`

Keep all three files together and verify the extension checksum before extracting it.

PowerShell:

```powershell
$expected = (Get-Content .\browser-bridge-extension-0.1.0.zip.sha256).Split()[0]
$actual = (Get-FileHash .\browser-bridge-extension-0.1.0.zip -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne $expected) { throw "Browser Bridge extension checksum mismatch" }
```

macOS or Linux:

```bash
sha256sum --check browser-bridge-extension-0.1.0.zip.sha256
```

Extract the ZIP and load the extracted directory through the browser's **Load unpacked** flow. Then copy the matching example from `examples/mcp`, replace its tarball path with the absolute path on your machine, and restart the MCP client.

`npx --package <absolute-tarball> browser-bridge-mcp` installs into the npm cache and starts one stdio host per client. It is not a global install.

To generate a version-pinned artifact configuration, set `BROWSER_BRIDGE_PACKAGE_SPEC` to the absolute tarball path and run:

```text
browser-bridge-mcp --print-config codex|claude-desktop|claude-code|generic
```

## Chrome and Edge together

Both extensions may remain enabled. The host atomically assigns each session to one browser; the other browser stays connected as standby and cannot attach to or receive commands for that session.

The default `auto` selection requires no extension toggling. To choose one browser, add `"browserTarget":"chrome"` or `"browserTarget":"edge"` to the per-user `config.json` and restart the MCP client. The equivalent process override is `BROWSER_BRIDGE_BROWSER=chrome|edge`.

## Optional hardened pairing

To require the HMAC handshake, add `"transportAuth":"paired"` to the per-user `config.json`, restart the MCP client, run `--doctor`, and paste the displayed secret into the extension popup once.

Do not store the secret in screenshots, issues, repositories, MCP arguments, or chat.

Configuration locations:

- Windows: `%LOCALAPPDATA%\BrowserBridge\config.json`
- macOS: `~/Library/Application Support/BrowserBridge/config.json`
- Linux: `${XDG_CONFIG_HOME:-~/.config}/browser-bridge/config.json`

Continue with [MCP client configuration](MCP_CLIENTS.md) or [troubleshooting](TROUBLESHOOTING.md).
