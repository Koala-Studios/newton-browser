# Newton Browser 0.6.4 tool reference

This contract applies only to the immutable 0.6.4 entrypoint configured in the MCP
client. A repository/worktree build, global command, or older cached package must not be
used for live browser or identity-login work.

Newton exposes ten stateless MCP tools: `browser.status`, `browser.session.start`,
`browser.observe`, `browser.act`, `browser.screenshot`, `browser.console`,
`browser.network`, `browser.sessions.list`, `browser.session.stop`, and `browser.stop_all`.

`browser.session.start` requires one HTTP(S) `origin`, optionally a Chrome/Edge family,
opaque identity ID, and nested initial-observation object. Use
`observe: { mode: "full", format: "compact" }`, not `observe: "full"` or top-level
observation fields. The origin is the initial navigation and
identity-binding key, not a network grant. Normal redirects and cross-origin resources
work automatically.

Actions are `navigate`, `back`, `forward`, `reload`, `click`, `fill`, `type`, `select`,
`clear`, `press`, `scroll`, `hover`, `move`, `wait_for`, `set_files`, `dialog_accept`,
`dialog_dismiss`, `resize`, and `fill_form`. Target fields are flat and refs must come from
a fresh observation. Every interactive `full` or `diff` observation starts a new bounded
ref cycle and releases refs not emitted by that snapshot, including on a same-document
SPA. `text` mode allocates no refs and preserves the current interactive cycle.

An owned popup or new tab is discovered while provisional and becomes the active page
inside the same `sessionId` only after it commits to HTTP(S); its fresh observation
replaces the opener's refs. Closing it restores a freshly rebuilt opener context. There
is no browser-chrome click or public tab-management tool.

Action results carry host-authored `status`, `outcome`, `retrySafe`, and `decision` fields.
`prevented` is reserved for a refusal proven before input dispatch. Once input begins, an
uncertain result is never retry-safe. POST/GraphQL/telemetry traffic is observational and
cannot fail, verify, or authorize an action. Retain and re-observe the same session after
`outcome_unknown` or `dispatched_unverified`; do not restart authentication. Page-derived
payloads are marked `untrusted_page_content`.

`browser.network` returns bounded metadata without headers. Bodies are limited to bounded
supported UTF-8 text from the current visible origin. Network entries are observational;
there is no policy-decision or blocked-origin field.

Screenshots are MCP image content only. Sensitive zones are masked after capture without
pausing scripts or animations. `server/discover` advertises only MCP `2026-07-28`; there
is no handshake or compatibility transport.
