# Newton Browser Driver

Strict TypeScript browser-control runtime for the direct owned-browser host.

## Primary exports

- `driver`: CDP observe, screenshot, action, containment, input, dialog, and target logic.
- `direct-session-runtime`: composes a direct debugger port, page-effects port, command
  pump, exact origin grants, and deterministic cleanup for one owned browser target.
- `direct-debugger-port`: maps private browser-level CDP transport to the driver contract.
- `direct-page-effects`: non-security cosmetic effects for direct sessions.
- `raster-mask`: bounded trusted post-capture PNG redaction for sensitive zones.
- `target-registry`: bounded target/frame/session/ref topology for same-process frames,
  workers, and nested OOPIFs.

## Boundary

The driver must not own MCP framing, browser process creation, identity storage, proxy
listeners, application routes, model calls, or provider credentials. It receives explicit
private-CDP and page-effect ports. Production TypeScript
must compile strictly and emitted artifacts must remain deterministic and source-free.
