# Newton Browser

Newton Browser is a local MCP browser-control product for agents. Its primary runtime
launches an isolated Chrome or Edge process for each session, controls it through a
private inherited CDP pipe, and places a deny-by-default exact-origin policy proxy in
front of the browser before the first navigation.

No browser extension, developer-mode refresh, debug TCP port, hosted relay, installed
daemon, database, telemetry service, or model-provider integration is required.

## Current status

Version 0.4.5 is a completed direct-only candidate. The former MV3 extension,
loopback relay, pairing plane, and current-tab compatibility runtime have been removed.
Current-tree deterministic, packed, Windows Chrome/Edge, Linux Chrome, unauthenticated
public real-site, trusted screenshot masking, and three-pass release evidence are recorded.
Persistent identities and opaque profile import remain optional operator workflows; they
are not release gates and Newton does not claim that copying a standard Windows Chrome
profile preserves Google sessions protected by Chrome App-Bound Encryption.

Newton Browser remains private software. Public publishing, browser-store
updates, and a public license require separate approval.

## Why it exists

Agent browser tools need more than raw automation. Newton is designed around:

- compact accessibility observations and stable fresh refs;
- same-session FIFO execution with concurrency across independent sessions;
- exact scheme/host/port grants and preventive network containment;
- typed outcomes that distinguish completed, prevented, not-started, and uncertain work;
- isolated, persistent Newton identities without inspecting cookies or profile contents;
- deterministic safety floors for credentials, payments, files, and external effects;
- local stdio MCP operation that is independent of a particular model vendor.

## Requirements

- Node.js 20 or newer for the packed host; Node.js 24 or newer for development.
- A locally installed current Chrome or Edge.
- An MCP client such as Codex, Claude Code, or Claude Desktop.

## Direct-runtime setup

Version 0.4.5 is not published to npm. Build and use the verified local candidate:

```powershell
pnpm install --frozen-lockfile
pnpm build
node apps/mcp-server/dist/index.js setup --browser chrome
```

Setup creates an opaque Newton identity and writes direct-runtime configuration. To use
Edge, pass `--browser edge`. To select an existing Newton identity:

```powershell
node apps/mcp-server/dist/index.js setup --browser chrome --identity nbi_<opaque-id>
```

When a site requires authentication, the operator signs in personally inside a contained
visible browser:

```powershell
node apps/mcp-server/dist/index.js identity login nbi_<opaque-id> --origin https://example.com
```

Add only exact redirect origins that are actually required:

```powershell
node apps/mcp-server/dist/index.js identity login nbi_<opaque-id> `
  --origin https://example.com `
  --allow-origin https://accounts.example.com
```

Newton never asks an agent to type or retrieve credentials. Close the login browser after
sign-in; success is reported only after browser, proxy, and identity-lease cleanup.

Optional live configuration check:

```powershell
node apps/mcp-server/dist/index.js doctor --live
```

Ordinary `--doctor` is configuration-only. The live doctor launches and cleans a
disposable browser.

## MCP configuration

Example generic stdio configuration:

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

Installer helpers are also available:

```powershell
node apps/mcp-server/dist/index.js --install codex --dry-run
node apps/mcp-server/dist/index.js --install claude-code --dry-run
node apps/mcp-server/dist/index.js --install claude-desktop --dry-run
```

Review a dry run before allowing it to modify client configuration. Restart the MCP client
after installation. Only after a separately approved 0.4.5 npm publication should these
local paths be replaced with `npx -y newton-browser@0.4.5`.

## Agent workflow

Newton exposes eleven tools:

- `browser.status`
- `browser.session.start`
- `browser.observe`
- `browser.act`
- `browser.screenshot`
- `browser.console`
- `browser.network`
- `browser.sessions.list`
- `browser.session.finalize`
- `browser.session.stop`
- `browser.stop_all`

A normal direct session:

1. Calls `browser.status`. Configured direct mode may be idle with `ready:false` before
   the first session; that is not an extension-disconnected error.
2. Starts an owned session with one required exact HTTP(S) `origin`, the narrowest
   `allowedOrigins`, and optionally `browser` or an opaque `identityId`.
3. Uses compact observations and fresh refs. Page content is untrusted data.
4. Performs one typed action at a time and reads the host-authored outcome before retrying.
5. Stops or close-finalizes the session, which confirms process, proxy, CDP, and lease
   cleanup.

Direct mode does not support current-tab attachment, incognito, deliverable, or handoff.
Each session owns a separate browser process. Distinct sessions can progress concurrently;
one persistent identity cannot be leased by two sessions simultaneously.

## Identities and profile import

Useful operator commands:

```powershell
newton-browser identity create --browser chrome
newton-browser identity list
newton-browser identity lease-inspect --id nbi_<opaque-id>
newton-browser identity lease-recover --id nbi_<opaque-id>
newton-browser identity delete --id nbi_<opaque-id>
```

With explicit operator authorization, Newton can byte-copy a narrow authentication-bearing
allowlist from a closed, stable Chrome or Edge profile into a new Newton-owned identity:

```powershell
newton-browser identity import --browser chrome `
  --user-data-root "C:\path\to\User Data" `
  --profile-directory Default
