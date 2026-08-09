# Newton Browser 0.4 Tool Reference

All tools use local transport and explicit session IDs. MCP `tools/list` remains
authoritative for exact schemas and bounds.

## Tools

- `browser.status`: report compact readiness without opening a tab. Pass
  `detail: "full"` for auth mode, host/extension/protocol versions, browser selection,
  sessions, and limits.
- `browser.session.start`: require an HTTP(S) origin, attach an owned/current tab,
  reconcile its live origin, and return a ready session. `observe` accepts compact/JSON
  options and returns initial state in the same call; `false` disables it. `incognito: true` opens an
  owned tab in an incognito window and requires extension permission there.
- `browser.observe`: compact and geometry-free by default; filter with `query`, `roles`,
  and `limit`, or explicitly request `format: "json"`/`includeGeometry: true`.
  `includeInteractive: true` performs bounded, read-only DOM discovery. Return `full`
  accessibility state, a `diff`, or bounded/redacted
  readable `text` (`maxChars` 200–200,000).
- `browser.act`: execute one typed action and return deterministic floor metadata.
- `browser.screenshot`: deliver PNG/JPEG through `image`, caller-designated `file`, or
  bounded `inline`. Supports `fullPage`, `device`, `waitMs`, explicit `region`, and JPEG
  `quality` 1–100.
- `browser.console`: read a bounded, secret-redacted console buffer. Filter by
  `level`/`pattern`; `clear: true` empties it.
- `browser.network`: list bounded request metadata without headers. Filter by URL or
  pass `requestId` for one origin-gated, bounded/redacted response body.
- `browser.tabs.list`: list only this host's session state.
- `browser.tabs.finalize`: `close`, retain as `deliverable`, or detach/activate as
  `handoff`.
- `browser.session.stop`: stop and clean one session.
- `browser.stop_all`: explicit global cleanup across connected hosts.

## Action kinds

`observe`, `screenshot`, `navigate`, `back`, `forward`, `reload`, `click`, `fill`,
`type`, `select`, `clear`, `press`, `scroll`, `hover`, `move`, `wait_for`, `set_files`,
`dialog_accept`, `dialog_dismiss`, `resize`, and `fill_form`.

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
