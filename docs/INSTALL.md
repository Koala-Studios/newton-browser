# Installation

Newton Browser requires Node 24+, a current
local Chrome or Edge, and an MCP client that can start a stdio server. Direct mode needs
no extension, global package, daemon, hosted service, database, pairing secret, or debug
TCP port.

## Install the direct runtime

Version 0.5.0 is a private local candidate and is not published to npm. From this
checkout, build and run the exact compiled entrypoint:

```powershell
pnpm install --frozen-lockfile
pnpm build
```

The MCP server can immediately start ephemeral sessions using a discovered Chrome or
Edge installation. Optional setup selects a default (`--browser edge` for Edge), writes
only that browser preference, and never selects an identity implicitly.

```powershell
node apps/mcp-server/dist/index.js setup --browser chrome
```

Optional operator login:

```powershell
node apps/mcp-server/dist/index.js identity create --browser chrome
node apps/mcp-server/dist/index.js identity login nbi_<opaque-id> --origin https://example.com
```

The operator enters credentials personally in the visible contained browser. Add only
required exact redirect origins with repeated `--allow-origin`; never repeat the primary
`--origin`. Close the browser after
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
node apps/mcp-server/dist/index.js install codex --dry-run
node apps/mcp-server/dist/index.js install generic
```

Review the dry run, apply deliberately, and restart the client. Clients that do not
support stateless MCP `2026-07-28` cannot use this release. See
[`MCP_CLIENTS.md`](MCP_CLIENTS.md) for exact client shapes.

## Install from source

```powershell
git clone https://github.com/Koala-Studios/newton-browser.git
cd newton-browser
corepack enable
pnpm install --frozen-lockfile
pnpm build
node apps/mcp-server/dist/index.js doctor --live
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

Use `artifacts/newton-browser-0.5.0.tgz` only after verifying it was produced by the
current tree, or use a verified release asset:

```powershell
$installRoot = Join-Path $env:LOCALAPPDATA "NewtonBrowser\package"
npm install --prefix $installRoot --ignore-scripts --no-audit --no-fund --offline "C:\absolute\path\newton-browser-0.5.0.tgz"
node "$installRoot\node_modules\newton-browser\dist\index.js" install codex --dry-run
```

The installer pins that exact local entrypoint and the current Node executable. It does
not invoke `npx`, consult npm, or resolve a package version when the MCP client starts.

The package contains the compiled MCP host and its browser guardian. Source maps are not
shipped. No browser-extension artifact is produced or installed.

## Verify startup

Restart the MCP client and call `browser.status`. Direct configured/idle status reports
`ready:true` with `runtimeState:"idle"`; session start creates the browser process. A
new session should report `mode:"direct"`, own one browser process, and clean it on stop.

If browser discovery fails, optionally run setup to select Chrome or Edge, then restart
the MCP client. There is no extension fallback.

Configuration locations:

- Windows: `%LOCALAPPDATA%\NewtonBrowser`
- macOS: `~/Library/Application Support/NewtonBrowser`
- Linux: `${XDG_CONFIG_HOME:-~/.config}/newton-browser`

The optional `config.json` accepts only `browser` and `hostPolicies`. Host policies can
raise the structural commit boundary for exact origins and can add screenshot masks; they
cannot authorize an action or weaken the generic floor. For example:

```json
{
  "browser": "chrome",
  "hostPolicies": [
    {
      "origins": ["https://example.com"],
      "commitRules": [
        { "match": { "name": "Publish" }, "effect": "external_effect", "reason": "publishes_content" }
      ],
      "sensitiveZones": [{ "selector": "[data-private-panel]" }]
    }
  ]
}
```

Origins must be exact HTTP(S) origins. Commit rules and sensitive zones are bounded,
strictly validated local operator configuration; page content cannot create them.

Continue with [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md).

This prerelease is not a general production-ready browser agent. Verify the exact target
site and workflow in the current session before consequential use; current-tree complete
release and real-site evidence are tracked in [`PROGRESS_LEDGER.md`](PROGRESS_LEDGER.md).
