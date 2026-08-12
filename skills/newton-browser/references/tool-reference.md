# Newton Browser 0.5.0 Tool Reference

`tools/list` is authoritative. Newton exposes ten modern MCP tools:

- `browser.status`: compact readiness; `detail:"full"` adds limits and session-ID-keyed,
  bounded queue/lifecycle diagnostics without identity paths or process identifiers.
- `browser.session.start`: require one HTTP(S) origin; optionally select Chrome/Edge,
  at most 31 exact additional origins that do not repeat the primary, an opaque identity, and an initial
  observation. The normalized full grant set is capped at 32.
- `browser.observe`: compact output by default; request JSON geometry, interactive DOM
  discovery, full/diff accessibility state, or bounded redacted text.
- `browser.act`: execute one validated action. Optional `timeoutMs` is 1-300,000 ms;
  queued expiry is `not_started`, while expiry after dispatch is `outcome_unknown`.
- `browser.screenshot`: return PNG/JPEG as MCP image content only. Supports full page,
  region, quality, and sensitive-zone masking; zone refs must be canonical composite refs.
- `browser.console`: read/filter a bounded redacted console buffer.
- `browser.network`: list bounded request metadata or fetch one exact-origin bounded
  UTF-8 body. Headers, opaque, binary, malformed, compressed, and base64 bodies stay out.
- `browser.sessions.list`: list this host's sessions.
- `browser.session.stop`: stop one session and confirm process/proxy/lease cleanup.
- `browser.stop_all`: explicitly clean every session owned by this host.

## Actions

`navigate`, `back`, `forward`, `reload`, `click`, `fill`, `type`, `select`, `clear`,
`press`, `scroll`, `hover`, `move`, `wait_for`, `set_files`, `dialog_accept`,
`dialog_dismiss`, `resize`, and `fill_form`.

Observation, screenshot, console, and network reads use dedicated tools. Action target
fields are flat: `ref`, role/name, label, placeholder, text, test id, selector, or
coordinates. Never synthesize or reuse composite refs after navigation or rerender.

`resize` accepts `viewport:{width,height}` bounded to 200-3840 x 200-2160.

`fill_form` accepts ordered flat target/value fields. Every field receives the normal
safety floor; the batch returns `fields` and `stoppedAt` when it halts.

Each action result has one authoritative result shape:

```json
{
  "ok": true,
  "status": "verified",
  "outcome": "completed",
  "retrySafe": false,
  "decision": { "class": "agentic", "commitBoundary": "draft" },
  "changed": true,
  "delta": ["value"]
}
```

Observations and other page-derived payloads carry
`provenance:{trust:"untrusted_page_content",origin}`. Ordinary action acknowledgements
contain host-authored status/decision metadata and do not fabricate page provenance.

Important statuses include `verified`, `dispatched_unverified`, `blocked`, `not_found`,
`ambiguous`, `stale_target`, `timed_out`, and `failed`. Inspect page state before any
retry after dispatch.

`server/discover` advertises only MCP `2026-07-28`. Every request carries protocol
version and client capabilities in `_meta`; every successful result has
`resultType:"complete"` and server identity in response `_meta`. There is no handshake,
MCP session header, framed compatibility transport, or legacy result alias.
