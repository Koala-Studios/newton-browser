# Newton Browser Tool Reference

All tools use the local transport and explicit session IDs.

## Tools

- `browser.status`: report auth mode, extension, host, protocol, session, and limit readiness without opening a tab.
- `browser.session.start`: require an HTTP(S) origin, attach an owned/current tab, reconcile its live origin, and return a ready session.
- `browser.observe`: return a full compact accessibility observation, a diff, or (with `mode: "text"`) bounded, secret-redacted readable page text. Use text mode to read prose/articles; use full/diff to target controls.
- `browser.act`: execute one typed action and return the deterministic floor decision with the result.
- `browser.screenshot`: deliver evidence through an MCP image block, caller-designated file, or bounded inline fallback. Optional `region: {x,y,width,height}` captures just that area; `format:"jpeg"` with `quality` (default 70) trades fidelity for a much smaller payload (PNG default).
- `browser.console`: read the session tab's buffered console output (read-only). Filter by `level`/`pattern`; `clear:true` empties the buffer. Rendered text only — never raw objects or headers; secret-redacted.
- `browser.network`: list the session tab's buffered request metadata (read-only, method/url/status/type/size — never headers). Pass `requestId` to fetch one response body, returned only when its URL origin is within the session grant and bounded/redacted.
- `browser.tabs.list`: list only this host's session state.
- `browser.tabs.finalize`: close, retain as deliverable, or hand off one session tab.
- `browser.session.stop`: stop and clean one session.
- `browser.stop_all`: explicit global cleanup across connected hosts.

## Action kinds

`observe`, `screenshot`, `navigate`, `back`, `forward`, `reload`, `click`, `fill`, `type`, `select`, `clear`, `press`, `scroll`, `hover`, `move`, `wait_for`, `set_files`, `dialog_accept`, `dialog_dismiss`, and `resize`.

`resize` sets the owned tab's viewport via `viewport: { width, height }` (owned tabs only; bounded to 200–3840 × 200–2160) and the size persists across a debugger re-attach.

`fill_form` fills an ordered `fields` array (each entry is a fill target plus `value`) in one call. Each field passes the full per-field floor; the batch stops at the first blocked or failed field and returns a per-field `fields` summary with `stoppedAt`. A sensitive field (password/OTP/payment) halts the batch before it is dispatched.

When a page opens a JavaScript dialog (`alert`/`confirm`/`prompt`/`beforeunload`), the renderer blocks until it is answered and the open dialog is reported as `pendingDialog` on observations. Respond with `dialog_accept` (optionally `promptText` for a `prompt`) or `dialog_dismiss`. These are `agentic`; post-action reconciliation still catches any navigation or network write the accept triggers.

Every act result includes:

```json
{
  "ok": true,
  "actionStatus": "verified",
  "decision": {
    "class": "agentic",
    "commitBoundary": "none",
    "reasons": ["origin_granted"]
  },
  "result": {}
}
```

Important statuses are `verified`, `dispatched_unverified`, `blocked`, `not_found`, `ambiguous`, `stale_target`, `timed_out`, and `failed`. A blocked post-action reconciliation may occur after dispatch; inspect current state before retrying.

MCP `tools/list` is authoritative for exact schemas and bounds.
