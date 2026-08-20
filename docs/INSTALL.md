# Installation

Newton Browser requires Node 24+, a current
local Chrome or Edge, and an MCP client that can start a stdio server. Direct mode needs
no extension, global package, daemon, hosted service, database, pairing secret, or debug
TCP port.

## Install the direct runtime

Version 0.6.3 is a private local candidate and is not published to npm. From this
checkout, build and run the exact compiled entrypoint:

```powershell
pnpm install --frozen-lockfile
pnpm build
```

The MCP server can immediately start ephemeral sessions using a discovered Chrome or
Edge installation. Optional setup selects a default (`--browser edge` for Edge), writes
only that browser preference. Persistent identity selection is a separate operator action.

```powershell
node apps/mcp-server/dist/index.js setup --browser chrome
```

Optional operator login:

```powershell
node apps/mcp-server/dist/index.js identity create --browser chrome
node apps/mcp-server/dist/index.js identity bind --id nbi_<opaque-id> --origin https://example.com
node apps/mcp-server/dist/index.js identity login --origin https://example.com
```

The operator enters credentials personally in the visible browser. Login uses ordinary
Chromium networking, including regional redirects and third-party resources; there is no
origin-grant configuration. Close the browser after login so Newton can confirm process
and lease cleanup.

`identity bind` creates a durable exact-primary-origin mapping. Later sessions for that
origin reuse the selected identity without relying on conversational memory; unrelated
origins remain ephemeral. Inspect mappings with `identity bindings` and remove one with
`identity unbind --origin https://example.com`. A bound identity is still exclusive and
must be unbound before deletion.

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

For Codex 0.147.0 or newer, a non-dry-run install is transactional: before changing
`config.toml`, Newton starts the exact candidate entrypoint with a fresh isolated Newton
configuration, completes stateless `server/discover` and `tools/list`, requires the
candidate's package version and all ten required `browser.*` tools, and confirms clean
exit. It then enables Codex's `mcp_2026_07_28` feature and pins both
`CODEX_MCP_PROTOCOL_VERSION=2026-07-28` and `NEWTON_BROWSER_EXPECTED_VERSION`. An
incompatible candidate leaves the existing working entry untouched, and Newton refuses
startup if an entrypoint and its configured version disagree. A higher version number
alone is never treated as an upgrade.

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

Use `artifacts/newton-browser-0.6.3.tgz` only after verifying it was produced by the
current tree, or use a verified release asset:

```powershell
$installRoot = Join-Path $env:LOCALAPPDATA "NewtonBrowser\package"
npm install --prefix $installRoot --ignore-scripts --no-audit --no-fund --offline "C:\absolute\path\newton-browser-0.6.3.tgz"
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

The optional `config.json` accepts only `browser`, `hostPolicies`, and `identityBindings`.
Host policies can
raise the structural commit boundary for exact origins and can add screenshot masks; they
cannot authorize an action or weaken the generic floor. For example:

```json
{
  "browser": "chrome",
  "identityBindings": [
    { "origin": "https://example.com", "identityId": "nbi_0123456789abcdef0123456789abcdef" }
  ],
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
Identity bindings are also operator-only, bounded, exact-origin mappings and never bypass
the identity lease. They select a profile; they do not restrict browser networking.

Continue with [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md).

This prerelease is not a general production-ready browser agent. Verify the exact target
site and workflow in the current session before consequential use; current-tree complete
release and real-site evidence are tracked in [`PROGRESS_LEDGER.md`](PROGRESS_LEDGER.md).
