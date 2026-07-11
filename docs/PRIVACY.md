# Newton Browser Privacy Policy

_Last updated: 2026-07-10_

Newton Browser is a local, developer tool. It connects an MCP client on your computer to
a browser extension on the same computer so an AI agent you run can drive a browser tab.
It has no backend.

## What Newton Browser does not do

- **No telemetry.** Newton Browser sends no analytics, usage metrics, crash reports, or
  any other data to Koala Studios or any third party.
- **No servers.** There is no Newton Browser cloud service, account, database, or relay.
  The MCP host and the extension talk over a WebSocket bound to `127.0.0.1` (loopback)
  only — traffic never leaves your machine.
- **No profile harvesting.** Newton Browser does not read your browsing history, saved
  passwords, autofill data, cookies, or bookmarks. It does not enumerate your tabs beyond
  the sessions it owns.

## What data is handled, and where it goes

- **Page content the agent observes.** When you ask an agent to observe, screenshot, or
  read a page, that page's accessible structure, text, or image is captured and returned
  to the MCP client you configured. Newton Browser redacts likely secrets (passwords,
  card and government-id numbers) in the host before results reach the client. Whether
  that data then leaves your machine depends entirely on **your** MCP client and its model
  provider — Newton Browser itself never transmits it anywhere.
- **Local settings.** The extension stores a small amount of state in
  `chrome.storage.local`: your connection settings and, only if you enable the optional
  hardened pairing mode, a pairing secret. This never leaves the browser profile.
- **Incognito sessions.** When explicitly requested, an owned tab opens in an incognito
  window and does not inherit the normal profile's cookies or storage. The extension
  must be allowed in incognito by the user; Newton Browser never enables that setting.
- **Screenshots you save.** If you ask for a screenshot delivered to a file, it is written
  only to the absolute directory you specify.

## Permissions

The extension requests broad host access and the `debugger` permission because browser
control is implemented through the Chrome DevTools Protocol, and a session may target any
HTTP(S) origin you choose at runtime. Every session is scoped to the exact origins you
grant, and control traffic is confined to loopback. See the permission justifications in
`docs/store/listing.md`.

## Contact

Questions or concerns: open an issue at
https://github.com/Koala-Studios/newton-browser/issues (do not include secrets or private
page content). For security reports, follow the private-disclosure process in
[docs/SECURITY.md](SECURITY.md).
