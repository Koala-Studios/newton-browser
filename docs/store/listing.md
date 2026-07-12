# Store Listing Copy (Chrome Web Store & Edge Add-ons)

Draft copy for the extension listings. **Before submitting**, check both stores for a
name collision on "Newton" / "Newton Browser" and adjust the display name if needed
(there is a well-known email app named Newton). Screenshots are captured from the WS6
onboarding page, the connected popup with a session row, and an agent driving an owned
tab. Privacy-policy URL: the published `docs/PRIVACY.md` (GitHub Pages or raw GitHub URL).

## Display name

Newton Browser — Local Browser Control for MCP Agents

## Summary (Chrome Web Store, ≤132 chars)

Let your local AI agent drive your own Chrome tab through MCP. Local-only, no telemetry,
no cloud, every session origin-scoped.

## Category

Developer Tools

## Single-purpose statement

Newton Browser connects a local MCP client (such as Codex or Claude) to this browser so
an agent you run can open, observe, and interact with web pages in origin-scoped,
owned tabs. That is its single purpose.

## Full description

Newton Browser is the browser half of an open, agent-agnostic browser-control tool. It
pairs with a small MCP host you run locally (installed via `npx newton-browser`) so an AI
agent can drive a real browser tab using your existing signed-in profile — no separate
automation profile, no hosted service, no account.

Built local-first:
- **Local only.** The host and this extension talk over a WebSocket bound to 127.0.0.1.
  Nothing is sent to any Newton Browser server, because there isn't one.
- **No telemetry.** No analytics, no tracking, no crash reporting.
- **Origin-scoped sessions.** Every session is pinned to the exact HTTP(S) origins you
  grant; the agent cannot wander to other sites.
- **Owned tabs by default.** The agent works in its own tabs; controlling your current
  tab must be requested explicitly.
- **Optional incognito isolation.** Public-site QA and screenshots can use an owned
  incognito tab so profile cookies and storage are not present.
- **A safety floor.** Credentials, one-time codes, payment fields, and government-id
  fields are blocked before any keystroke; likely secrets are redacted out of what the
  agent sees.

Open source (MIT): https://github.com/Koala-Studios/newton-browser

## Permission justifications (Chrome Web Store review)

- **`debugger`** — Browser control is implemented via the Chrome DevTools Protocol
  (observe the accessibility tree, dispatch input, capture screenshots). This is the
  core mechanism. All CDP traffic is confined to the loopback relay; the extension
  operates no remote endpoint. Note: Chrome shows an "extension is debugging this
  browser" info bar during active sessions — this is expected.
- **`tabs` / `tabGroups`** — Create, group, and finalize the agent's owned tabs and
  track session tab lifecycle, including placing an explicitly requested isolated
  session in an incognito window.
- **`scripting`** — Inject the observation/overlay helpers used to build the compact
  accessibility snapshot and the driving indicator.
- **`storage`** — Persist local connection settings and, only in optional hardened
  pairing mode, a pairing secret. Local to the browser profile.
- **`alarms`** — Drive reconnect/keepalive timers for the loopback connection.
- **Host permissions (`http://*/*`, `https://*/*`)** — A session may target any origin
  the user chooses at runtime, so the manifest cannot enumerate them ahead of time.
  Access is user-scoped per session at runtime; the extension does not act on any origin
  without an explicit granted session. Evaluate `optional_host_permissions` as a future
  hardening if per-origin runtime grants can be requested without breaking attach.

## Data-use disclosures

- Google treats local page capture and processing as user-data handling. Disclose
  **Website content**, **Web history**, and **User activity** for the page structures,
  screenshots, session URLs/origins, bounded network metadata, and action results handled
  during an explicit session. Select **App functionality** as the only use.
- Certify that Newton Browser does not sell data, use it for advertising, allow publisher
  personnel to read it, or use it for unrelated purposes. Browser data travels only over
  loopback to the user's own configured MCP client; any later model-provider transfer is
  controlled by that client rather than a Newton Browser service.
