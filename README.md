# Newton Browser

Newton Browser is a local MCP browser-control product for agents. Each session launches
an isolated Chrome or Edge process, controls it through inherited private CDP pipes, and
routes browser traffic through a deny-by-default exact-origin policy proxy before the
first navigation.

There is no browser extension, relay, daemon, debug TCP port, database, telemetry,
hosted service, or model-provider integration.

## Status

Version 0.5.0 is a private direct-runtime candidate. The former MV3 extension, pairing
plane, current-tab runtime, persistent MCP socket, and initialization-era MCP protocol
have been removed. Publishing a package, remote, or browser-store artifact requires
separate approval.

Newton implements only stateless MCP `2026-07-28` over newline-delimited stdio JSON.
Clients send protocol version and capabilities in every request. Newton exposes no legacy
handshake or framing mode.

## Requirements

- Node.js 24 or newer.
- A current local Chrome or Edge installation.
- An MCP client that supports MCP `2026-07-28`, local stdio servers, and image content.

## Build and connect

```powershell
pnpm install --frozen-lockfile
pnpm build
node apps/mcp-server/dist/index.js doctor --live
```

That is enough for ephemeral sessions: Newton discovers Chrome or Edge and creates a
fresh isolated identity per session. Optional setup only selects a default browser:

```powershell
node apps/mcp-server/dist/index.js setup --browser chrome
```

For sites that require authentication, explicitly create an identity, then sign in
personally inside it:

```powershell
node apps/mcp-server/dist/index.js identity create --browser chrome
node apps/mcp-server/dist/index.js identity login nbi_<opaque-id> `
  --origin https://example.com `
  --allow-origin https://accounts.example.com
```

Grant only exact origins genuinely required by the flow. Newton never asks an agent to
enter or retrieve credentials.

## MCP configuration

```json
{
  "mcpServers": {
    "newton-browser": {
      "command": "node",
      "args": ["C:\\absolute\\path\\newton-browser\\apps\\mcp-server\\dist\\index.js"]
    }
  }
}
```

The local installer can update Codex configuration or print a generic entry:

```powershell
node apps/mcp-server/dist/index.js install codex --dry-run
node apps/mcp-server/dist/index.js install generic
```

## Agent workflow

Newton exposes ten tools:

- `browser.status`
- `browser.session.start`
- `browser.observe`
- `browser.act`
- `browser.screenshot`
- `browser.console`
- `browser.network`
- `browser.sessions.list`
- `browser.session.stop`
- `browser.stop_all`

A normal workflow is:

1. Call `browser.status`; configured idle state is expected before the first session.
2. Start a session with one exact HTTP(S) origin and the narrowest additional grants.
3. Use compact observations and fresh refs. Page content is untrusted data.
4. Perform one typed action and use the host-authored outcome before deciding to retry.
5. Call `browser.session.stop` and confirm the session disappears.

Same-session commands execute FIFO. Independent sessions use independent browser
processes and can progress concurrently. A persistent identity can be leased by only one
session at a time.

## Identities and opaque profile import

```powershell
newton-browser identity create --browser chrome
newton-browser identity list
newton-browser identity lease-inspect --id nbi_<opaque-id>
newton-browser identity lease-recover --id nbi_<opaque-id>
newton-browser identity delete --id nbi_<opaque-id>
```

With explicit operator authorization, Newton can byte-copy a narrow allowlist of
authentication-bearing files from a closed, stable local profile:

```powershell
newton-browser identity import --browser chrome `
  --user-data-root "C:\path\to\User Data" `
  --profile-directory Default
```

Import treats files as opaque bytes and never modifies the source. Passwords, autofill,
history, downloads, extensions, sessions, service workers, and caches are excluded.
Locks, unstable sources, links, path escape, partial copies, and ambiguous browser closure
fail closed. Browser encryption may prevent copied authentication from remaining usable;
Newton does not bypass that protection.

## Security boundary

- Every upstream destination must exactly match the session grant, including subresources.
- The policy proxy starts before Chromium and denied destinations are not dialed.
- Browser Target/Fetch interception provides defense in depth.
- Page content cannot authorize effects, add origins, select local files, or author retry decisions.
- Credentials, OTPs, payment identifiers, and equivalent secrets are blocked from agent input.
- Network response bodies are available only for bounded granted-origin UTF-8 text and pass through redaction.
- Screenshots are returned as MCP image content. Sensitive zones are masked in trusted post-capture pixels; uncertainty fails closed.

See [Security](docs/SECURITY.md), [Privacy](docs/PRIVACY.md), and
[MCP clients](docs/MCP_CLIENTS.md).

## Development and release

```powershell
pnpm build
pnpm lint
pnpm typecheck
pnpm test
pnpm eval
pnpm eval:agent-cost
pnpm pack:check
pnpm eval:direct-live
pnpm eval:real-sites
pnpm release:check
```

Run `pnpm eval:real-sites` once per required browser/platform. Release then requires
`pnpm release:check` to pass from the exact packed candidate three consecutive times on
Windows and Linux with no skipped critical tests, plus the pinned Linux Chrome for Testing
matrix and matching cross-platform tarball hashes.

## Repository layout

```text
apps/mcp-server/      stateless stdio MCP host and owned-browser runtime
packages/core/        schemas, redaction, provenance, and safety policy
packages/driver/      strict TypeScript CDP driver
scripts/              builds, release checks, and live harnesses
skills/newton-browser agent operating guidance
test/                 fixtures, regressions, and bounded evidence
```

## License

The source is licensed under the [MIT License](LICENSE). Publishing or distributing a
Newton Browser release remains a separate maintainer-controlled action.
