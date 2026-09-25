# Newton Browser

Newton Browser is a local MCP browser-control product for agents. Each session launches
an isolated Chrome or Edge process and controls it through inherited private CDP pipes.
By default browser traffic uses Chromium's normal networking with no Newton proxy, origin allowlist,
request interception, or resource filtering.

The default runtime requires no browser extension, relay, daemon, debug TCP port, database, telemetry,
hosted service, or model-provider integration.

## Status

The default source runtime now uses the replacement shared engine, with isolated workers from a shared Newton login source and an optional thin existing-browser adapter. Native actions, precise editing, contextual controls, records/documents, screenshots, tab ownership and update foundations are implemented. This is an **unreleased development checkpoint**, not completed real-world acceptance.

The legacy direct runtime is retired (2026-09-25): the session engine is the only action, receipt and ref authority. Build, typecheck, boundary lint and the full suite pass. Feedback/reading refinements, platform and authenticated task QA, and three unchanged packed release gates remain open. See the [current progress ledger](docs/PROGRESS_LEDGER.md), [remaining roadmap](ROADMAP.md) and [consolidation record](docs/implementation/CONSOLIDATION_2026-09-25.md).

Package version remains 0.6.4; historical receipts apply only to their recorded candidates. No package or browser-store release is implied by the source checkpoint.

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

Every owned session is an isolated copy of a shared login source (`default` unless the
session names another). To sign in once for later sessions, open the source's visible
browser, sign in personally, and confirm:

```powershell
node apps/mcp-server/dist/index.js source login --id default --browser chrome
```

Newton never asks an agent to enter or retrieve credentials. The published sign-in
becomes the source's next generation; running sessions keep their own copies, and nothing
a session does is merged back.

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

Tools (`tools/list` is authoritative): `browser.session.start`, `browser.observe`,
`browser.act`, `browser.command`, `browser.document.read`, `browser.document.continue`,
`browser.screenshot`, `browser.console`, `browser.network`, `browser.pages.list`,
`browser.page.select`, `browser.sessions.list`, `browser.session.stop`, and the
operator-selected existing-browser tools `browser.existing.discover` and
`browser.existing.setup`.

A normal loop:

1. `browser.session.start` with a complete URL returns the session, its first page and
   `nextCommandId`.
2. `browser.observe` returns bounded controls with refs; records mode reads links, tables
   and forms; `browser.document.read` reads text with a continuation cursor.
3. `browser.act` performs one typed action or a sequence and returns a receipt: dispatch,
   postcondition, and the next state when it changed. Reuse a `commandId` only for the
   identical command; after an uncertain receipt, reconcile with `browser.command` rather
   than replaying.
4. `browser.session.stop` ends the session independently of its queue.

Popups and new tabs are attached as session pages without changing the selected page;
`browser.pages.list` and `browser.page.select` move between them. A hung renderer is
reopened on the same page and the receipt says so. Console and network recording is
opt-in because enabling it is visible to pages.

## Identities and opaque profile import

Identities are the store's opaque browser profiles; login sources and session copies are
built on them. Operator utilities:

```powershell
newton-browser identity create --browser chrome
newton-browser identity list
newton-browser identity lease-inspect --id nbi_<opaque-id>
newton-browser identity lease-recover --id nbi_<opaque-id>
newton-browser identity delete --id nbi_<opaque-id>
newton-browser identity import --browser chrome `
  --user-data-root "C:\path\to\User Data" `
  --profile-directory Default
```

Import byte-copies a narrow allowlist of authentication-bearing files from a closed,
stable local profile and never modifies the source. Passwords, autofill, history,
downloads, extensions, sessions, service workers, and caches are excluded. Browser
encryption may prevent copied authentication from remaining usable; Newton does not
bypass that protection.

## Security boundary

- Browsers run on inherited private CDP pipes: no debug port, relay or extension in owned mode.
- A hosting process can restrict owned browsers to public internet addresses (`NEWTON_BROWSER_EGRESS=public`); otherwise networking is ordinary Chromium networking.
- Page content is untrusted data; it cannot authorize effects or select local files.
- Screenshots mask password and sensitive-autocomplete fields across frames and shadow roots, plus any explicit sensitive zones.
- Network response bodies are available only as bounded text from the page's own origin; headers are never kept.

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
