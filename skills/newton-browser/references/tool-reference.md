# Newton Browser 0.4.5 Tool Reference

All tools use local transport and explicit session IDs. MCP `tools/list` remains
authoritative for exact schemas and bounds.

## Tools

- `browser.status`: report compact readiness without opening a tab. Pass
  `detail: "full"` for runtime mode, configuration, browser-family availability,
  sessions, cleanup uncertainty, and limits.
- `browser.session.start`: require an HTTP(S) origin and start an origin-contained
  session. Direct mode accepts optional `browser: "chrome"|"edge"` and an opaque
  operator-created `identityId`; it owns a separate browser process. `observe` accepts
  compact/JSON options and returns initial state in the same call; `false` disables it.
- `browser.observe`: compact and geometry-free by default; filter with `query`, `roles`,
  and `limit`, or explicitly request `format: "json"`/`includeGeometry: true`.
  `includeInteractive: true` performs bounded, read-only DOM discovery. Return `full`
  accessibility state, a `diff`, or bounded/redacted
  readable `text` (`maxChars` 200–200,000).
- `browser.act`: execute one strictly validated action and return deterministic floor
  metadata. The schema's `x-newtonVariants`, `x-newtonRequired`, and
  `x-newtonTargetRequired` tables are the compact per-kind contract. Optional top-level
  `timeoutMs` is a 1-300,000 ms command deadline; queued expiry is `not_started`, while
  expiry after execution begins is `outcome_unknown`. Never auto-retry the latter.
- `browser.screenshot`: deliver PNG/JPEG through `image`, caller-designated `file`, or
  bounded `inline`. Supports `fullPage`, `device`, `waitMs`, explicit `region`, and JPEG
  `quality` 1–100.
- `browser.console`: read a bounded, secret-redacted console buffer. Filter by
  `level`/`pattern`; `clear: true` empties it.
- `browser.network`: list bounded request metadata without headers. Filter by URL or
  pass `requestId` for one origin-gated, bounded/redacted UTF-8 text body. Opaque,
  binary, malformed, compressed, and base64 bodies are omitted.
- `browser.sessions.list`: list only this host's session state.
- `browser.session.finalize`: close one owned session and confirm process/proxy/lease cleanup.
- `browser.session.stop`: stop and clean one session.
- `browser.stop_all`: explicit cleanup of every session owned by this MCP host.

## Action kinds

`navigate`, `back`, `forward`, `reload`, `click`, `fill`,
`type`, `select`, `clear`, `press`, `scroll`, `hover`, `move`, `wait_for`, `set_files`,
`dialog_accept`, `dialog_dismiss`, `resize`, and `fill_form`.

Observation, screenshots, console, and network reads use their dedicated tools and are
intentionally not duplicated inside `browser.act`.

Element refs are composite and fresh-observation scoped: `dN:eN` for the root document
and `dN:fN:eN` for a frame. Never synthesize, shorten, or reuse a stale ref. Malformed
refs, unknown kinds, misspelled fields, bad enums, and variant-inappropriate fields fail
as `invalid_arguments` before browser dispatch.

`resize` accepts `viewport: {width,height}` for owned tabs only, bounded to
200–3840 × 200–2160, and persists across debugger re-attach.

`fill_form` accepts an ordered `fields` array. Each field uses the normal target and
`value`, passes the full per-field floor, and returns a per-field summary. The batch
halts before a sensitive field and reports `stoppedAt`.

A page-created `alert`, `confirm`, `prompt`, or `beforeunload` appears as
`pendingDialog` on observations. Respond with `dialog_accept` (optionally
`promptText`) or `dialog_dismiss`. These are agentic; reconciliation still detects any
navigation or network write caused by acceptance.

Every act result includes floor metadata similar to:

```json
{
  "ok": true,
  "status": "verified",
  "outcome": "completed",
  "retrySafe": false,
  "decision": { "code": "agentic", "reason": "origin_granted" },
  "changed": true,
  "delta": ["value=\"saved\""],
  "provenance": {
    "trust": "untrusted_page_content",
    "origin": "https://example.com",
    "sessionEpoch": 1
  }
}
```

Important statuses include `verified`, `dispatched_unverified`, `blocked`,
`not_found`, `ambiguous`, `stale_target`, `target_moved`, `timed_out`, and `failed`.
A post-action `blocked` result can occur after dispatch; inspect current state before a
retry.

Initialization and full status expose contract version `2.0`. Page-derived output is
structurally marked `trust:"untrusted_page_content"`; only outer host-authored outcome,
decision, retry, continuation, provenance, and error fields guide the agent. Screenshot
metadata always distinguishes `mask_applied`, `mask_not_configured`, and
`mask_not_applicable`. Sensitive zones are redacted in trusted raster bytes; any
uncertainty fails the capture instead of returning unmasked pixels.
