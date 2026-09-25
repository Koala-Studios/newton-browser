# Newton Browser Driver

The session engine behind every Newton Browser session: one command queue, page and ref authority, typed actions, observations and cleanup over a private CDP connection.

## Modules

- `session-engine`: per-session command queue (`CommandContext`, `CommandStore`), receipts, reconcile and independent `stop()`.
- `page-executor`: page, frame and ref resolution, typed actions (including uploads, dialogs, hover and resize), observations, screenshots and renderer-hang recovery.
- `page-directory` and `target-resolver`: page and ref ownership.
- `session-live`: frames, operator input and pause/resume for a person watching or taking control.
- `session-diagnostics`: console and network records, collected only when asked for.
- `raster-mask`: bounded trusted post-capture PNG redaction for sensitive zones.

Package exports: `session-engine`, `page-executor`, `connection`, `session-live`.

## Boundary

The driver must not own MCP framing, browser process creation, identity storage, network proxying, application routes, model calls, or provider credentials. It receives an explicit private-CDP connection. Production TypeScript must compile strictly and emitted artifacts must remain deterministic and source-free.
