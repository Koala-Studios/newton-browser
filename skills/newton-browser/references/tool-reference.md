# Newton Browser tool reference

`tools/list` is authoritative; this summarizes the engine contract.

- `browser.session.start`: `url` (complete HTTP(S) URL), optional `loginSource`, `viewport`, `locale`, `timezone`, `timeoutMs`, `collect`. Returns `sessionId`, the first page and `nextCommandId`. The URL is the first navigation, not an allowlist.
- `browser.observe`: bounded controls with context and validation. `query` and `scope` narrow; `mode: "records"` with `recordShape` (`controls`, `links`, `table`, `form`); `previousSnapshotId` returns a delta.
- `browser.document.read` / `browser.document.continue`: redacted text with an opaque cursor; snapshots expire after five minutes or when the document changes.
- `browser.act`: `{ sessionId, command: { commandId, action } }`. Actions: `navigate`, `back`, `forward`, `reload`, `click`, `click_at`, `fill`, `type`, `clear`, `edit`, `select`, `press`, `scroll`, `hover`, `wait_for`, `set_files`, `resize`, `dialog_accept`, `dialog_dismiss`, `sequence`. Targets: `ref`, `selector` or `semantic`.
- Receipt: `reason`, `dispatch`, `postcondition`, optional `observation` (including `navigation`, `newPages`, `cover`), `pageRestarted` after a renderer hang, and `nextCommandId`.
- `browser.command`: get or cancel a command without waiting behind input.
- `browser.screenshot`: bounded PNG, `fullPage` or `clip`, masked password and sensitive-autocomplete fields plus optional `sensitiveZones`.
- `browser.console` / `browser.network`: opt-in records (enabling them is visible to pages); network keeps no headers; bodies only as bounded text from the page's own origin.
- `browser.pages.list` / `browser.page.select`: session pages; popups never change the selected page.
- `browser.sessions.list`, `browser.session.stop`.
- `browser.existing.discover` / `browser.existing.setup`: only when the operator asks to use their own browser.

Errors carry a stable `errorCode`; `invalid_arguments` also names the `field` and what it `expected`.
