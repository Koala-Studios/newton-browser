# Installation

Newton Browser requires Node 24+, a current
local Chrome or Edge, and an MCP client that can start a stdio server. Direct mode needs
no extension, global package, daemon, hosted service, database, pairing secret, or debug
TCP port.

## Install the direct runtime

This checkout contains version 0.6.4. Local build instructions below do not establish
current npm/publication or installed-client state. The development task records a prior
0.6.4 release/install; verify the exact installed entrypoint when diagnosing a client.
For source testing, build and run the exact compiled entrypoint:

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

Use `artifacts/newton-browser-0.6.4.tgz` only after verifying it was produced by the
current tree, or use a verified release asset:

```powershell
$installRoot = Join-Path $env:LOCALAPPDATA "NewtonBrowser\package"
npm install --prefix $installRoot --ignore-scripts --no-audit --no-fund --offline "C:\absolute\path\newton-browser-0.6.4.tgz"
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
# Optional adapter candidate (2026-09-08)

The current development package includes `dist/tab-adapter/{manifest.json,worker.js,setup.html}`.
Normal package installation and standalone browsing do not register or require it.

```powershell
newton-browser adapter prepare
newton-browser adapter setup
newton-browser adapter status
```

`prepare` copies the packaged worker unchanged into the Newton configuration directory
and establishes a stable unpacked extension ID. Repeating it preserves the ID and code;
it does not silently update an existing installation. `setup` additionally registers
the Windows Chrome native host. First setup currently requires Node 25.5 or newer to
build the stable native launcher. Chrome's one-time Developer mode / Load unpacked
installation uses the directory returned by the command. Newton adds no approval prompts.

`status` probes live native connections and reports `ready` only when a compatible
browser responds. MCP existing-browser discovery uses the installed connection directory;
manual advertisement-file configuration is optional. Multiple live profiles have separate
connection and instance IDs. Explicit existing-browser requests must select the intended
connection; standalone remains the default.

To create a separate background tab after the operator requests their browser, use
the connection and instance IDs from discovery:

```json
{
  "mode": "existing",
  "connectionId": "<discovered connection ID>",
  "target": {
    "kind": "new_tab",
    "instanceId": "<discovered instance ID>",
    "url": "https://example.com/"
  }
}
```

Pass this to `browser.session.start`. It creates an inactive blank tab, establishes
debugger ownership, and navigates through the shared engine. Invalid URLs fail before
creation. Claiming an existing `kind: "tab"` still leaves its current location intact.
Stopping a successfully started borrowed session releases claims and preserves its tabs.

Borrowed popups inherit the worker that owns the actual source tab. They appear in
`browser.pages.list` with their opener; opening a popup does not change the selected
page. Action observations also include `newPages` for owned pages first observed during
that command, so the next action can use their `pageId` without a listing round trip.
`newPagesIncomplete` flags bounded/truncated feedback; use the page list for more detail.
Popups that appear later are discovered on subsequent reads, without waiting for an
arbitrary period of browser quietness. The extension uses Chrome's navigation-target source event, requiring the
`webNavigation` permission in the initial manifest. Earlier development candidates
without that permission cannot receive this change through a worker.js-only update;
the installed manifest and permissions are never silently rewritten.

Worker code updates retain the installed manifest, permissions and extension ID:

```powershell
newton-browser adapter update --connection CONNECTION_ID --instance INSTANCE_EPOCH --tab TAB_ID
newton-browser adapter recover --connection CONNECTION_ID --instance INSTANCE_EPOCH --tab TAB_ID
```

Use IDs from `adapter status` for the explicitly selected browser and a normal HTTP(S)
tab available for a fresh debugger claim and read-only DOM smoke check. `update` uses
the current package's adapter code; `--from DIRECTORY` selects a staged build with an
otherwise identical manifest. The package manifest may omit the installation-specific
key. This command updates `worker.js` only; it cannot change permissions or setup assets.

An installation-wide lock excludes concurrent updates across profiles. A durable journal
retains the ticket and both code versions before publication. Metadata commits only after
the expected bootstrap and smoke check; failures attempt verified rollback. `status`
reports `updating` while ownership is held and `recovery_required` for unfinished work.
Recovery after publication requires the original browser's update marker; selecting a
different profile cannot establish that proof. Already committed recovery only retries
marker cleanup, with no reload or smoke replay. `cleanupPending` means commit succeeded
but marker cleanup could not be confirmed.

The public update/recovery paths pass packed Windows Chromium QA
(`astra-native-update-v30.log` and `astra-native-recovery-v30.log`), including forced
rollback and recovery after both bootstrap checks fail. Wrong-profile recovery leaves
the journal unchanged; the original profile restores verified code and ready status.
`astra-native-kill-v30.log` additionally kills an actual disposable updater after code
publication and verifies lock release and public recovery without updater cleanup.
This is an implementation candidate, not release acceptance. Unsealed-build
migration, Linux launcher support and final development versus production artifact
separation remain unfinished.
