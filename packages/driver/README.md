# Newton Browser Driver

Browser-side runtime and Chrome DevTools Protocol driver for Newton Browser.

## Exports

- `driver`: CDP-backed observe, screenshot, action, and target-resolution logic.
- `controller`: transport-injected session runtime.
- `chrome-tabs-port`: Chrome extension tab/debugger adapter for the runtime.

## Boundary

This package assumes a browser extension environment only at the port/driver edge. The controller is transport-injected and can be tested with fake ports. Keep app-specific labels, API routes, packet logic, and server concerns outside this package.
