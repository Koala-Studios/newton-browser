# Newton Browser Driver

Strict TypeScript browser-control runtime for the direct owned-browser host.

See the [2026-09-07 adversarial audit](../../docs/ADVERSARIAL_AUDIT_2026-09-07.md) for
current input, wait, observation, ref and timeout defects. Strict compilation proves type
conformance, not that the browser performed the requested application action.

## Primary modules

- `driver`: CDP observe, screenshot, action, input, dialog, and target logic.
- `direct-session-runtime`: composes a direct debugger port, command pump, initial HTTP(S)
  navigation, and deterministic cleanup for one owned browser target.
- `direct-debugger-port`: maps private browser-level CDP transport to the driver contract.
- `raster-mask`: bounded trusted post-capture PNG redaction for sensitive zones.
- `target-registry`: bounded target/frame/session/ref topology for same-process frames,
  workers, and nested OOPIFs.

The package publishes only `@newton-browser/driver/direct-session-runtime`; the remaining
modules are implementation details of that strict composition.

## Boundary

The driver must not own MCP framing, browser process creation, identity storage, network
proxying, application routes, model calls, or provider credentials. It receives explicit
private-CDP ports. Production TypeScript
must compile strictly and emitted artifacts must remain deterministic and source-free.
