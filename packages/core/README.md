# Newton Browser Core

Shared contracts, action schema, redaction helpers, host policy, and safety floor for Newton Browser.

This package is intentionally platform-neutral. Browser process ownership and private-CDP
transport details live above it in the direct runtime.

## Exports

- `protocol.ts`: typed browser actions and results.
- `action-schema.ts`: single source of truth for accepted browser action fields.
- `risk.ts`: deterministic safety floor.
- `redaction.ts` and `text-redaction.ts`: browser-control redaction helpers.
- `transport.ts`: low-level host/session transport contracts.

## Boundary

The core package must stay free of app imports, database code, secrets, browser globals,
process ownership, and server assumptions. Platform-specific behavior belongs in adapters
above this package.
