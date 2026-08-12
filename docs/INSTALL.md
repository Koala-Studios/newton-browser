# Installation

Newton Browser requires Node 20+ to run the packed host, Node 24+ to develop, a current
local Chrome or Edge, and an MCP client that can start a stdio server. Direct mode needs
no extension, global package, daemon, hosted service, database, pairing secret, or debug
TCP port.

## Install the direct runtime

Version 0.4.5 is a private local candidate and is not published to npm. From this
checkout, build and run the exact compiled entrypoint:

```powershell
pnpm install --frozen-lockfile
pnpm build
node apps/mcp-server/dist/index.js setup --browser chrome
```

Use `--browser edge` for Edge. Setup creates an opaque persistent Newton identity and
writes direct-runtime configuration. To select an existing identity, add
`--identity nbi_<opaque-id>`.

Optional operator login:

```powershell
node apps/mcp-server/dist/index.js identity login nbi_<opaque-id> --origin https://example.com
```

The operator enters credentials personally in the visible contained browser. Add only
required exact redirect origins with repeated `--allow-origin`. Close the browser after
login so Newton can confirm process, proxy, and lease cleanup.

Optional live doctor:

```powershell
node apps/mcp-server/dist/index.js doctor --live
```

## Configure an MCP client

```json
{
  "command": "node",
  "args": ["C:\\absolute\\path\\newton-browser\\apps\\mcp-server\\dist\\index.js"]
}
```

Use an absolute executable/tarball path when testing a local artifact. Installer helpers:

```powershell
node apps/mcp-server/dist/index.js --install codex --dry-run
node apps/mcp-server/dist/index.js --install claude-code --dry-run
node apps/mcp-server/dist/index.js --install claude-desktop --dry-run
```

Review the dry run, apply deliberately, and restart the client. See
[`MCP_CLIENTS.md`](MCP_CLIENTS.md) for exact client shapes.

## Install from source

```powershell
git clone https://github.com/Koala-Studios/newton-browser.git
cd newton-browser
corepack enable
pnpm install --frozen-lockfile
pnpm build
node apps/mcp-server/dist/index.js setup --browser chrome
```

Point the MCP client at the absolute compiled entrypoint:

```json
{
  "command": "node",
  "args": ["C:\\absolute\\path\\newton-browser\\apps\\mcp-server\\dist\\index.js"]
}
```

Rebuild after source changes.

## Install from a tarball

Use `artifacts/newton-browser-0.4.5.tgz` only after verifying it was produced by the
current tree, or use a verified release asset:

```powershell
$env:NEWTON_BROWSER_PACKAGE_SPEC = "C:\absolute\path\newton-browser-0.4.5.tgz"
node apps/mcp-server/dist/index.js --print-config codex
```

The package contains the compiled MCP host and its browser guardian. Source maps are not
shipped. No browser-extension artifact is produced or installed.

## Verify startup

Restart the MCP client and call `browser.status`. Direct configured/idle status may have
`ready:false` before the first session; session start establishes browser readiness. A
new session should report `mode:"direct"`, own one browser process, and clean it on stop.

If status does not report direct configuration, run setup and restart the MCP
client. There is no extension fallback.

Configuration locations:

- Windows: `%LOCALAPPDATA%\NewtonBrowser`
- macOS: `~/Library/Application Support/NewtonBrowser`
- Linux: `${XDG_CONFIG_HOME:-~/.config}/newton-browser`

Continue with [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md).

This prerelease is not a general production-ready browser agent. Verify the exact target
site and workflow in the current session before consequential use; current-tree complete
release and real-site evidence are tracked in [`PROGRESS_LEDGER.md`](PROGRESS_LEDGER.md).
