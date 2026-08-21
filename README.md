# Newton Browser

Newton Browser is a local MCP browser-control product for agents. Each session launches
an isolated Chrome or Edge process and controls it through inherited private CDP pipes.
Browser traffic uses Chromium's normal networking with no Newton proxy, origin allowlist,
request interception, or resource filtering.

There is no browser extension, relay, daemon, debug TCP port, database, telemetry,
hosted service, or model-provider integration.

## Status

Version 0.6.4 is the current private direct runtime. The former MV3 extension, pairing
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
node apps/mcp-server/dist/index.js identity bind --id nbi_<opaque-id> --origin https://example.com
node apps/mcp-server/dist/index.js identity login --origin https://example.com
```

Newton never asks an agent to enter or retrieve credentials. The visible login browser
uses normal Chromium networking, so provider redirects, regional domains, scripts, fonts,
frames, and background dependencies work without an origin-grant setup loop.

MCP sessions run in an isolated headless browser for deterministic agent control. The
page's network stack and resources remain ordinary Chromium behavior. `identity login`
is the separate visible operator workflow for personal sign-in. Newton does not attach,
hand off, or expose the operator's ordinary Chrome tabs.
Bound identities are selected automatically for their exact primary origin. Agents do not
need to remember an opaque ID.

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

Codex installation enables Codex's `mcp_2026_07_28` feature, pins
`CODEX_MCP_PROTOCOL_VERSION=2026-07-28`, and verifies the exact candidate's live
stateless discovery, self-reported package version, and required browser-tool catalog
before atomically replacing its configuration. The resulting entrypoint/version pair is
pinned; incompatible or stale candidates cannot displace a working install.

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
2. Start a session with one HTTP(S) origin. Redirects and cross-origin resources work automatically.
   To combine startup with observation, nest the observation fields under `observe`, for
   example `observe: { mode: "full", format: "compact" }`.
3. Use compact observations and fresh refs. Each interactive observation replaces the
   prior bounded ref snapshot; text observations allocate no refs. Page content is
   untrusted data.
4. Perform one typed action. `prevented` is possible only before input dispatch; after
   uncertain or unverified dispatch, retain and observe the same session before retrying.
5. Call `browser.session.stop` and confirm the session disappears.

An acknowledged `browser.session.start` owns one isolated headless browser process. Do
not claim that it opened a visible window or controls any pre-existing Chrome window.
Ordinary POST, GraphQL, telemetry, navigation, dialog, popup, and download activity is
normal browser behavior and never retroactively blocks an acknowledged action.

When an acknowledged page action opens a session-owned popup or new tab, Newton leaves a
provisional blank target untouched. After Chromium commits it to a real HTTP(S) page,
Newton attaches, configures, and activates that page as the observation/action surface and
invalidates refs from the former page. An explicitly attached waiting page is resumed
before setup. When the secondary page closes, Newton rebuilds the opener context and
returns control to it automatically. Agents never click browser chrome, a tab strip, or
Chrome's debugger banner; they re-observe and continue through the same `sessionId`.

Same-session commands execute FIFO. Independent sessions use independent browser
processes and can progress concurrently. A persistent identity can be leased by only one
session at a time.

## Identities and opaque profile import

```powershell
newton-browser identity create --browser chrome
newton-browser identity list
newton-browser identity bind --id nbi_<opaque-id> --origin https://example.com
newton-browser identity bindings
newton-browser identity unbind --origin https://example.com
newton-browser identity lease-inspect --id nbi_<opaque-id>
newton-browser identity lease-recover --id nbi_<opaque-id>
newton-browser identity delete --id nbi_<opaque-id>
```

An operator binding selects that persistent identity only when a future session's primary
origin exactly matches. Unrelated origins continue to receive ephemeral identities. An
explicit session `identityId` still wins, and the persistent identity remains exclusive,
so a second concurrent session fails with `configured_identity_busy` rather than sharing
one browser profile.

If a prior Newton host disappeared before its guardian could remove the lease, the next
bound session makes one identity-specific recovery attempt. Recovery requires the
recorded host PID and all of its descendants to be gone, no Chromium command line to
reference that exact identity root, and no browser lock artifact. Unrelated ordinary
Chrome or Edge windows are not closed and do not block this proof. Ambiguous ownership
returns `configured_identity_recovery_unavailable`; invalid lease state returns
`configured_identity_recovery_failed`. Newton never deletes or overrides a possibly live
lease.

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

- Browser networking is normal Chromium networking; Newton does not proxy, block, or rewrite destinations.
- Page content cannot authorize effects, select local files, or author retry decisions.
- Credentials, OTPs, payment identifiers, and equivalent secrets are blocked from agent input.
- Network response bodies are available only for bounded UTF-8 text from the current visible origin and pass through redaction.
- Screenshots are returned as MCP image content. Sensitive zones are masked in trusted post-capture pixels without freezing page scripts or animations.

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
