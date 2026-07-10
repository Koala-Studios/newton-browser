# Newton Browser Core

Shared contracts, action schema, redaction helpers, host policy, and safety floor for Newton Browser.

This package is intentionally platform-neutral. It does not know how commands are transported or which browser extension loads the runtime.

## Exports

- `protocol.ts`: typed browser actions, results, and transport mode contracts.
- `action-schema.ts`: single source of truth for accepted browser action fields.
- `risk.ts`: deterministic safety floor.
- `redaction.ts` and `text-redaction.ts`: browser-control redaction helpers.
- `transport.ts`: low-level bridge transport contract.

## Boundary

The core package must stay free of app imports, database code, secrets, browser extension globals, and server assumptions. Platform-specific behavior belongs in adapters above this package.