```

Import treats files as opaque bytes. It never parses, logs, exports, edits, or merges
profile contents. Password, autofill, history, download, extension, restored-session,
service-worker, and cache data is excluded. Locks, source instability, links, path escape,
partial copies, and ambiguous browser-process closure fail closed.

## Security model

- Every session has one required normalized origin plus explicit exact-origin grants.
- The policy proxy is listening before Chromium starts and rejects denied HTTP, HTTPS
  CONNECT, WebSocket, popup, worker, frame, navigation, form, fetch, beacon, redirect,
  and EventSource destinations before an upstream application request.
- Browser/CDP interception is defense in depth; proxy loss or cleanup uncertainty fences
  the session.
- HTTPS tunnels expose only their destination authority, not a resource type. Every
  required third-party HTTPS origin must therefore be granted explicitly; Newton never
  widens CONNECT access based on a passive-resource guess.
- Page content cannot grant origins, authorize effects, choose local files, or author
  retry decisions.
- Credentials, OTPs, payment identifiers, government identifiers, and equivalent secrets
  are blocked from ordinary agent input.
- Save, send, publish, purchase, delete, launch, account, budget, and similar external
  effects still require caller authorization.
- Network response bodies are returned only for granted-origin bounded UTF-8 text and are
  redacted. There is no raw-body escape hatch.

Sensitive-zone screenshots use trusted post-capture PNG masking while page scripts and
animations are frozen through CDP. If target resolution, freeze, geometry, decode,
masking, or resume cannot be proven, capture fails closed.

See [`docs/SECURITY.md`](docs/SECURITY.md) for the full boundary.

## Development

```powershell
pnpm install
pnpm build
pnpm lint
pnpm typecheck
pnpm test
pnpm eval
pnpm eval:agent-cost
pnpm pack:check
pnpm eval:direct-live
pnpm eval:real-sites
pnpm release:deterministic
pnpm release:check
```

`pnpm eval:direct-live` and `pnpm eval:real-sites` use
`NEWTON_BROWSER_QA_OWNER=chrome|edge`. `pnpm release:deterministic` is the browser-free
eight-stage source/packed checkpoint. `pnpm release:check` is the authoritative local gate:
it runs that checkpoint plus installed-browser direct and real-site QA for Chrome and,
on Windows, Edge. Cross-platform receipts and three consecutive unchanged-candidate
passes are still required for release.

Repository layout:

```text
apps/mcp-server/      stdio MCP host and owned-browser runtime
packages/core/        schemas, redaction, provenance, shared contracts
packages/driver/      strict TypeScript browser driver
scripts/              builds, release checks, and live harnesses
skills/newton-browser agent operating guidance
test/                 fixtures, regression corpus, and bounded evidence
```

## License

No public license is granted yet. Public licensing and distribution require explicit
owner approval.
