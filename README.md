# Newton Browser

Local browser control for MCP clients using your existing Chrome or Edge profile.

[![CI](https://github.com/Koala-Studios/newton-browser/actions/workflows/ci.yml/badge.svg)](https://github.com/Koala-Studios/newton-browser/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/newton-browser.svg)](https://www.npmjs.com/package/newton-browser)
[![MCP Registry](https://img.shields.io/badge/MCP_Registry-0.4.2-blue)](https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.Koala-Studios%2Fnewton-browser)
[![Chrome Web Store](https://img.shields.io/chrome-web-store/v/hjhanngbpeafifandahdemfcalfniijn?label=Chrome%20Web%20Store)](https://chromewebstore.google.com/detail/newton-browser/hjhanngbpeafifandahdemfcalfniijn)
[![GitHub Release](https://img.shields.io/github/v/release/Koala-Studios/newton-browser)](https://github.com/Koala-Studios/newton-browser/releases/tag/v0.4.1)

Newton Browser connects an MCP client such as Codex or Claude to a local Chromium extension. It can open isolated tabs, observe pages, take screenshots, interact with accessible controls, and hand completed tabs back to you—all without a hosted service, required system daemon, database, telemetry pipeline, or cloud relay.

## Purpose

Newton Browser was created to give agents a browser-control tool that is **agent-agnostic and harness-agnostic**. It uses the open MCP interface instead of depending on proprietary browser-control code or product-specific implementations such as Claude's or Codex's Chrome control tools. The same local extension and MCP host can therefore work across compatible clients, agent frameworks, and model providers without locking browser automation to one vendor's stack.

> [!IMPORTANT]
> Newton Browser 0.4.2 is an early public preview. The MCP package is public on npm, the release artifacts are available on GitHub, and the [Chrome Web Store listing](https://chromewebstore.google.com/detail/newton-browser/hjhanngbpeafifandahdemfcalfniijn) is live. The former Chrome-review gate on Edge Add-ons is cleared; the Edge listing has not yet been submitted.

## Why Newton Browser?

- **Use your real browser profile.** Work with the sessions you are already signed into instead of a separate automation profile.
- **Use incognito when privacy matters.** Owned sessions can open in an incognito
  window so public-site QA and screenshots do not inherit profile logins or storage.
- **Keep control traffic local.** The MCP host communicates over stdio, and the extension relay binds only to `127.0.0.1`.
- **Scope every session.** Each session requires one exact HTTP(S) origin plus any explicitly allowed origins.
- **Keep tabs isolated.** Owned tabs are the default; current-tab control must be requested explicitly.
- **Make browser ownership deterministic.** Chrome and Edge can remain enabled together while only one browser owns a session.
- **Apply a safety floor.** Credentials, payment data, one-time codes, government identifiers, and cross-origin targets are blocked before dispatch.
- **See what happened.** Observations, screenshots, typed action results, and explicit tab finalization make browser work inspectable.

## How it works

```text
MCP client
    ↕ stdio
newton-browser
    ↕ WebSocket on 127.0.0.1:17321-17340
Newton Browser MV3 extension
    ↕ Chrome DevTools Protocol
Owned tab or explicitly selected current tab
```

The MCP client starts its own host process. The extension discovers local hosts in the bounded loopback range, and each browser session is bound to the host, tab, and exact origin that created it.

## Requirements

- Node.js 20 or newer to run the host; Node.js 24 or newer to develop the repository
- Google Chrome or Microsoft Edge with Developer mode available
- An MCP client that supports local stdio servers

Source development additionally requires Node.js 24 or newer, pnpm 10.8.0, and Git. The project is designed to work on Windows, macOS, and Linux. The current release evidence is strongest on Windows with Chrome and Edge.

## Quick start

### 1. Get the extension

Chrome users can install Newton Browser directly from the [Chrome Web Store](https://chromewebstore.google.com/detail/newton-browser/hjhanngbpeafifandahdemfcalfniijn).

For a manual install, Edge, or the exact 0.4.1 package, download `newton-browser-extension-0.4.1.zip` from the [v0.4.1 GitHub Release](https://github.com/Koala-Studios/newton-browser/releases/tag/v0.4.1) and extract it to a permanent local directory.

Contributors can instead build the same extension from source:

```bash
git clone https://github.com/Koala-Studios/newton-browser.git
cd newton-browser
npm install --global pnpm@10.8.0
pnpm install --frozen-lockfile
pnpm build
```

`pnpm build` compiles the shared packages and MCP host, then writes the extension runtime under `apps/extension/dist`.

### 2. Install or load the extension

If you installed from the Chrome Web Store, continue to step 3. For a manual installation:

In Chrome:

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Select **Load unpacked**.
4. Choose the extracted release directory, or the repository's `apps/extension` directory for a source build.

In Edge, use `edge://extensions` and follow the same steps. The selected directory must contain `manifest.json`; do not select the generated `dist` directory itself.

The default `local_trust` mode requires no pairing key or popup action.

### 3. Configure your MCP client

Use the published host through npx:

```text
npx -y newton-browser@0.4.1
```

#### Codex

Add this to `~/.codex/config.toml`:

```toml
[mcp_servers.newton-browser]
command = "npx"
args = ["-y", "newton-browser@0.4.1"]
startup_timeout_sec = 45
tool_timeout_sec = 150
```

Restart Codex after changing the configuration.

#### Claude Desktop or Claude Code

Merge this server into the client's MCP configuration:

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

Start a new client session after changing the configuration. Other MCP clients can use the same `command` and `args` as a local stdio server.

### 4. Verify the connection

Ask your MCP client to call:

```text
browser.status
```

A working setup reports `ready: true` and `extensionConnected: true`. The optional doctor command provides typed setup diagnostics:

```bash
npx -y newton-browser@0.4.1 --doctor
```

If the client is not running yet, `ready: false` with `nextAction: "start_or_restart_mcp_client_then_check_browser_status"` is expected.

## First session

Every session requires an exact origin. A typical tool sequence is:

1. Call `browser.status`.
2. Start a session with `browser.session.start`:

   ```json
   {
     "origin": "https://example.com",
     "allowedOrigins": ["https://example.com"],
     "tabMode": "owned_group",
     "instanceLabel": "example-task"
   }
   ```

3. Call `browser.observe` with the returned `sessionId`.
4. Use `browser.act` with fresh accessible references from the observation.
5. Re-observe after navigation or a page rerender.
6. Finish with `browser.tabs.finalize` using `close`, `deliverable`, or `handoff`.

`owned_group` is the safe default. Current-tab control is explicit and only succeeds when the current tab's live origin matches the session grant.

For an isolated owned tab, add `"incognito": true`. Chrome or Edge must have
**Allow in incognito** enabled for the Newton Browser extension; otherwise session start
returns `incognito_not_allowed`.

See the [tool reference](skills/newton-browser/references/tool-reference.md) for the complete tool list and action kinds.

## Current limitations

- Chrome and Edge are supported; Firefox and Safari are not.
- The Edge Add-ons listing is not yet published; Edge users must load the released ZIP unpacked or use a source build.
- Multi-tab sessions are not yet supported; a popup/new-target signal halts the action
  instead of silently transferring control.
- Newton Browser does not bypass CAPTCHAs, authentication challenges, origin grants, or its sensitive-data floor.
- A session cannot silently follow focus to another tab or origin.

## Configuration

Newton Browser reads optional per-user configuration from:

- Windows: `%LOCALAPPDATA%\NewtonBrowser\config.json`
- macOS: `~/Library/Application Support/NewtonBrowser/config.json`
- Linux: `${XDG_CONFIG_HOME:-~/.config}/newton-browser/config.json`

Example:

```json
{
  "transportAuth": "paired",
  "browserTarget": "chrome"
}
```

| Setting | Values | Default | Purpose |
| --- | --- | --- | --- |
| `transportAuth` | `local_trust`, `paired` | `local_trust` | Enables zero-touch local trust or the optional HMAC pairing handshake. |
| `browserTarget` | `auto`, `chrome`, `edge` | `auto` | Selects which connected browser may own new sessions. |
| `hostPolicies` | Array of policy manifests | Built-in generic floor | Adds exact-origin commit rules and screenshot-sensitive zones. |

Environment overrides are also available:

- `NEWTON_BROWSER_AUTH_MODE=local_trust|paired`
- `NEWTON_BROWSER_BROWSER=auto|chrome|edge`
- `NEWTON_BROWSER_CONFIG_DIR=/absolute/config/directory`

Private local integrations may additionally set all three of
`NEWTON_BROWSER_INSTANCE_LABEL`, `NEWTON_BROWSER_OBSERVER_REGISTRY_DIR`, and
`NEWTON_BROWSER_OBSERVER_TOKEN`. The first labels sessions created by that MCP
host. The latter two enable a loopback-only, bearer-authenticated observer that
publishes bounded session metadata and can focus one exact owned session. The
observer never exposes page content, origins beyond the session grant, or
transport secrets, and remains disabled unless explicitly configured.

When `paired` mode is enabled, run `--doctor` and enter the displayed one-time secret in the extension popup. Do not put the secret in MCP arguments, screenshots, issues, or logs.

## Security and privacy

Newton Browser is local-only infrastructure, but browser automation still carries risk.

- Relay listeners bind only to `127.0.0.1`.
- Every session is restricted to exact HTTP(S) origins.
- Page content is treated as untrusted data, never as instructions or authorization.
- Newton Browser does not inspect cookies, browser storage, profile files, saved passwords, or authentication tokens.
- Screenshot masking happens in the extension before bytes cross the relay.
- The safety floor classifies external-effect actions, but it is not a human approval system. The calling agent remains responsible for authorization.
- Page observations and screenshots stay on the local relay; they leave the machine only if the configured MCP client sends them to its model provider.

Read the full [security model and vulnerability-reporting guidance](docs/SECURITY.md) before using Newton Browser with sensitive accounts.

## Development

Common repository commands:

```bash
pnpm build                 # Build packages, host, and extension
pnpm typecheck             # Type-check the workspace
pnpm test                  # Run the test suite
pnpm lint                  # Verify the standalone product boundary
pnpm smoke:quick           # Run the fast smoke subset
pnpm extension:artifact    # Build the distributable extension ZIP + checksum
pnpm pack:check            # Build and verify the MCP package tarball
pnpm release:check         # Run the complete release gate
```

The full release gate is intentionally exhaustive and includes packed-install, clean-user, protocol, fixture, chaos, concurrency, and artifact checks. See [CONTRIBUTING.md](CONTRIBUTING.md) before submitting a change.

## Repository layout

```text
apps/extension/       Manifest V3 extension
apps/mcp-server/      stdio MCP server and localhost relay
packages/core/        Contracts, schemas, redaction, and safety floor
packages/driver/      Browser-side CDP driver
skills/newton-browser Canonical agent workflow and tool reference
examples/mcp/         Version-pinned artifact configuration examples
docs/                 Installation, security, decisions, and release docs
test/                 Fixtures and recorded verification evidence
```

## Documentation

- [Detailed installation guide](docs/INSTALL.md)
- [MCP client configuration](docs/MCP_CLIENTS.md)
- [Tool reference](skills/newton-browser/references/tool-reference.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)
- [Security model](docs/SECURITY.md)
- [Privacy policy](docs/PRIVACY.md)
- [Architecture and contract decisions](docs/DECISIONS.md)
- [Release process](docs/RELEASE.md)
- [Discovery submission plan](docs/DISCOVERY_PLAN.md)
- [Roadmap](ROADMAP.md)

## Contributing and support

Bug reports and focused feature requests are welcome through the repository's issue templates. Please include deterministic reproduction steps and remove credentials, page content, screenshots, and local paths that should not be public.

For code contributions, read [CONTRIBUTING.md](CONTRIBUTING.md). Security issues should follow the private-reporting guidance in [docs/SECURITY.md](docs/SECURITY.md), not a public issue.

## License

Newton Browser is licensed under the [MIT License](LICENSE).
