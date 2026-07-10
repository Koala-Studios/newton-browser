# Browser Bridge Tool Reference

All tools use the local transport and explicit session IDs.

## Tools

- `browser.status`: report auth mode, extension, host, protocol, session, and limit readiness without opening a tab.
- `browser.session.start`: require an HTTP(S) origin, attach an owned/current tab, reconcile its live origin, and return a ready session.
- `browser.observe`: return a full compact accessibility observation or diff.
- `browser.act`: execute one typed action and return the deterministic floor decision with the result.
- `browser.screenshot`: deliver PNG evidence through an MCP image block, caller-designated file, or bounded inline fallback.
- `browser.tabs.list`: list only this host's session state.
- `browser.tabs.finalize`: close, retain as deliverable, or hand off one session tab.
- `browser.session.stop`: stop and clean one session.
- `browser.stop_all`: explicit global cleanup across connected hosts.

## Action kinds

`observe`, `screenshot`, `navigate`, `back`, `forward`, `reload`, `click`, `fill`, `type`, `select`, `clear`, `press`, `scroll`, `hover`, `move`, `wait_for`, and `set_files`.

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

Exact schemas and bounds are locked in `docs/DECISIONS.md` and exposed by MCP `tools/list`.
