# Newton Browser tool reference

`tools/list` is authoritative; this summarizes the engine contract.

- `browser.session.start`: `url` (complete HTTP(S) URL), optional `loginSource`, `viewport`, `locale`, `timezone`, `timeoutMs`, `collect`. Returns `sessionId`, the first page and `nextCommandId`. The URL is the first navigation, not an allowlist.
- `browser.observe`: bounded controls with context and validation. `query` and `scope` narrow; `mode: "records"` with `recordShape` (`controls`, `links`, `table`, `form`); `previousSnapshotId` returns a delta.
- `browser.document.read` / `browser.document.continue`: redacted text with an opaque cursor; snapshots expire after five minutes or when the document changes.
- `browser.act`: `{ sessionId, command: { commandId, action } }`. Actions: `navigate`, `back`, `forward`, `reload`, `click`, `click_at`, `fill`, `type`, `clear`, `edit`, `select`, `press`, `scroll`, `hover`, `drag`, `wait_for`, `set_files`, `resize`, `dialog_accept`, `dialog_dismiss`, `sequence`. Targets: `ref`, `selector` or `semantic`. A wait names its element with the same `target` and an optional `state`: `attached`, `detached`, `visible`, `hidden`, `enabled`, `disabled`, `checked`, `unchecked`, or `value` with `value`; or it waits for `url` (`*` matches anything), `title` or `text`. `wait_for` carries these itself: `{ kind: "wait_for", target: { kind: "ref", ref: "e3" }, state: "enabled" }`; `click`, `hover`, `drag` and `click_at` take them as `waitFor`. `drag` presses on `target` and drops on `to` (`{ kind: "drag", target: {...}, to: {...} }`); it covers HTML5 drag and drop and mouse-driven drags. `dialog_accept`/`dialog_dismiss` without `dialogId` answer the page's one open dialog. A command without `timeoutMs` gets 10000 plus the `timeoutMs` of its waits. Near-miss shapes are accepted and the result lists each rewrite under `normalized`. Example: `{ kind: "wait_for", waitFor: { target: { kind: "ref", ref: "e3" }, state: "enabled" } }`.
- Receipt: `reason`, `dispatch`, `postcondition`, optional `observation` (including `navigation`, `newPages`, `cover`), `pageRestarted` after a renderer hang, and `nextCommandId`.
- `browser.command`: get or cancel a command without waiting behind input.
- `browser.screenshot`: bounded PNG, `fullPage` or `clip`, masked password and sensitive-autocomplete fields plus optional `sensitiveZones`.
- `browser.console` / `browser.network`: opt-in records (enabling them is visible to pages); network keeps no headers; bodies only as bounded text from the page's own origin.
- `browser.pages.list` / `browser.page.select`: session pages; popups never change the selected page.
- `browser.sessions.list`, `browser.session.stop`.
- `browser.existing.discover` / `browser.existing.setup`: only when the operator asks to use their own browser.

Errors carry a stable `errorCode`; `invalid_arguments` also names the `field` and what it `expected`.
